import { Editor, applyEditingKey } from "./editor.ts";
import type { Key } from "./input.ts";
import { hints, lineStep, rule } from "./menu.ts";
import type { CursorPosition } from "./screen.ts";
import { style } from "./theme.ts";
import { spread, truncate, wrap } from "./text.ts";

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
  | { kind: "other"; text: string }
  | { kind: "cancel" };

const DETAIL_LINES = 12;

function detailLine(line: string): string {
  if (/^\+(?!\+\+)/.test(line)) return style.added(line);
  if (/^-(?!--)/.test(line)) return style.removed(line);
  return style.bold(style.strong(line));
}

/** fx's decision panel: a ruled question, the numbered choices, and a hint line. */
export class ChoicePrompt {
  readonly config: ChoiceConfig;
  #index: number;
  #selected = new Set<number>();
  #other: Editor | null = null;
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

  paste(text: string): void {
    this.#other?.insert(text.replace(/\n/g, " "));
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
    // Options take no typing, so vim keys move as well: j/k, and g/G for the ends.
    const step =
      lineStep(key) || (key.name === "tab" || key.text === "j" ? 1 : key.text === "k" ? -1 : 0);
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

  render(width: number): { rows: string[]; cursor: CursorPosition | null } {
    const { config } = this;
    const mode = config.multiSelect ? "Choose any" : "Choose one";
    const rows = [
      rule(width),
      spread(`  ${style.bold(`${config.header} · ${mode}`)}`, style.muted(config.tag), width),
      ...wrap(`  ${style.bold(config.title)}`, width, "  "),
    ];
    const detail = config.detail.flatMap((text) => text.replace(/\s+$/, "").split("\n"));
    for (const line of detail.slice(0, DETAIL_LINES))
      rows.push(truncate(`  ${detailLine(line)}`, width));
    if (detail.length > DETAIL_LINES)
      rows.push(style.muted(`  … ${detail.length - DETAIL_LINES} more lines`));

    const entries: ChoiceOption[] = [...config.options];
    if (config.allowOther) entries.push({ label: "Other…", description: "type your own answer" });
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
      rows.push(
        truncate(
          current
            ? `  ${style.strong("❯")} ${style.bold(style.strong(label))}${description}`
            : `    ${label}${description}`,
          width,
        ),
      );
    }

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
      if (text !== "") this.#onDone({ kind: "other", text });
      return;
    }
    applyEditingKey(editor, key);
  }
}
