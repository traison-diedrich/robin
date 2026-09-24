import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
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
import { parseModelName, saveSidekickPin, tryReadSidekickPin, type SidekickPin } from "./config.ts";

export const MAX_LIVE_SESSIONS = 2;

const SIDEKICK_PROMPT = fs.readFileSync(new URL("./sidekick.md", import.meta.url), "utf8").trim();
const ROBIN_EXTENSION_PATH = fs.realpathSync(fileURLToPath(new URL("../index.ts", import.meta.url)));

function safeDispose(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    // Already closed during parent shutdown.
  }
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionId(taskId: string): boolean {
  return SESSION_ID.test(taskId);
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
  pin: SidekickPin | undefined = tryReadSidekickPin();

  async setPin(pin: SidekickPin): Promise<void> {
    await saveSidekickPin(pin);
    this.pin = pin;
  }

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

  private unknownSessionError(taskId: string, reason = "Unknown"): Error {
    const live = [...this.live.keys()];
    const liveText = live.length > 0 ? ` Live sessions: ${live.join(", ")}.` : "";
    return new Error(
      `${reason} session id "${taskId}".${liveText} Call sidekick without taskId to create a session.`,
    );
  }

  private async sidekickModel(): Promise<{ model: Model<any>; thinking: ModelThinkingLevel }> {
    const pin = this.pin;
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
      noPromptTemplates: true,
      noThemes: true,
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) => {
          try {
            return fs.realpathSync(extension.resolvedPath) !== ROBIN_EXTENSION_PATH;
          } catch {
            return true;
          }
        }),
      }),
      appendSystemPrompt: [SIDEKICK_PROMPT],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: ctx.cwd,
      modelRuntime: runtime,
      model,
      thinkingLevel: thinking,
      excludeTools: ["sidekick"],
      resourceLoader: loader,
      sessionManager: manager,
    });
    try {
      await created.session.bindExtensions({ mode: "print" });
    } catch (error) {
      safeDispose(created.session);
      throw error;
    }
    return created.session;
  }

  async acquire(ctx: ExtensionContext, taskId?: string): Promise<AgentSession> {
    const { model, thinking } = await this.sidekickModel();

    if (!taskId) {
      const session = await this.startSession(ctx, model, thinking);
      this.remember(session.sessionId, session);
      return session;
    }

    if (!isSessionId(taskId)) {
      throw this.unknownSessionError(taskId, "Invalid");
    }

    if (taskId === ctx.sessionManager.getSessionId()) {
      throw this.unknownSessionError(taskId);
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
      throw this.unknownSessionError(taskId);
    }

    const opened = await this.startSession(ctx, model, thinking, file);
    if (opened.sessionId !== taskId) {
      safeDispose(opened);
      throw this.unknownSessionError(taskId);
    }
    this.remember(taskId, opened);
    return opened;
  }
}
