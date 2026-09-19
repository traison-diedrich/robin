import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SidekickPin {
  model: string;
  thinking: ModelThinkingLevel;
}

export const THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
const CONFIG_PATH = path.join(getAgentDir(), "robin", "config.json");

export function modelName(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function parseModelName(name: string): { provider: string; id: string } | undefined {
  const separator = name.indexOf("/");
  if (separator <= 0 || separator === name.length - 1) return undefined;
  return { provider: name.slice(0, separator), id: name.slice(separator + 1) };
}

function parsePin(value: unknown): SidekickPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.model !== "string" || !parseModelName(fields.model)) {
    throw new Error("invalid sidekick model");
  }
  if (typeof fields.thinking !== "string" || !THINKING_LEVEL_SET.has(fields.thinking as ModelThinkingLevel)) {
    throw new Error("invalid sidekick thinking level");
  }
  return { model: fields.model, thinking: fields.thinking as ModelThinkingLevel };
}

export function readSidekickPin(): SidekickPin | undefined {
  if (!fs.existsSync(CONFIG_PATH)) return undefined;
  try {
    return parsePin(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${CONFIG_PATH}: ${message}`);
  }
}

export function tryReadSidekickPin(): SidekickPin | undefined {
  try {
    return readSidekickPin();
  } catch {
    return undefined;
  }
}

export async function saveSidekickPin(pin: SidekickPin): Promise<void> {
  await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.promises.writeFile(CONFIG_PATH, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
}

export function sidekickStatusText(pin: SidekickPin | undefined): string {
  if (!pin) return "Sidekick is not configured. Run /robin or /sidekick.";
  const parsed = parseModelName(pin.model);
  const provider = parsed?.provider ?? pin.model;
  const id = parsed?.id ?? pin.model;
  return `Sidekick: (${provider}) ${id} • ${pin.thinking}`;
}
