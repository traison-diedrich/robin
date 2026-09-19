import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  modelName,
  saveSidekickPin,
  sidekickStatusText,
  THINKING_LEVELS,
  tryReadSidekickPin,
  type SidekickPin,
} from "./config.ts";
import { pickSearch, type PickerItem } from "./picker.ts";

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

function announce(ctx: ExtensionContext, pin: SidekickPin | undefined): void {
  ctx.ui.notify(sidekickStatusText(pin));
}

export function registerSidekickCommand(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "new" && event.reason !== "startup") return;
    const pin = tryReadSidekickPin();
    // Pi appends its own chat line after this event. Wait one tick so this
    // uses the same overwriteable notify line as /robin and /sidekick.
    setTimeout(() => announce(ctx, pin), 0);
  });

  const handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] = async (_args, ctx) => {
    try {
      const allItems = uniqueModels(ctx.modelRegistry.getAvailable());
      const scopedItems = uniqueModels(ctx.scopedModels.map((item) => item.model));
      const items = allItems.length ? allItems : scopedItems;
      if (!items.length) throw new Error("No authenticated models are available");

      const stored = tryReadSidekickPin();
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
      await saveSidekickPin(pin);
      announce(ctx, pin);
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
