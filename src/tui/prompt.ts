import { Editor, applyEditingKey } from "./editor.ts";
import type { Key } from "./input.ts";
import { hints, lineStep, rule, tabRow } from "./menu.ts";
import type { CursorPosition } from "./screen.ts";
import { diffLine, style } from "./theme.ts";
import { oneLineText, plainText, spread, truncate, visibleWidth, wrap } from "./text.ts";

export interface ChoiceOption {
  label: string;
  description: string;
  /** Said beside it only while it is not selected; once it is, the hint line says the same. */
  unselected?: string;
}

export interface ChoiceConfig {
  /** The panel's heading, such as `Permission needed` or `Question`. */
  header: string;
  /** Shown at the right edge, such as `Command`. */
  tag: string;
  title: string;
  /** What tab adds to a choice, for its hint. */
  comment?: string;
  /** Where what the warning warns of would happen, said beside it where it fits. */
  where?: string;
  /** What could go wrong in choosing yes, which should not read as ordinary detail. */
  warning?: string;
  detail: string[];
  options: ChoiceOption[];
  multiSelect: boolean;
  /** Adds an "Other" entry that switches to free-text input. */
  allowOther: boolean;
  /** Masks free-text input. */
  secret: boolean;
  initial: number;
  /** Which options take a comment, written with tab; none when absent. */
  commentable?: (index: number) => boolean;
  /** What esc does here, for the hint line; `cancel` when absent. */
  escape?: string;
}

/** A comment the user wrote on an option, to go with it. */
export interface Comment {
  index: number;
  text: string;
}

export type ChoiceResult =
  | { kind: "options"; indexes: number[]; comment?: Comment }
  /** Free text, and in a multi-select the options ticked beside it. */
  | { kind: "other"; text: string; indexes: number[]; comment?: Comment }
  | { kind: "cancel" };

/** What a prompt holding more than one, such as a request's questions, changes on a page. */
export interface PromptFrame {
  /** The heading's left side, styled, in place of the config's header. */
  heading?: string;
  /** The heading's right side, in place of the config's tag. */
  tag?: string;
  /** Hints of its own, put before the enter and esc hints that end the line. */
  keys?: string[];
}

/** Rows of detail shown before the rest waits for ctrl+x. */
const DETAIL_LINES = 12;
/** Rows kept free of a prompt shown whole, for a row of the transcript. */
const FOOTER_ROWS = 1;

/** Detail text that is not a diff's: bold, to read as what is asked about. */
function asked(text: string): string {
  return style.bold(style.strong(text));
}

/**
 * A detail line as rows: commands and diffs break anywhere, keeping every
 * character where it was, since what is approved must read exactly; prose
 * breaks at spaces. `other` paints what is not a diff's change.
 */
function detailRows(line: string, width: number, other: (text: string) => string): string[] {
  const exact = /^(\$ |[+-]|@@)/.test(line) || /^\s/.test(line);
  return wrap(`  ${diffLine(line, other)}`, width, "    ", exact);
}

/**
 * A decision panel, ruled and laid out as the menus are: a heading with its
 * tag at the right, the question and what it is about, the numbered choices
 * with the selected one bold, and a hint line.
 */
export class ChoicePrompt {
  readonly config: ChoiceConfig;
  #index: number;
  #selected = new Set<number>();
  #other: Editor | null = null;
  /** The comment kept, on the option it was written on. */
  #comment: Comment | null = null;
  /** The comment being written, on the selected option. */
  #commenting: Editor | null = null;
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

  /** Whether text is being typed, an answer or a comment, so pastes belong to the prompt. */
  get typing(): boolean {
    return this.#other !== null || this.#commenting !== null;
  }

  /** An answer or a comment is one line, whatever line breaks a paste brings. */
  paste(text: string): void {
    (this.#commenting ?? this.#other)?.insert(text.replace(/[\r\n]+/g, " "));
  }

  /** Whether the selected option takes a comment. */
  get #commentable(): boolean {
    return this.#index !== this.#otherIndex && this.config.commentable?.(this.#index) === true;
  }

