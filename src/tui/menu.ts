import type { Key } from "./input.ts";
import { style } from "./theme.ts";
import { pad, spread, truncate, visibleWidth, wrap } from "./text.ts";

export interface MenuEntry {
  label: string;
  detail: string;
  /** Shown at the right edge, such as a category or `current`. */
  tag: string;
  /** The category tab the entry belongs to. */
  group: string;
  /** Informational rows, such as key bindings, cannot be chosen. */
  inert: boolean;
}

export interface MenuConfig {
  title: string;
  entries: MenuEntry[];
  initial: number;
  /** Shows a tab per group, cycled with tab. */
  tabs: boolean;
  /** Typing narrows the entries. */
  filter: boolean;
  /** What enter does, for the hint line. */
  action: string;
  /** fx's argument list: rows only, between rules, lined up under the word being completed. */
  bare: boolean;
}

export type MenuResult = { kind: "choose"; index: number } | { kind: "close" } | null;

const HINT_GAP = "     ";
/** Ctrl keys that move by pages, as in vim. */
const PAGE_KEYS: Record<string, number> = { d: 0.5, u: -0.5, f: 1, b: -1 };
const LABEL_LIMIT = 28;

export function entry(label: string, detail = "", options: Partial<MenuEntry> = {}): MenuEntry {
  return { label, detail, tag: "", group: "", inert: false, ...options };
}

/** The row step for keys that move in any list: arrows, and ctrl+j/k and ctrl+n/p as in fzf. */
export function lineStep(key: Key): number {
  if (key.name === "up" || (key.ctrl && (key.name === "k" || key.name === "p"))) return -1;
  if (key.name === "down" || (key.ctrl && (key.name === "j" || key.name === "n"))) return 1;
  return 0;
}

export function rule(width: number): string {
  return style.rule("─".repeat(Math.max(0, width)));
}

export function hints(parts: readonly string[], width: number): string {
  return truncate(style.muted(parts.join(HINT_GAP)), width);
}

/**
 * fx's footer panel: a ruled list with a counted title, optional category
 * tabs, the selected row in bold, and a hint line. Used for slash completion,
 * /help, and every picker.
 */
export class Menu {
  readonly config: MenuConfig;
  #entries: MenuEntry[];
  #tabs: string[];
  #tab = 0;
  #query = "";
  /** Index into the visible entries. */
  #index = 0;
  /** Entries the last render had room for, which sets a page. */
  #shown = 8;
  /** Where a bare list's rows start: the column of the word being completed. */
  indent = 0;

