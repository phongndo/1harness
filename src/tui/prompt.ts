import { Editor, applyEditingKey } from "./editor.ts";
import type { Key } from "./input.ts";
import { hints, lineStep, rule } from "./menu.ts";
import type { CursorPosition } from "./screen.ts";
import { diffLine, style } from "./theme.ts";
import { diffBody, plainText, spread, truncate, wrap } from "./text.ts";

export interface ChoiceOption {
  label: string;
  description: string;
}

export interface ChoiceConfig {
  /** The panel's heading, such as `Permission needed` or `Question`. */
  header: string;
  /** Shown at the right edge, such as `Command`. */
  tag: string;
  title: string;
  detail: string[];
  options: ChoiceOption[];
  multiSelect: boolean;
  /** Adds an "Other" entry that switches to free-text input. */
  allowOther: boolean;
  /** Masks free-text input. */
  secret: boolean;
  initial: number;
}

export type ChoiceResult =
  | { kind: "options"; indexes: number[] }
  /** Free text, and in a multi-select the options ticked beside it. */
  | { kind: "other"; text: string; indexes: number[] }
  | { kind: "cancel" };

/** Rows of detail shown before the rest waits for ctrl+x. */
const DETAIL_LINES = 12;
/** Rows kept free of a prompt shown whole, for a row of the transcript. */
const FOOTER_ROWS = 1;

/** Detail text that is not a diff's change: bold, to read as what is asked about. */
function asked(text: string): string {
  return style.bold(style.strong(text));
}

/** A detail line's look: a diff's changes in its colors, its header and other text bold. */
function detailLine(line: string, change: boolean): string {
  return change ? diffLine(line, asked) : asked(line);
}

/**
 * A detail line as rows: commands and diffs break anywhere, keeping every
 * character where it was, since what is approved must read exactly; prose
 * breaks at spaces.
 */
function detailRows(line: string, width: number, change: boolean): string[] {
  const exact = /^(\$ |[+-]|@@)/.test(line) || /^\s/.test(line);
  return wrap(`  ${detailLine(line, change)}`, width, "    ", exact);
}

/** fx's decision panel: a ruled question, the numbered choices, and a hint line. */
export class ChoicePrompt {
  readonly config: ChoiceConfig;
  #index: number;
  #selected = new Set<number>();
  #other: Editor | null = null;
  /** Whether the whole detail shows, rather than its first rows. */
  #expanded = false;
  /** Rows of an expanded detail scrolled past, for one longer than the screen. */
  #offset = 0;
  /** Whether the expanded detail had more rows than fit, at the last render. */
  #overflows = false;
  #onDone: (result: ChoiceResult) => void;

  constructor(config: ChoiceConfig, onDone: (result: ChoiceResult) => void) {
    this.config = config;
    this.#index = Math.max(0, Math.min(config.initial, this.#count - 1));
    this.#onDone = onDone;
    if (config.options.length === 0 && config.allowOther) this.#other = new Editor();
  }

