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
  /** What ctrl+s does besides choosing, such as `make default`; none without it. */
  save: string;
  /** fx's argument list: rows only, between rules, lined up under the word being completed. */
  bare: boolean;
  /** Shows the selected entry's whole detail under the list, for details cut short in their row. */
  describe: boolean;
  /** Counts the entries after the title; a question with a few answers leaves it out. */
  count: boolean;
}

export type MenuResult = { kind: "choose"; index: number; save?: true } | { kind: "close" } | null;

const HINT_GAP = "   ";
/** Ctrl keys that move by pages, as in vim. */
const PAGE_KEYS: Record<string, number> = { d: 0.5, u: -0.5, f: 1, b: -1 };
/** Labels get at least this many columns before details take the rest. */
const LABEL_LIMIT = 28;
/** Nor more than this share of the row, so details stay readable. */
const LABEL_SHARE = 0.6;
/** Details wider than this share of the row, for most entries, leave labels at LABEL_LIMIT. */
const DETAIL_SHARE = 0.4;

/**
 * The size most of these sorted sizes are within: their 90th percentile,
 * which is the largest for a short list, so only a long one leaves any out.
 */
function most(sizes: readonly number[]): number {
  return sizes[Math.ceil((sizes.length - 1) * 0.9)] ?? 0;
}

/**
 * The category tabs after the title: all of them when they fit, otherwise a
 * run around the selected one, with `‹` and `›` where more are.
 */
export function tabRow(tabs: readonly string[], current: number, room: number): string {
  const paint = (index: number) =>
    index === current
      ? style.bold(style.strong(`[${tabs[index]}]`))
      : style.muted(tabs[index] ?? "");
  const size = (index: number) => visibleWidth(tabs[index] ?? "") + (index === current ? 4 : 2);
  let first = current;
  let last = current;
  // Room for the selected tab, and for `  ‹` and `  ›` should either be needed.
  let used = size(current) + 6;
  // Grow outward from the selected tab, right first, while the run fits.
  for (let grew = true; grew;) {
    grew = false;
    if (last + 1 < tabs.length && used + size(last + 1) <= room) {
      used += size(++last);
      grew = true;
    }
    if (first > 0 && used + size(first - 1) <= room) {
      used += size(--first);
      grew = true;
    }
  }
  let row = "";
  if (first > 0) row += `  ${style.muted("‹")}`;
  for (let index = first; index <= last; index++) row += `  ${paint(index)}`;
  if (last < tabs.length - 1) row += `  ${style.muted("›")}`;
  return row;
}

export function entry(label: string, detail = "", options: Partial<MenuEntry> = {}): MenuEntry {
  return { label, detail, tag: "", group: "", inert: false, ...options };
}

/** The row step for keys that move in any list: arrows, and ctrl+j/k and ctrl+n/p as in fzf. */
export function lineStep(key: Key): number {
  if (key.name === "up" || (key.ctrl && (key.name === "k" || key.name === "p"))) return -1;
  if (key.name === "down" || (key.ctrl && (key.name === "j" || key.name === "n"))) return 1;
  return 0;
}

/** A rule across `width`, with `label` near its right end, as Codex counts its list. */
export function rule(width: number, label = ""): string {
  if (!label) return style.rule("─".repeat(Math.max(0, width)));
  const tail = ` ${label} ─`;
  return style.rule(`${"─".repeat(Math.max(0, width - visibleWidth(tail)))}${tail}`);
}

