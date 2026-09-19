import * as fs from "node:fs";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseModelName, readSidekickPin } from "./config.ts";

export const MAX_LIVE_SESSIONS = 2;
export const SIDEKICK_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

const SIDEKICK_PROMPT = fs.readFileSync(new URL("./sidekick.md", import.meta.url), "utf8").trim();

function safeDispose(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    // Already closed during parent shutdown.
  }
}

async function findSessionPath(cwd: string, sessionId: string): Promise<string | undefined> {
  const sessions = await SessionManager.list(cwd);
  const matches = sessions.filter((session) => session.id === sessionId);
  if (matches.length !== 1) return undefined;
  return matches[0]?.path;
}

export class NestedSessions {
  private readonly live = new Map<string, AgentSession>();
  private runtime: ModelRuntime | undefined;

  private async getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= await ModelRuntime.create();
    return this.runtime;
  }

  private drop(sessionId: string): void {
    const session = this.live.get(sessionId);
    if (!session) return;
    safeDispose(session);
    this.live.delete(sessionId);
  }

  private remember(sessionId: string, session: AgentSession): void {
    const existing = this.live.get(sessionId);
    if (existing && existing !== session) safeDispose(existing);
    this.live.delete(sessionId);
    this.live.set(sessionId, session);
    while (this.live.size > MAX_LIVE_SESSIONS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined || oldest === sessionId) break;
      this.drop(oldest);
    }
  }

  disposeAll(): void {
    for (const sessionId of [...this.live.keys()]) this.drop(sessionId);
    this.runtime = undefined;
  }

  private async sidekickModel(): Promise<{ model: Model<any>; thinking: ModelThinkingLevel }> {
    const pin = readSidekickPin();
    if (!pin) throw new Error("Sidekick is not configured. Run /robin or /sidekick.");
    const runtime = await this.getRuntime();
    const parsed = parseModelName(pin.model);
    const model = parsed && runtime.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error(`Sidekick model is unavailable: ${pin.model}. Run /robin or /sidekick.`);
    return { model, thinking: pin.thinking };
  }

  private async startSession(
    ctx: ExtensionContext,
    model: Model<any>,
    thinking: ModelThinkingLevel,
    file?: string,
  ): Promise<AgentSession> {
    const runtime = await this.getRuntime();
    const parentSession = ctx.sessionManager.getSessionFile();
    const manager = file
      ? SessionManager.open(file, undefined, ctx.cwd)
      : SessionManager.create(ctx.cwd, undefined, parentSession ? { parentSession } : undefined);
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [SIDEKICK_PROMPT],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: ctx.cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: thinking,
      resourceLoader: loader,
      sessionManager: manager,
      tools: [...SIDEKICK_TOOLS],
    });
    return created.session;
  }

  async acquire(ctx: ExtensionContext, taskId?: string): Promise<AgentSession> {
    const { model, thinking } = await this.sidekickModel();

    if (!taskId) {
      const session = await this.startSession(ctx, model, thinking);
      this.remember(session.sessionId, session);
      return session;
    }

    if (taskId === ctx.sessionManager.getSessionId()) {
      throw new Error(`Unknown session id "${taskId}". Call sidekick without taskId to create a session.`);
    }

    const live = this.live.get(taskId);
    if (live) {
      const current = live.model;
      if (!current || current.provider !== model.provider || current.id !== model.id) {
        await live.setModel(model);
      }
      if (live.thinkingLevel !== thinking) {
        live.setThinkingLevel(thinking);
      }
      this.remember(taskId, live);
      return live;
    }

    const file = await findSessionPath(ctx.cwd, taskId);
    if (!file) {
      throw new Error(`Unknown session id "${taskId}". Call sidekick without taskId to create a session.`);
    }

    const opened = await this.startSession(ctx, model, thinking, file);
    if (opened.sessionId !== taskId) {
      safeDispose(opened);
      throw new Error(`Unknown session id "${taskId}". Call sidekick without taskId to create a session.`);
    }
    this.remember(taskId, opened);
    return opened;
  }
}
