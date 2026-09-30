import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NestedSessions } from "./sessions.ts";
import { formatTokens } from "./sidekick-display.ts";

const USAGE_ENTRY = "robin-sidekick-usage";
type UsageData = { callId: string; rootCallId: string; usage: Usage; reportedToParent?: boolean };
type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
const empty = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
function add(target: Totals, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
}
function isUsage(value: unknown): value is Usage {
  return typeof value === "object" && value !== null && "input" in value && "cost" in value;
}
export function cacheHitRate(usage: Pick<Totals, "input" | "cacheRead" | "cacheWrite">): number {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt ? usage.cacheRead / prompt : 0;
}
function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}
function totalsFrom(ctx: ExtensionContext): { main: Totals; sidekick: Totals } {
  const main = empty();
  const sidekick = empty();
  const persisted = new Map<string, UsageData>();
  const parentResults = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === USAGE_ENTRY) {
      const data = entry.data as UsageData;
      if (data && typeof data.callId === "string" && typeof data.rootCallId === "string" && isUsage(data.usage)) {
        persisted.set(data.callId, data);
      }
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      parentResults.add(entry.message.toolCallId);
      if (entry.message.usage) add(main, entry.message.usage);
    } else if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
      add(main, entry.message.usage);
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      add(main, entry.usage);
    }
  }
  const reconciled = empty();
  for (const record of persisted.values()) {
    add(sidekick, record.usage);
    if (record.reportedToParent !== false && parentResults.has(record.rootCallId)) add(reconciled, record.usage);
  }
  main.input = Math.max(0, main.input - reconciled.input);
  main.output = Math.max(0, main.output - reconciled.output);
  main.cacheRead = Math.max(0, main.cacheRead - reconciled.cacheRead);
  main.cacheWrite = Math.max(0, main.cacheWrite - reconciled.cacheWrite);
  main.cost = Math.max(0, main.cost - reconciled.cost);
  return { main, sidekick };
}

