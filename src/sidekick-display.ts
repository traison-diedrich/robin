import type { Theme } from "@earendil-works/pi-coding-agent";

export type AgentStatus = "working" | "completed" | "failed";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const TITLE_WORDS = 8;

export function eightWords(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(" ");
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function renderModelLine(theme: Theme, model: string, thinking: string): string {
  const separator = model.indexOf("/");
  const provider = separator >= 0 ? model.slice(0, separator) : model || "unset";
  const modelId = separator >= 0 ? model.slice(separator + 1) : model || "unset";
  return theme.fg("muted", `(${provider}) `) + theme.fg("accent", `${modelId} • ${thinking}`);
}

export function renderUsage(theme: Theme, cost: number, percent: number | null, contextWindow: number): string {
  const costText = theme.fg("muted", `$${cost.toFixed(3)}`);
  const windowText = contextWindow > 0 ? formatTokens(contextWindow) : "?";
  const percentText = percent === null ? `?/${windowText}` : `${percent.toFixed(1)}%/${windowText}`;
  const color = percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "muted";
  return `${costText}  ${theme.fg(color, percentText)}`;
}

export function renderAgentIndicator(theme: Theme, status: AgentStatus, spinnerFrame: number): string {
  if (status === "working") {
    return theme.fg("accent", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]);
  }
  return status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

export function oneLineError(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