  /** Whether page keys scroll the detail, which is shown whole but runs past the screen. */
  get scrolls(): boolean {
    return this.#expanded && this.#overflows;
  }

  key(key: Key): void {
    if (this.#commenting) {
      this.#commentKey(key);
      return;
    }
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
    // Tab writes a comment on the selected option, where it takes one.
    if (key.name === "tab" && !key.shift) {
      if (this.#commentable) {
        this.#commenting = new Editor();
        if (this.#comment?.index === this.#index) this.#commenting.set(this.#comment.text);
      }
      return;
    }
    // Options take no typing, so vim keys move as well: j/k, and g/G for the ends.
    const step = lineStep(key) || (key.text === "j" ? 1 : key.text === "k" ? -1 : 0);
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
  render(
    width: number,
    height = 40,
    frame: PromptFrame = {},
  ): { rows: string[]; cursor: CursorPosition | null } {
    const { config } = this;
    // A warning keeps to its line; where the folder will not fit beside it, it goes under.
    const warned = `⚠ ${config.warning}`;
    const beside = config.where && visibleWidth(`${warned} · ${config.where}`) + 2 <= width;
    const warning = beside ? `${warned} · ${config.where}` : warned;
    const under = config.warning && config.where && !beside ? config.where : null;
    const rows = [
      rule(width),
      spread(
        frame.heading ?? style.bold(style.strong(config.header)),
        style.muted(frame.tag ?? config.tag),
        width,
      ),
      "",
      // A harness's text can hold line breaks, which would throw the rows off.
      ...wrap(`  ${style.bold(oneLineText(config.title))}`, width, "  "),
      ...(config.warning ? wrap(`  ${style.removed(warning)}`, width, "    ") : []),
      ...(under ? [truncate(`  ${style.removed(under)}`, width)] : []),
    ];
    const detail = config.detail.flatMap((text) => {
      const lines = plainText(text).replace(/\s+$/, "").split("\n");
      const hunks = lines.findIndex((line) => line.startsWith("@@"));
      // A diff's header says again the file named above it, in the same marks as its changes.
      const head = (hunks === -1 ? lines : lines.slice(0, hunks)).filter(
        (line) => !/^(?:---|\+\+\+) /.test(line),
      );
      // Quiet context lets the changes stand out.
      const body = hunks === -1 ? [] : lines.slice(hunks);
      return [
        ...head.flatMap((line) => detailRows(line, width, asked)),
        ...body.flatMap((line) =>
          detailRows(line, width, line.startsWith("@@") ? style.muted : style.text),
        ),
      ];
    });
    const entries: ChoiceOption[] = config.options.map((option, index) => ({
      label: oneLineText(option.label),
      description: oneLineText(
        index === this.#index
          ? option.description
          : option.description || (option.unselected ?? ""),
      ),
    }));
    if (config.allowOther) entries.push({ label: "Other…", description: "type your own answer" });
    const choices = this.#choiceRows(entries, width);
    // Shown whole, the detail takes the screen less the prompt's other rows.
    const room = Math.max(
      DETAIL_LINES,
      // Under the choices: a blank row above them, then the rule and hints, and
      // a free answer's blank row and its own line.
      height - FOOTER_ROWS - rows.length - choices.rows.length - 3 - (this.#other ? 2 : 0),
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
    rows.push("");
    const choicesAt = rows.length;
    rows.push(...choices.rows);

    if (this.#commenting) {
      rows.push(
        rule(width),
        hints(
          ["enter " + (config.multiSelect ? "save comment" : "confirm with comment"), "esc back"],
          width,
        ),
      );
      const at = choices.cursor;
      return { rows, cursor: at ? { row: choicesAt + at.row, column: at.column } : null };
    }
    if (this.#other) {
      const layout = this.#other.layout(`  ${style.strong("┃")} `, width, config.secret);
      const offset = rows.length + 1;
      rows.push("", ...layout.rows, rule(width), hints(["enter submit", "esc back"], width));
      return {
        rows,
        cursor: { row: offset + layout.cursor.row, column: layout.cursor.column },
      };
    }
    const keys = [width >= 60 ? "↑↓ move or press a number" : "↑↓ move"];
    if (config.multiSelect) keys.push("space toggle");
    if (this.#commentable)
      keys.push(`tab ${width >= 60 ? "add a " : ""}${config.comment ?? "comment"}`);
    keys.push(...(frame.keys ?? []), "enter confirm", `esc ${config.escape ?? "cancel"}`);
    rows.push(rule(width), hints(keys, width));
    return { rows, cursor: null };
  }

  /**
   * The numbered choices, each wrapped whole, as a menu's entries: the
   * selected one bold, the rest muted; a multi-select's ticked, as task
   * lists are.
   */
  #choiceRows(
    entries: readonly ChoiceOption[],
    width: number,
  ): { rows: string[]; cursor: CursorPosition | null } {
    const { config } = this;
    const rows: string[] = [];
    let cursor: CursorPosition | null = null;
    const digits = String(entries.length).length;
    // Descriptions line up in a column, as a menu's details do, while the
    // labels are short enough to leave them room.
    const boxed = (index: number) => config.multiSelect && index !== this.#otherIndex;
    const longest = Math.max(
      0,
      ...entries.map((option, index) => visibleWidth(option.label) + (boxed(index) ? 2 : 0)),
    );
    const column = longest <= width * 0.4 ? longest : 0;
    for (const [index, option] of entries.entries()) {
      const current = index === this.#index;
      const paint = (text: string) =>
        // Faint would read as disabled, when these are the alternatives to compare.
        current ? style.bold(style.strong(text)) : style.text(text);
      const number = String(index + 1).padStart(digits);
      const box =
        config.multiSelect && index !== this.#otherIndex
          ? this.#selected.has(index)
            ? "☑ "
            : "☐ "
          : "";
      // Bold alone is lost on a terminal that shows it faintly, as a menu's marker knows.
      const gutter = current ? style.strong("› ") : "  ";
      const head = `${gutter}${current ? paint(number) : style.faint(number)}  ${paint(box)}`;
      const gap = " ".repeat(
        Math.max(0, column - visibleWidth(option.label) - visibleWidth(box)) + 2,
      );
      // A description that only says the label again is left out.
      const said = option.description.trim().toLowerCase() === option.label.trim().toLowerCase();
      const description =
        option.description && !said
          ? `${gap}${current ? style.soft(option.description) : style.faint(option.description)}`
          : "";
      // A choice reads whole, since what it allows can be in its last words.
      rows.push(
        ...wrap(
          `${head}${paint(option.label)}${description}`,
          width,
          " ".repeat(4 + digits + box.length),
        ),
      );
      // Its comment, under it: being written, or as kept.
      const indent = " ".repeat(4 + digits);
      if (this.#commenting && current) {
        const layout = this.#commenting.layout(`${indent}${style.muted("↳")} `, width);
        cursor = { row: rows.length + layout.cursor.row, column: layout.cursor.column };
        rows.push(...layout.rows);
      } else if (this.#comment?.index === index)
        rows.push(
          ...wrap(
            `${indent}${style.muted("↳")} ${style.soft(this.#comment.text)}`,
            width,
            `${indent}  `,
          ),
        );
    }
    return { rows, cursor };
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
    const indexes = this.config.multiSelect
      ? this.#selected.size > 0
        ? [...this.#selected].toSorted((a, b) => a - b)
        : [index]
      : [index];
    this.#onDone({ kind: "options", indexes, ...this.#commentOn(indexes) });
  }

  /** The comment, where it is on one of `indexes`, the options chosen. */
  #commentOn(indexes: readonly number[]): { comment?: Comment } {
    const comment = this.#comment;
    return comment && indexes.includes(comment.index) ? { comment } : {};
  }

  #commentKey(key: Key): void {
    const editor = this.#commenting;
    if (!editor) return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.#commenting = null;
      return;
    }
    if (key.name === "return") {
      const text = editor.text.trim();
      this.#commenting = null;
      if (text === "") {
        if (this.#comment?.index === this.#index) this.#comment = null;
        return;
      }
      this.#comment = { index: this.#index, text };
      // A comment on one choice of many ticks it; on the one choice, it is the answer.
      if (this.config.multiSelect) this.#selected.add(this.#index);
      else this.#choose(this.#index);
      return;
    }
    applyEditingKey(editor, key);
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
      if (text !== "") this.#onDone({ kind: "other", text, indexes, ...this.#commentOn(indexes) });
      return;
    }
    applyEditingKey(editor, key);
  }
}

/** One question's answer: the options picked, any answer of its own, and a comment on one. */
export interface Answer {
  indexes: number[];
  text: string | null;
  comment: Comment | null;
}

export type QuestionsResult = { kind: "answers"; answers: Answer[] } | { kind: "cancel" };

/**
 * A request's questions as pages of one prompt: ←→ move between them, each
 * keeps its answer while you look at another, and the answers go back
 * together once every question has one.
 */
export class QuestionPrompt {
  readonly configs: readonly ChoiceConfig[];
  #pages: ChoicePrompt[];
  #answers: (Answer | null)[];
  #page = 0;
  #onDone: (result: QuestionsResult) => void;

  constructor(configs: readonly ChoiceConfig[], onDone: (result: QuestionsResult) => void) {
    this.configs = configs;
    this.#onDone = onDone;
    this.#answers = configs.map(() => null);
    this.#pages = configs.map(
      (config, index) => new ChoicePrompt(config, (result) => this.#answered(index, result)),
    );
  }

  get #current(): ChoicePrompt {
    return this.#pages[this.#page]!;
  }

  /** Whether text is being typed, an answer or a comment, so pastes belong here. */
  get typing(): boolean {
    return this.#current.typing;
  }

  paste(text: string): void {
    this.#current.paste(text);
  }

  get scrolls(): boolean {
    return this.#current.scrolls;
  }

  key(key: Key): void {
    if (this.#pages.length > 1 && !this.#current.typing && !key.ctrl && !key.meta) {
      if (key.name === "left" || key.text === "h") {
        this.#page = Math.max(0, this.#page - 1);
        return;
      }
      if (key.name === "right" || key.text === "l") {
        this.#page = Math.min(this.#pages.length - 1, this.#page + 1);
        return;
      }
    }
    this.#current.key(key);
  }

  render(width: number, height = 40): { rows: string[]; cursor: CursorPosition | null } {
    if (this.#pages.length === 1) return this.#current.render(width, height);
    const title = style.bold(style.strong(`Question ${this.#page + 1} of ${this.#pages.length}`));
    // Each question by its short name, ticked once answered.
    const tabs = this.configs.map(
      (config, index) =>
        `${this.#answers[index] ? "✓ " : ""}${oneLineText(config.tag) || `Q${index + 1}`}`,
    );
    return this.#current.render(width, height, {
      heading: title + tabRow(tabs, this.#page, width - visibleWidth(title) - 2),
      // The tabs name every question, so the tag at the right would say it twice.
      tag: "",
      keys: ["←→ questions"],
    });
  }

  /** A page answered: on to the next without one, or, when none is left, all of them back. */
  #answered(index: number, result: ChoiceResult): void {
    if (result.kind === "cancel") {
      this.#onDone({ kind: "cancel" });
      return;
    }
    this.#answers[index] = {
      indexes: result.indexes,
      text: result.kind === "other" ? result.text : null,
      comment: result.comment ?? null,
    };
    const count = this.#pages.length;
    for (let step = 1; step <= count; step++) {
      const next = (index + step) % count;
      if (!this.#answers[next]) {
        this.#page = next;
        return;
      }
    }
    this.#onDone({
      kind: "answers",
      answers: this.#answers.map((answer) => answer ?? { indexes: [], text: null, comment: null }),
    });
  }
}