  get #count(): number {
    return this.config.options.length + (this.config.allowOther ? 1 : 0);
  }

  get #otherIndex(): number {
    return this.config.allowOther ? this.config.options.length : -1;
  }

  /** Whether free text is being typed, so pastes belong to the prompt. */
  get typing(): boolean {
    return this.#other !== null;
  }

  /** An answer is one line, whatever line breaks a paste brings. */
  paste(text: string): void {
    this.#other?.insert(text.replace(/[\r\n]+/g, " "));
  }

  /** Whether page keys scroll the detail, which is shown whole but runs past the screen. */
  get scrolls(): boolean {
    return this.#expanded && this.#overflows;
  }

  key(key: Key): void {
    if (this.#other) {
      this.#otherKey(key);
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.#onDone({ kind: "cancel" });
      return;
    }
    if (key.ctrl && key.name === "x") {
      this.#expanded = !this.#expanded;
      this.#offset = 0;
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      this.#offset = Math.max(0, this.#offset + (key.name === "pageup" ? -8 : 8));
      return;
    }
    // Options take no typing, so vim keys move as well: j/k, and g/G for the ends.
    const step =
      lineStep(key) ||
      (key.name === "tab"
        ? key.shift
          ? -1
          : 1
        : key.text === "j"
          ? 1
          : key.text === "k"
            ? -1
            : 0);
    if (step) {
      this.#index = (this.#index + step + this.#count) % this.#count;
      return;
    }
    switch (key.name) {
      case "home":
        this.#index = 0;
        return;
      case "end":
        this.#index = this.#count - 1;
        return;
      case "escape":
        this.#onDone({ kind: "cancel" });
        return;
      case "space":
        if (this.config.multiSelect && this.#index !== this.#otherIndex) this.#toggle(this.#index);
        return;
      case "return":
        this.#choose(this.#index);
        return;
    }
    if (key.ctrl || key.meta) return;
    if (key.text === "g" || key.text === "G") {
      this.#index = key.text === "g" ? 0 : this.#count - 1;
      return;
    }
    const digit = Number(key.text);
    if (
      key.text !== "" &&
      Number.isInteger(digit) &&
      digit >= 1 &&
      digit <= Math.min(9, this.#count)
    ) {
      this.#index = digit - 1;
      if (this.config.multiSelect && this.#index !== this.#otherIndex) this.#toggle(this.#index);
      else this.#choose(this.#index);
    }
  }

  /** Rows for `width` columns; `height` bounds how much detail shows when it shows whole. */
  render(width: number, height = 40): { rows: string[]; cursor: CursorPosition | null } {
    const { config } = this;
    const mode = config.multiSelect ? "Choose any" : "Choose one";
    const rows = [
      rule(width),
      spread(`  ${style.bold(`${config.header} · ${mode}`)}`, style.muted(config.tag), width),
      // A harness's text can hold line breaks, which would throw the rows off.
      ...wrap(`  ${style.bold(plainText(config.title, true))}`, width, "  "),
    ];
    const detail = config.detail.flatMap((text) => {
      const lines = plainText(text).replace(/\s+$/, "").split("\n");
      // A diff's header, at its top, is not a change, though it starts with --- and +++.
      const head = lines.length - diffBody(lines).length;
      return lines.flatMap((line, index) => detailRows(line, width, index >= head));
    });
    const entries: ChoiceOption[] = config.options.map((option) => ({
      label: plainText(option.label, true),
      description: plainText(option.description, true),
    }));
    if (config.allowOther) entries.push({ label: "Other…", description: "type your own answer" });
    const choices = this.#choiceRows(entries, width);
    // Shown whole, the detail takes the screen less the prompt's other rows.
    const room = Math.max(
      DETAIL_LINES,
      height - FOOTER_ROWS - rows.length - choices.length - 1 - (this.#other ? 2 : 0),
    );
    const limit = this.#expanded ? room : DETAIL_LINES;
    this.#overflows = this.#expanded && detail.length > limit;
    if (detail.length <= limit) {
      this.#offset = 0;
      rows.push(...detail);
      if (this.#expanded && detail.length > DETAIL_LINES)
        rows.push(truncate(style.muted("  ctrl+x shows less"), width));
    } else if (this.#expanded) {
      // Too long for the screen even whole: a window on it, which page keys move.
      const window = limit - 1;
      this.#offset = Math.min(this.#offset, detail.length - window);
      rows.push(...detail.slice(this.#offset, this.#offset + window));
      rows.push(
        truncate(
          style.muted(
            `  rows ${this.#offset + 1}–${this.#offset + window} of ${detail.length} · pgup pgdn scroll · ctrl+x shows less`,
          ),
          width,
        ),
      );
    } else {
      // Cut short, the rows end a line early to say how to see the rest.
      rows.push(...detail.slice(0, limit - 1));
      rows.push(
        truncate(
          style.muted(`  … ${detail.length - limit + 1} more rows · ctrl+x shows them`),
          width,
        ),
      );
    }
    rows.push(...choices);

    if (this.#other) {
      const layout = this.#other.layout(`  ${style.strong("┃")} `, width, config.secret);
      const offset = rows.length;
      rows.push(...layout.rows, hints(["enter submit", "esc back"], width));
      return {
        rows,
        cursor: { row: offset + layout.cursor.row, column: layout.cursor.column },
      };
    }
    const keys = [`1–${Math.min(9, entries.length)} choose now`, "↑↓ options"];
    if (config.multiSelect) keys.push("space toggle");
    keys.push("enter confirm", "esc cancel");
    rows.push(hints(keys, width));
    return { rows, cursor: null };
  }

  /** The numbered choices, each wrapped whole. */
  #choiceRows(entries: readonly ChoiceOption[], width: number): string[] {
    const { config } = this;
    const rows: string[] = [];
    for (const [index, option] of entries.entries()) {
      const current = index === this.#index;
      const box =
        config.multiSelect && index !== this.#otherIndex
          ? this.#selected.has(index)
            ? "[x] "
            : "[ ] "
          : "";
      const label = `${index + 1}. ${box}${option.label}`;
      const description = option.description ? style.muted(`  ${option.description}`) : "";
      // A choice reads whole, since what it allows can be in its last words.
      rows.push(
        ...wrap(
          current
            ? `  ${style.strong("❯")} ${style.bold(style.strong(label))}${description}`
            : `    ${label}${description}`,
          width,
          " ".repeat(4 + `${index + 1}. ${box}`.length),
        ),
      );
    }
    return rows;
  }

  #toggle(index: number): void {
    if (this.#selected.has(index)) this.#selected.delete(index);
    else this.#selected.add(index);
  }

  #choose(index: number): void {
    if (index === this.#otherIndex) {
      this.#other = new Editor();
      return;
    }
    if (this.config.multiSelect) {
      const indexes =
        this.#selected.size > 0 ? [...this.#selected].toSorted((a, b) => a - b) : [index];
      this.#onDone({ kind: "options", indexes });
      return;
    }
    this.#onDone({ kind: "options", indexes: [index] });
  }

  #otherKey(key: Key): void {
    const editor = this.#other;
    if (!editor) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (this.config.options.length === 0) this.#onDone({ kind: "cancel" });
      else this.#other = null;
      return;
    }
    if (key.name === "return") {
      const text = editor.text.trim();
      const indexes = this.config.multiSelect ? [...this.#selected].toSorted((a, b) => a - b) : [];
      if (text !== "") this.#onDone({ kind: "other", text, indexes });
      return;
    }
    applyEditingKey(editor, key);
  }
}