export function hints(parts: readonly string[], width: number): string {
  // Too wide, the first hints give way, the most familiar keys such as ↑↓,
  // so the line keeps what ends it: how to confirm and how to leave.
  let shown = [...parts];
  while (shown.length > 2 && visibleWidth(shown.join(HINT_GAP)) > width) shown = shown.slice(1);
  return truncate(style.muted(shown.join(HINT_GAP)), width);
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
  /** Where the last render put its entries: the row of the first, and which entry that is. */
  #drawn = { row: 0, start: 0, count: 0 };
  /** Where a bare list's rows start: the column of the word being completed. */
  indent = 0;

  constructor(config: Partial<MenuConfig> & Pick<MenuConfig, "title" | "entries">) {
    this.config = {
      initial: 0,
      tabs: false,
      filter: false,
      action: "use",
      save: "",
      bare: false,
      describe: false,
      count: true,
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

  /**
   * Replaces the entries, keeping the selection on the same entry when it
   * remains: the same label and detail, as files of one name in two folders
   * differ by theirs, or else the same label.
   */
  setEntries(entries: MenuEntry[]): void {
    const chosen = this.selected();
    this.#entries = entries;
    const same = this.#visible().findIndex(
      ({ entry: item }) => item.label === chosen?.label && item.detail === chosen.detail,
    );
    if (same !== -1) this.#index = same;
    else this.select(chosen?.label ?? "");
    this.#skipInert(1);
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

  /**
   * Selects the entry the last render drew on row `row` of its rows, as a
   * click on it does; says whether there was one to select.
   */
  entryAt(row: number): boolean {
    const offset = row - this.#drawn.row;
    if (offset < 0 || offset >= this.#drawn.count) return false;
    const index = this.#drawn.start + offset;
    if (this.#visible()[index]?.entry.inert !== false) return false;
    this.#index = index;
    return true;
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
      if (key.name === "s" && this.config.save) {
        const chosen = this.#visible()[this.#index];
        if (!chosen || chosen.entry.inert) return null;
        return { kind: "choose", index: chosen.index, save: true };
      }
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

  /** Adds pasted text to the filter, for a menu that takes typing; returns whether it did. */
  paste(text: string): boolean {
    if (!this.config.filter) return false;
    this.#query += text.replace(/\s+/g, " ");
    this.#index = 0;
    this.#skipInert(1);
    return true;
  }

  /** Rows for the panel, showing at most `maxRows` entries around the selection. */
  render(width: number, maxRows: number): string[] {
    if (this.config.bare) return this.#renderBare(width, maxRows);
    const visible = this.#visible();
    // Informational rows are not counted, unless they are all there is.
    const count = visible.filter(({ entry: item }) => !item.inert).length || visible.length;
    let title = style.bold(
      style.strong(this.config.count ? `${this.config.title} ${count}` : this.config.title),
    );
    const filter = this.#query ? `  ${style.muted("filter")} ${this.#query}` : "";
    if (this.#tabs.length > 0)
      title += tabRow(this.#tabs, this.#tab, width - visibleWidth(title) - visibleWidth(filter));
    title += filter;
    const rows = [rule(width), truncate(title, width), ""];
    // Labels are cut at LABEL_LIMIT, unless most details are short, as a list of
    // threads' are: then labels take what the details and tags leave.
    const widths = (pick: (item: MenuEntry) => string) =>
      visible.map(({ entry: item }) => visibleWidth(pick(item))).toSorted((a, b) => a - b);
    const details = most(widths((item) => item.detail));
    const tags = Math.max(0, ...widths((item) => item.tag));
    const spare = width - 2 - details - tags - 5;
    // A narrow screen gives labels no more than half the row, so details still show.
    const floor = Math.min(LABEL_LIMIT, Math.floor(width / 2) - 3);
    const limit =
      details > width * DETAIL_SHARE
        ? floor
        : Math.max(floor, Math.min(spare, Math.floor(width * LABEL_SHARE)));
    // Sized for most labels; a rare long one is cut, and shows whole when selected.
    const labelWidth = Math.min(limit, most(widths((item) => item.label))) + 3;
    const cut = (item: MenuEntry) =>
      (visibleWidth(item.label) > labelWidth - 3 &&
        visibleWidth(item.label) + 3 >
          width - 2 - visibleWidth(item.detail) - (item.tag ? visibleWidth(item.tag) + 2 : 0)) ||
      2 + labelWidth + visibleWidth(item.detail) + (item.tag ? visibleWidth(item.tag) + 2 : 0) >
        width;
    // When rows are cut short, the selected one shows whole below them, in rows kept
    // for it, so the panel does not jump as the selection moves.
    // The rows that show a cut entry whole come out of the rows allowed.
    const describing =
      this.config.describe &&
      maxRows > 3 &&
      visible.some(({ entry: item }) => !item.inert && cut(item));
    const shown = Math.max(1, maxRows - (describing ? 3 : 0));
    this.#shown = shown;
    const start = Math.max(
      0,
      Math.min(this.#index - Math.floor(shown / 2), visible.length - shown),
    );
    this.#drawn = { row: rows.length, start, count: Math.min(shown, visible.length - start) };
    for (const [offset, { entry: item }] of visible.slice(start, start + shown).entries()) {
      const current = start + offset === this.#index && !item.inert;
      const paint = (text: string) =>
        current
          ? style.bold(style.strong(text))
          : item.inert
            ? style.text(text)
            : style.muted(text);
      // A label longer than its column still shows whole where its row has room.
      const room =
        width - 2 - visibleWidth(item.detail) - (item.tag ? visibleWidth(item.tag) + 2 : 0);
      const own = visibleWidth(item.label) + 3;
      // Where the selected entry shows whole under the list, labels keep to
      // their column, so the details line up.
      const label =
        own > labelWidth && own <= room && !describing
          ? pad(item.label, own)
          : pad(truncate(item.label, labelWidth - 3), labelWidth);
      const detail = item.inert ? style.muted(item.detail) : paint(item.detail);
      // Bold alone is lost on a terminal or a pair of eyes that shows it faintly.
      const gutter = current ? style.strong("› ") : "  ";
      rows.push(spread(`${gutter}${paint(label)}${detail}`, style.muted(item.tag), width));
    }
    if (visible.length === 0) rows.push(truncate(style.muted("  No matches"), width));
    const chosen = this.selected();
    if (describing) {
      // An entry its row shows whole would only be said twice.
      const whole =
        chosen && !cut(chosen) && visibleWidth(chosen.label) <= labelWidth - 3 && !chosen.inert;
      const text = chosen && !chosen.inert && !whole ? `${chosen.label}  ${chosen.detail}` : "";
      const lines = text ? wrap(`  ${style.soft(text)}`, width, "  ") : [];
      // A third row's worth is cut, with an ellipsis.
      const second = lines.length > 2 ? truncate(`${lines[1]} ${lines[2]}`, width) : lines[1];
      rows.push("", lines[0] ?? "", second ?? "");
    }
    const keys = ["↑↓ move"];
    if (this.#tabs.length > 0) keys.push("tab category");
    if (visible.some(({ entry: item }) => !item.inert)) {
      keys.push(`enter ${this.config.action}`);
      if (this.config.save) keys.push(`ctrl+s ${this.config.save}`);
    }
    keys.push("esc close");
    // A list that says nothing of what lies past its last row reads as all there is.
    // Group headings are rows but nothing to count, as the title's count knows.
    const before = visible.slice(0, this.#index + 1).filter(({ entry: item }) => !item.inert);
    const position = visible.length > shown ? `${before.length} / ${count}` : "";
    rows.push(rule(width, position), hints(keys, width));
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
    this.#drawn = { row: 1, start, count: Math.min(this.#shown, visible.length - start) };
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
    this.#skipInert(direction, false);
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

  /**
   * Moves off informational rows in `direction`. Moving a row at a time wraps
   * around; a jump stops at the ends instead, turning back from one.
   */
  #skipInert(direction: number, wrapAround = true): void {
    const visible = this.#visible();
    const chosen = (index: number) => visible[index] !== undefined && !visible[index].entry.inert;
    if (chosen(this.#index)) return;
    if (wrapAround) {
      for (let step = 1; step < visible.length; step++) {
        const index = (this.#index + direction * step + visible.length * step) % visible.length;
        if (chosen(index)) {
          this.#index = index;
          return;
        }
      }
      return;
    }
    for (const way of [direction, -direction])
      for (let index = this.#index + way; index >= 0 && index < visible.length; index += way)
        if (chosen(index)) {
          this.#index = index;
          return;
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
  const lines = [rule(width), truncate(style.bold(style.strong(title)), width), ""];
  for (const [label, value] of rows) {
    const indent = " ".repeat(labelWidth);
    const wrapped = value
      .split("\n")
      // Values break at spaces where they can, and a path anywhere.
      .flatMap((line) => wrap(line, Math.max(10, width - labelWidth)));
    wrapped.forEach((line, index) => {
      const head = index === 0 ? style.bold(style.text(pad(`  ${label}`, labelWidth))) : indent;
      lines.push(truncate(head + style.text(line), width));
    });
  }
  lines.push(rule(width), hints(["esc close"], width));
  return lines;
}
