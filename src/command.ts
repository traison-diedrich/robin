import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { modelName, sidekickStatusText, THINKING_LEVELS, type SidekickPin } from "./config.ts";
import { pickSearch, type PickerItem } from "./picker.ts";
import type { NestedSessions } from "./sessions.ts";

function uniqueModels(models: Array<{ provider: string; id: string; name?: string }>): PickerItem[] {
  const items: PickerItem[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const value = modelName(model);
    if (seen.has(value)) continue;
    seen.add(value);
    items.push({
      value,
      label: model.id,
      description: model.provider,
      search: `${model.provider} ${model.id} ${model.name ?? ""}`,
    });
  }
  return items;
}

function updateStatus(ctx: ExtensionContext, store: NestedSessions): void {
  const text = sidekickStatusText(store.pin);
  const columns = Number.isFinite(process.stdout.columns) ? Math.max(0, process.stdout.columns) : 0;
  // Leading braille blanks survive footer trimming; other extension statuses may follow Robin and use extra width.
  const padding = Math.min(10_000, Math.max(0, columns - visibleWidth(text)));
  ctx.ui.setStatus("robin", `${"\u2800".repeat(padding)}${ctx.ui.theme.fg("dim", text)}`);
}

export function registerSidekickCommand(pi: ExtensionAPI, store: NestedSessions): void {
  let currentContext: ExtensionContext | undefined;
  const refreshStatus = (): void => {
    if (currentContext) updateStatus(currentContext, store);
  };
  pi.on("session_start", (_event, ctx) => {
    process.stdout.off("resize", refreshStatus);
    currentContext = ctx;
    process.stdout.on("resize", refreshStatus);
    refreshStatus();
  });
  pi.on("session_shutdown", () => {
    process.stdout.off("resize", refreshStatus);
    currentContext = undefined;
  });

  const handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] = async (_args, ctx) => {
    try {
      const allItems = uniqueModels(ctx.modelRegistry.getAvailable());
      const scopedItems = uniqueModels(ctx.scopedModels.map((item) => item.model));
      const items = allItems.length ? allItems : scopedItems;
      if (!items.length) throw new Error("No authenticated models are available");

      const stored = store.pin;
      const selectedName = await pickSearch(ctx, {
        title: "Sidekick model",
        items,
        scopedItems: scopedItems.length ? scopedItems : undefined,
        currentValue: stored?.model,
      });
      if (!selectedName) return;

      const selectedModel =
        ctx.modelRegistry.getAvailable().find((model) => modelName(model) === selectedName) ??
        ctx.scopedModels.map((item) => item.model).find((model) => modelName(model) === selectedName);
      if (!selectedModel) throw new Error(`Sidekick model is unavailable: ${selectedName}`);
      const levels = getSupportedThinkingLevels(selectedModel);
      const thinkingOptions = [...(levels.length ? levels : THINKING_LEVELS)];
      const thinkingChoice = await pickSearch(ctx, {
        title: "Sidekick thinking",
        items: thinkingOptions.map((level) => ({ value: level, label: level, search: level })),
        currentValue: stored?.thinking,
      });
      if (!thinkingChoice) return;

      const pin = { model: selectedName, thinking: thinkingChoice as ModelThinkingLevel };
      await store.setPin(pin);
      updateStatus(ctx, store);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const options = {
    description: "Set the sidekick model and thinking level",
    handler,
  };
  pi.registerCommand("robin", options);
  pi.registerCommand("sidekick", options);
}