  constructor(config: Partial<MenuConfig> & Pick<MenuConfig, "title" | "entries">) {
    this.config = {
      initial: 0,
      tabs: false,
      filter: false,
      action: "use",
      bare: false,
      ...config,
    };
    this.#entries = this.config.entries;
    this.#tabs = this.config.tabs
      ? ["All", ...new Set(this.#entries.map((item) => item.group).filter(Boolean))]
      : [];
    this.#index = Math.max(
      0,
      this.#visible().findIndex(({ index }) => index === this.config.initial),
    );
    this.#skipInert(1);
  }

  /** Replaces the entries, keeping the selection on the same label when it remains. */
  setEntries(entries: MenuEntry[]): void {
    const label = this.selected()?.label;
    this.#entries = entries;
    this.select(label ?? "");
  }

  /** Selects the entry with this label, or the first when none has it. */
  select(label: string): void {
    const kept = this.#visible().findIndex(({ entry: item }) => item.label === label);
    this.#index = kept === -1 ? 0 : kept;
  }

  get count(): number {
    return this.#visible().length;
  }

  selected(): MenuEntry | undefined {
    return this.#visible()[this.#index]?.entry;
  }

  move(delta: number): void {
    const count = this.count;
    if (count === 0) return;
    this.#index = (this.#index + delta + count) % count;
    this.#skipInert(Math.sign(delta) || 1);
  }

  /**
   * Arrows, ctrl+j/k, and ctrl+n/p move in every menu. One without a filter
   * takes no typing, so it also takes vim keys: j/k, g/G, ctrl+d/u for half a
   * page, h/l for tabs, and q to close.
   */
  key(key: Key): MenuResult {
    const step = lineStep(key);
    if (step) {
      this.move(step);
      return null;
    }
    switch (key.name) {
      case "pageup":
      case "pagedown":
        this.#page(key.name === "pageup" ? -1 : 1);
        return null;
      case "home":
      case "end":
        this.#jump(key.name === "home" ? 0 : this.count - 1);
        return null;
      case "tab":
        this.#switchTab(key.shift ? -1 : 1);
        return null;
      case "escape":
        return { kind: "close" };
      case "return": {
        const chosen = this.#visible()[this.#index];
        if (!chosen || chosen.entry.inert) return null;
        return { kind: "choose", index: chosen.index };
      }
    }
    if (key.ctrl) {
      if (key.name === "c") return { kind: "close" };
      const pages = this.config.filter ? undefined : PAGE_KEYS[key.name];
      if (pages) this.#page(pages);
      return null;
    }
    if (key.meta) return null;
    if (!this.config.filter) {
      switch (key.text) {
        case "j":
        case "k":
          this.move(key.text === "j" ? 1 : -1);
          break;
        case "g":
        case "G":
          this.#jump(key.text === "g" ? 0 : this.count - 1);
          break;
        case "h":
        case "l":
          this.#switchTab(key.text === "l" ? 1 : -1);
          break;
        case "q":
          return { kind: "close" };
      }
      return null;
    }
    if (key.name === "backspace") this.#query = this.#query.slice(0, -1);
    else if (key.text !== "") this.#query += key.text;
    else return null;
    this.#index = 0;
    this.#skipInert(1);
    return null;
  }

  /** Rows for the panel, showing at most `maxRows` entries around the selection. */
  render(width: number, maxRows: number): string[] {
    if (this.config.bare) return this.#renderBare(width, maxRows);
    const visible = this.#visible();
    // Informational rows are not counted, unless they are all there is.
    const count = visible.filter(({ entry: item }) => !item.inert).length || visible.length;
    let title = style.bold(style.strong(`${this.config.title} ${count}`));
    for (const [index, name] of this.#tabs.entries()) {
      title += `  ${index === this.#tab ? style.bold(style.strong(`[${name}]`)) : style.muted(name)}`;
    }
    if (this.#query) title += `  ${style.muted("filter")} ${this.#query}`;
    const rows = [rule(width), truncate(title, width), ""];
    const labelWidth =
      Math.min(
        LABEL_LIMIT,
        Math.max(0, ...visible.map(({ entry: item }) => visibleWidth(item.label))),
      ) + 3;
    const shown = Math.max(1, maxRows);
    this.#shown = shown;
    const start = Math.max(
      0,
      Math.min(this.#index - Math.floor(shown / 2), visible.length - shown),
    );
    for (const [offset, { entry: item }] of visible.slice(start, start + shown).entries()) {
      const current = start + offset === this.#index && !item.inert;
      const paint = (text: string) =>
        current
          ? style.bold(style.strong(text))
          : item.inert
            ? style.text(text)
            : style.muted(text);
      const label = pad(truncate(item.label, labelWidth - 3), labelWidth);
      const detail = item.inert ? style.muted(item.detail) : paint(item.detail);
      rows.push(spread(`  ${paint(label)}${detail}`, style.muted(item.tag), width));
    }
    if (visible.length === 0) rows.push(style.muted("  No matches"));
    const keys = ["↑↓ navigate"];
    if (this.#tabs.length > 0) keys.push("tab category");
    if (visible.some(({ entry: item }) => !item.inert)) keys.push(`enter ${this.config.action}`);
    keys.push("esc close");
    rows.push(rule(width), hints(keys, width));
    return rows;
  }

  #renderBare(width: number, maxRows: number): string[] {
    const visible = this.#visible();
    this.#shown = Math.max(1, maxRows);
    const labelWidth =
      Math.max(0, ...visible.map(({ entry: item }) => visibleWidth(item.label))) + 2;
    const start = Math.max(
      0,
      Math.min(this.#index - Math.floor(this.#shown / 2), visible.length - this.#shown),
    );
    const rows = [rule(width)];
    for (const [offset, { entry: item }] of visible.slice(start, start + this.#shown).entries()) {
      const label = pad(item.label, labelWidth);
      const current = start + offset === this.#index;
      const paint = current ? style.bold(style.strong(label)) : style.muted(label);
      rows.push(truncate(`${" ".repeat(this.indent)}${paint}${style.muted(item.detail)}`, width));
    }
    rows.push(rule(width));
    return rows;
  }

  /** Moves by `pages` of the shown rows, stopping at either end. */
  #page(pages: number): void {
    const rows = Math.max(1, Math.round(Math.abs(pages) * this.#shown));
    this.#jump(this.#index + Math.sign(pages) * rows);
  }

  #jump(index: number): void {
    const count = this.count;
    if (count === 0) return;
    const target = Math.max(0, Math.min(count - 1, index));
    // Past an informational row, look back from the end and on from elsewhere.
    const direction = target === count - 1 && target !== 0 ? -1 : target < this.#index ? -1 : 1;
    this.#index = target;
    this.#skipInert(direction);
  }

  #switchTab(step: number): void {
    if (this.#tabs.length === 0) return;
    this.#tab = (this.#tab + step + this.#tabs.length) % this.#tabs.length;
    this.#index = 0;
    this.#skipInert(1);
  }

  #visible(): { entry: MenuEntry; index: number }[] {
    const group = this.#tab > 0 ? this.#tabs[this.#tab] : undefined;
    const query = this.#query.toLowerCase();
    const result: { entry: MenuEntry; index: number }[] = [];
    for (const [index, item] of this.#entries.entries()) {
      if (group && item.group !== group) continue;
      if (query && !`${item.label} ${item.detail}`.toLowerCase().includes(query)) continue;
      result.push({ entry: item, index });
    }
    return result;
  }

  #skipInert(direction: number): void {
    const visible = this.#visible();
    for (let step = 0; step < visible.length; step++) {
      if (!visible[this.#index]?.entry.inert) return;
      this.#index = (this.#index + direction + visible.length) % visible.length;
    }
  }
}

/** fx's read-only panel: bold labels, muted values, and a close hint. */
export function infoPanel(
  title: string,
  rows: readonly [string, string][],
  width: number,
): string[] {
  const labelWidth = Math.max(...rows.map(([label]) => visibleWidth(label))) + 6;
  const lines = [rule(width), style.bold(style.strong(title))];
  for (const [label, value] of rows) {
    const indent = " ".repeat(labelWidth);
    const wrapped = value
      .split("\n")
      .flatMap((line) => wrap(line, Math.max(10, width - labelWidth), "", true));
    wrapped.forEach((line, index) => {
      const head = index === 0 ? style.bold(style.text(pad(`  ${label}`, labelWidth))) : indent;
      lines.push(truncate(head + style.muted(line), width));
    });
  }
  lines.push(rule(width), hints(["esc close"], width));
  return lines;
}
