import { DynamicBorder, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

export interface PickerItem {
  value: string;
  label: string;
  search: string;
  description?: string;
}

export interface PickSearchOptions {
  title: string;
  items: PickerItem[];
  scopedItems?: PickerItem[];
  currentValue?: string;
}

class SidekickPicker extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly list = new Container();
  private readonly scopeText: Text | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly kb: KeybindingsManager;
  private readonly allItems: PickerItem[];
  private readonly scopedItems: PickerItem[];
  private readonly currentValue: string | undefined;
  private readonly onSelect: (value: string) => void;
  private readonly onCancel: () => void;
  private active: PickerItem[];
  private filtered: PickerItem[] = [];
  private selectedIndex = 0;
  private scope: "scoped" | "all";
  private closed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    kb: KeybindingsManager,
    options: PickSearchOptions,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.kb = kb;
    this.allItems = options.items;
    this.scopedItems = options.scopedItems ?? [];
    this.currentValue = options.currentValue;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.scope = this.scopedItems.length > 0 ? "scoped" : "all";
    this.active = this.scope === "scoped" ? this.scopedItems : this.allItems;

    this.addChild(new DynamicBorder((value) => theme.fg("borderAccent", value)));
    if (this.scopedItems.length > 0) {
      this.scopeText = new Text(this.scopeLine(), 1, 0);
      this.addChild(this.scopeText);
    } else {
      this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
    }
    this.addChild(new Spacer(1));
    this.searchInput.onSubmit = () => this.confirm();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    this.addChild(new DynamicBorder((value) => theme.fg("borderAccent", value)));
    this.filter("");
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.kb.matches(data, "tui.input.tab")) {
      this.toggleScope();
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
      this.updateList();
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      this.tui.requestRender();
      return;
    }
    if (this.kb.matches(data, "tui.select.confirm")) {
      this.confirm();
      return;
    }
    if (this.kb.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.onCancel();
      return;
    }
    this.searchInput.handleInput(data);
    this.filter(this.searchInput.getValue());
    this.tui.requestRender();
  }

  private scopeLine(): string {
    const allText = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
    const scopedText = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
    return `${this.theme.fg("muted", "Scope: ")}${allText}${this.theme.fg("muted", " | ")}${scopedText}${this.theme.fg("muted", " (tab)")}`;
  }

  private toggleScope(): void {
    if (this.scopedItems.length === 0) return;
    this.scope = this.scope === "all" ? "scoped" : "all";
    this.active = this.scope === "scoped" ? this.scopedItems : this.allItems;
    if (this.scopeText) this.scopeText.setText(this.scopeLine());
    this.filter(this.searchInput.getValue());
  }

  private filter(query: string): void {
    this.filtered = query ? fuzzyFilter(this.active, query, (item) => item.search) : this.active;
    if (query) {
      this.selectedIndex = 0;
    } else {
      const currentIndex = this.filtered.findIndex((item) => item.value === this.currentValue);
      this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
    }
    this.updateList();
  }

  private updateList(): void {
    this.list.clear();
    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("warning", "  No matching items"), 0, 0));
      return;
    }
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);
    for (let index = startIndex; index < endIndex; index++) {
      const item = this.filtered[index];
      if (!item) continue;
      const selected = index === this.selectedIndex;
      const current = item.value === this.currentValue;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = selected ? this.theme.fg("accent", item.label) : item.label;
      const description = item.description ? this.theme.fg("muted", ` [${item.description}]`) : "";
      const mark = current ? this.theme.fg("success", " ✓") : "";
      this.list.addChild(new Text(`${prefix}${label}${description}${mark}`, 0, 0));
    }
  }

  private confirm(): void {
    const item = this.filtered[this.selectedIndex];
    if (!item) return;
    this.closed = true;
    this.onSelect(item.value);
  }
}

export async function pickSearch(ctx: ExtensionCommandContext, options: PickSearchOptions): Promise<string | undefined> {
  if (ctx.mode !== "tui") return undefined;
  if (options.items.length === 0) throw new Error("No items to pick");
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    return new SidekickPicker(tui, theme, keybindings, options, (value) => done(value), () => done(undefined));
  });
}
