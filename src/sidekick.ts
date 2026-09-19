import * as fs from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, Usage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { tryReadSidekickPin } from "./config.ts";
import {
  eightWords,
  formatDuration,
  oneLineError,
  renderAgentIndicator,
  renderModelLine,
  renderUsage,
  SPINNER_FRAMES,
} from "./sidekick-display.ts";
import { NestedSessions } from "./sessions.ts";

type SidekickStatus = "working" | "completed" | "failed";

type SidekickDetails = {
  taskId: string;
  summary: string;
  model: string;
  thinking: string;
  status: SidekickStatus;
  durationMs: number;
  spinnerFrame: number;
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
  error?: string;
};

const PARAMETERS = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: 200,
    description:
      "Exactly 8 complete words that summarize this task. A finished phrase. No file paths. No cut words. Not the brief.",
  }),
  brief: Type.String({
    minLength: 1,
    maxLength: 8000,
    description: "Success criteria, constraints, and optional path hints. Not the main transcript. Not the title.",
  }),
  taskId: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Existing Pi session id to continue. Omit to create a new session.",
    }),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageTime(message: unknown): number {
  return isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : 0;
}

function lastAssistantText(messages: readonly AgentMessage[], afterTimestamp: number): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (messageTime(message) <= afterTimestamp) continue;
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const assistant = message as AssistantMessage;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(assistant.errorMessage || `Sidekick ${assistant.stopReason}`);
    }
    const text = assistant.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function persistedTaskId(session: AgentSession | undefined, taskId: string): string {
  const file = session?.sessionFile;
  if (file && fs.existsSync(file) && taskId) return taskId;
  return "unknown";
}

function withTaskId(taskId: string, text: string): string {
  if (/^taskId:\s*\S+/m.test(text)) return text;
  return `taskId: ${taskId}\n${text}`;
}