export function registerFooter(pi: ExtensionAPI, store: NestedSessions): void {
  let context: ExtensionContext | undefined;
  let sidekickModel: { model: string; thinking?: string } | undefined;
  let requestRender: (() => void) | undefined;
  const active = new Map<string, Usage>();
  const parents = new Map<string, string | undefined>();
  pi.on("session_start", (_event, ctx) => {
    requestRender = undefined;
    active.clear();
    parents.clear();
    sidekickModel = undefined;
    context = ctx;
    store.setPinChangeHandler(() => {
      sidekickModel = undefined;
      requestRender?.();
    });
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => requestRender?.());
      return {
        dispose() {
          unsubscribe();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const current = context;
          if (!current || width <= 0) return [];
          const { main, sidekick } = totalsFrom(current);
          for (const usage of active.values()) add(sidekick, usage);

          const latestAssistant = current.sessionManager.getEntries().filter((entry) =>
            entry.type === "message" && entry.message.role === "assistant",
          ).at(-1);
          const latestUsage = latestAssistant?.type === "message" ? (latestAssistant.message as AssistantMessage).usage : undefined;
          const mainStats = [`↑${formatTokens(main.input)}`, `↓${formatTokens(main.output)}`, `R${formatTokens(main.cacheRead)}`, `W${formatTokens(main.cacheWrite)}`];
          if (main.cacheRead + main.cacheWrite > 0 && latestUsage) {
            const rate = cacheHitRate(latestUsage);
            mainStats.push(`CH${(100 * rate).toFixed(1)}%`);
          }
          mainStats.push(`$${main.cost.toFixed(3)}`);
          const contextUsage = current.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? current.model?.contextWindow ?? 0;
          const contextDisplay = `${contextUsage?.percent != null ? `${contextUsage.percent.toFixed(1)}%` : "?"}/${formatTokens(contextWindow)}`;
          const contextPercent = contextUsage?.percent ?? 0;
          mainStats.push(contextPercent > 90 ? theme.fg("error", contextDisplay) : contextPercent > 70 ? theme.fg("warning", contextDisplay) : contextDisplay);
          const model = current.model?.id ?? "no-model";
          const mainModel = current.model?.reasoning ? `${model} • ${current.thinkingLevel ?? "off"}` : model;
          let mainRight = mainModel;
          if (current.model && footerData.getAvailableProviderCount() > 1) {
            const withProvider = `(${current.model.provider}) ${mainModel}`;
            if (visibleWidth(mainStats.join(" ")) + 2 + visibleWidth(withProvider) <= width) mainRight = withProvider;
          }
          const sideStats = [`↑${formatTokens(sidekick.input)}`, `↓${formatTokens(sidekick.output)}`, `R${formatTokens(sidekick.cacheRead)}`, `W${formatTokens(sidekick.cacheWrite)}`, `CH${(100 * cacheHitRate(sidekick)).toFixed(1)}%`, `$${sidekick.cost.toFixed(3)}`];
          const line = (left: string, right: string): string => {
            let lhs = theme.fg("dim", left);
            let leftWidth = visibleWidth(lhs);
            if (leftWidth > width) {
              lhs = truncateToWidth(lhs, width);
              leftWidth = visibleWidth(lhs);
            }
            const availableForRight = width - leftWidth - 2;
            if (availableForRight <= 0) return lhs;
            const rhs = truncateToWidth(theme.fg("dim", right), availableForRight);
            const rightWidth = visibleWidth(rhs);
            return lhs + " ".repeat(Math.max(2, width - leftWidth - rightWidth)) + rhs;
          };
          let cwd = current.cwd;
          if (process.env.HOME && (cwd === process.env.HOME || cwd.startsWith(`${process.env.HOME}/`))) cwd = `~${cwd.slice(process.env.HOME.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) cwd += ` (${branch})`;
          const sessionName = current.sessionManager.getSessionName();
          if (sessionName) cwd += ` • ${sessionName}`;
          const selectedSideModel = sidekickModel ?? store.pin;
          let sideModel = "sidekick";
          if (selectedSideModel) {
            const separator = selectedSideModel.model.indexOf("/");
            const provider = separator >= 0 ? selectedSideModel.model.slice(0, separator) : undefined;
            const modelId = separator >= 0 ? selectedSideModel.model.slice(separator + 1) : selectedSideModel.model;
            const modelText = `${modelId}${selectedSideModel.thinking ? ` • ${selectedSideModel.thinking}` : ""}`;
            sideModel = modelText;
            const withProvider = provider ? `(${provider}) ${modelText}` : undefined;
            if (withProvider && footerData.getAvailableProviderCount() > 1 && visibleWidth(sideStats.join(" ")) + 2 + visibleWidth(withProvider) <= width) {
              sideModel = withProvider;
            }
          }
          const status = [...footerData.getExtensionStatuses().entries()]
            .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => sanitizeStatus(value)).filter(Boolean).join(" ");
          return [
            truncateToWidth(theme.fg("dim", cwd), width),
            line(mainStats.join(" "), mainRight),
            line(sideStats.join(" "), sideModel),
            ...(status ? [truncateToWidth(status, width)] : []),
          ];
        },
      };
    });
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    active.clear();
    parents.clear();
    requestRender = undefined;
    store.setPinChangeHandler(undefined);
  });
  const trackParent = (event: { toolCallId: string; parentToolCallId?: string }) => {
    parents.set(event.toolCallId, event.parentToolCallId);
  };
  const rootCallId = (callId: string): string => {
    let current = callId;
    const visited = new Set<string>();
    while (parents.get(current) && !visited.has(current)) {
      visited.add(current);
      current = parents.get(current)!;
    }
    return current;
  };
  pi.on("tool_execution_start", trackParent);
  pi.on("tool_execution_update", (event) => {
    if (!context) return;
    trackParent(event);
    if (event.toolName !== "sidekick") return;
    const details = event.partialResult?.details;
    if (isUsage(details?.usage)) active.set(event.toolCallId, details.usage);
    if (details?.model) sidekickModel = { model: details.model, thinking: details.thinking };
    requestRender?.();
  });
  pi.on("tool_execution_end", (event) => {
    if (!context) return;
    trackParent(event);
    if (event.toolName !== "sidekick") return;
    const details = event.result?.details;
    const usage = details?.usage ?? event.result?.usage;
    active.delete(event.toolCallId);
    if (isUsage(usage) && context) {
      pi.appendEntry(USAGE_ENTRY, {
        callId: event.toolCallId,
        rootCallId: rootCallId(event.toolCallId),
        usage,
        reportedToParent: isUsage(event.result?.usage),
      });
    }
    if (details?.model) sidekickModel = { model: details.model, thinking: details.thinking };
    requestRender?.();
  });
}