function clipReport(taskId: string, text: string): string {
  const truncation = truncateHead(text);
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\nFull report: continue with taskId ${taskId}`;
}

function isUsage(value: unknown): value is Usage {
  return isRecord(value) && isRecord(value.cost) && typeof value.input === "number" && typeof value.cost.total === "number";
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheWrite1h:
      left.cacheWrite1h != null || right.cacheWrite1h != null
        ? (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0)
        : undefined,
    reasoning: left.reasoning != null || right.reasoning != null ? (left.reasoning ?? 0) + (right.reasoning ?? 0) : undefined,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function entryUsage(entry: unknown): Usage | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return isUsage(entry.usage) ? entry.usage : undefined;
  }
  if (entry.type === "message" && isRecord(entry.message)) {
    const role = entry.message.role;
    if ((role === "assistant" || role === "toolResult") && isUsage(entry.message.usage)) return entry.message.usage;
  }
  return undefined;
}

function usageSince(session: AgentSession | undefined, afterIndex: number): Usage | undefined {
  if (!session) return undefined;
  const entries = session.sessionManager.getEntries();
  let total: Usage | undefined;
  for (let index = afterIndex; index < entries.length; index++) {
    const usage = entryUsage(entries[index]);
    if (!usage) continue;
    total = total ? addUsage(total, usage) : usage;
  }
  return total;
}

function usageFrom(session: AgentSession | undefined): Pick<SidekickDetails, "cost" | "contextPercent" | "contextWindow"> {
  if (!session) return { cost: 0, contextPercent: null, contextWindow: 0 };
  const stats = session.getSessionStats();
  const usage = session.getContextUsage() ?? stats.contextUsage;
  return {
    cost: stats.cost,
    contextPercent: usage?.percent ?? null,
    contextWindow: usage?.contextWindow ?? 0,
  };
}

async function settle(session: AgentSession): Promise<void> {
  try {
    await session.waitForIdle();
  } catch {
    // Already disposed during parent shutdown.
  }
}

function modelLine(session: AgentSession | undefined): { model: string; thinking: string } {
  const pin = tryReadSidekickPin();
  const model = session?.model;
  return {
    model: model ? `${model.provider}/${model.id}` : pin?.model ?? "",
    thinking: session?.thinkingLevel ?? pin?.thinking ?? "",
  };
}

function renderSidekickResult(result: { details?: unknown }, theme: Theme): Container {
  const details = result.details as SidekickDetails | undefined;
  const box = new Container();
  if (!details) {
    box.addChild(new Text(theme.fg("muted", "Robin"), 0, 0));
    return box;
  }
  const line1 = `${renderAgentIndicator(theme, details.status, details.spinnerFrame)} ${theme.fg("toolTitle", theme.bold(details.summary))}  ${theme.fg("muted", formatDuration(details.durationMs))}`;
  box.addChild(new Text(line1, 0, 0));
  box.addChild(
    new Text(
      `  ${renderModelLine(theme, details.model, details.thinking)}  ${renderUsage(theme, details.cost, details.contextPercent, details.contextWindow)}`,
      0,
      0,
    ),
  );
  if (details.status === "failed" && details.error) {
    box.addChild(new Text(`  ${theme.fg("error", oneLineError(details.error))}`, 0, 0));
  }
  return box;
}

export function registerSidekick(pi: ExtensionAPI, store: NestedSessions): void {
  pi.on("session_start", () => {
    store.disposeAll();
  });
  pi.on("session_shutdown", () => {
    store.disposeAll();
  });

  async function run(
    params: Static<typeof PARAMETERS>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SidekickDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SidekickDetails>> {
    const summary = eightWords(params.title) || "Robin";
    const startedAt = Date.now();
    let taskId = params.taskId?.trim() || "";
    let spinnerFrame = 0;
    let session: AgentSession | undefined;
    let afterTimestamp = 0;
    let afterIndex = 0;
    let details: SidekickDetails = {
      taskId,
      summary,
      ...modelLine(undefined),
      status: "working",
      durationMs: 0,
      spinnerFrame,
      cost: 0,
      contextPercent: null,
      contextWindow: 0,
    };

    const update = (status: SidekickStatus, error?: string): void => {
      details = {
        ...details,
        taskId: taskId || details.taskId,
        ...modelLine(session),
        status,
        durationMs: Date.now() - startedAt,
        spinnerFrame,
        ...usageFrom(session),
        error,
      };
      onUpdate?.({ content: [{ type: "text", text: `${status} ${summary}` }], details });
    };

    update("working");
    const ticker = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      update(details.status, details.error);
    }, 120);

    try {
      const existingId = params.taskId?.trim() || undefined;
      session = await store.acquire(ctx, existingId);
      taskId = session.sessionId;
      afterTimestamp = messageTime(session.messages[session.messages.length - 1]);
      afterIndex = session.sessionManager.getEntries().length;
      update("working");

      if (signal?.aborted) throw new Error("Sidekick was aborted");

      const abort = (): void => {
        void session?.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const prompt = existingId ? params.brief.trim() : `taskId: ${taskId}\n\n${params.brief.trim()}`;
        await session.prompt(prompt, { expandPromptTemplates: false });
        if (signal?.aborted) throw new Error("Sidekick was aborted");
        const text =
          lastAssistantText(session.messages, afterTimestamp) ??
          "status: done\nnotes:\nNo final text from the sidekick.";
        const report = clipReport(taskId, withTaskId(taskId, text));
        update("completed");
        return {
          content: [{ type: "text", text: report }],
          details,
          usage: usageSince(session, afterIndex),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        await settle(session);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      taskId = persistedTaskId(session, taskId);
      const notes =
        taskId === "unknown"
          ? `${message}\nCall sidekick without taskId to create a session.`
          : message;
      update("failed", message);
      return {
        content: [{ type: "text", text: clipReport(taskId, `taskId: ${taskId}\nstatus: failed\nnotes:\n${notes}`) }],
        details,
        usage: usageSince(session, afterIndex),
      };
    } finally {
      clearInterval(ticker);
    }
  }

  pi.registerTool({
    name: "sidekick",
    label: "Robin",
    description: "Start or continue a nested Robin session and return a compact report.",
    promptSnippet: "Start or continue a nested Robin session",
    parameters: PARAMETERS,
    executionMode: "sequential",
    execute(_toolCallId, params: Static<typeof PARAMETERS>, signal, onUpdate, ctx) {
      return run(params, signal, onUpdate, ctx);
    },
    renderCall() {
      return new Container();
    },
    renderResult(result, _options, theme) {
      return renderSidekickResult(result, theme);
    },
  });
}
