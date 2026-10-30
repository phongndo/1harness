import { charWidth, visibleWidth } from "./text.ts";
import type { Key } from "./input.ts";
import type { CursorPosition } from "./screen.ts";

/** A multi-line input buffer with readline-style editing and history. */
export class Editor {
  #chars: string[] = [];
  #cursor = 0;
  #history: string[] = [];
  #historyIndex = 0;
  #draft = "";

  get text(): string {
    return this.#chars.join("");
  }

  get empty(): boolean {
    return this.#chars.length === 0;
  }

  set(text: string): void {
    this.#chars = Array.from(text);
    this.#cursor = this.#chars.length;
  }

  clear(): void {
    this.set("");
  }

  /** Clears the buffer and records its text in history. */
  take(): string {
    const text = this.text;
    if (text.trim() !== "" && this.#history.at(-1) !== text) this.#history.push(text);
    this.#historyIndex = this.#history.length;
    this.clear();
    return text;
  }

  insert(text: string): void {
    const chars = Array.from(text.replace(/\r\n?/g, "\n"));
    this.#chars.splice(this.#cursor, 0, ...chars);
    this.#cursor += chars.length;
  }

  backspace(): void {
    if (this.#cursor === 0) return;
    this.#chars.splice(--this.#cursor, 1);
  }

  delete(): void {
    this.#chars.splice(this.#cursor, 1);
  }

  left(): void {
    this.#cursor = Math.max(0, this.#cursor - 1);
  }

  right(): void {
    this.#cursor = Math.min(this.#chars.length, this.#cursor + 1);
  }

  wordLeft(): void {
    this.#cursor = this.#wordStart();
  }

  wordRight(): void {
    let end = this.#cursor;
    while (end < this.#chars.length && /\s/.test(this.#chars[end] ?? "")) end++;
    while (end < this.#chars.length && !/\s/.test(this.#chars[end] ?? "")) end++;
    this.#cursor = end;
  }

  home(): void {
    this.#cursor = this.#lineStart();
  }

  end(): void {
    const next = this.#chars.indexOf("\n", this.#cursor);
    this.#cursor = next === -1 ? this.#chars.length : next;
  }

  /** Moves to the previous line, keeping the column; returns false on the first line. */
  up(): boolean {
    const start = this.#lineStart();
    if (start === 0) return false;
    const column = this.#cursor - start;
    const previousStart = this.#lineStart(start - 1);
    this.#cursor = Math.min(previousStart + column, start - 1);
    return true;
  }

  /** Moves to the next line, keeping the column; returns false on the last line. */
  down(): boolean {
    const next = this.#chars.indexOf("\n", this.#cursor);
    if (next === -1) return false;
    const column = this.#cursor - this.#lineStart();
    const after = this.#chars.indexOf("\n", next + 1);
    this.#cursor = Math.min(next + 1 + column, after === -1 ? this.#chars.length : after);
    return true;
  }

  killToStart(): void {
    const start = this.#lineStart();
    this.#chars.splice(start, this.#cursor - start);
    this.#cursor = start;
  }

  killToEnd(): void {
    const next = this.#chars.indexOf("\n", this.#cursor);
    const end = next === -1 ? this.#chars.length : next;
    this.#chars.splice(this.#cursor, end - this.#cursor);
  }

  deleteWordBack(): void {
    const start = this.#wordStart();
    this.#chars.splice(start, this.#cursor - start);
    this.#cursor = start;
  }

  /**
   * The word that ends at the cursor when it starts with `trigger`, such as an
   * `@` mention being typed: where it starts, and its text after the trigger.
   */
  token(trigger: string): { start: number; query: string } | null {
    if (/\S/.test(this.#chars[this.#cursor] ?? "")) return null;
    let start = this.#cursor;
    while (start > 0 && /\S/.test(this.#chars[start - 1] ?? "")) start--;
    if (this.#chars[start] !== trigger) return null;
    return { start, query: this.#chars.slice(start + 1, this.#cursor).join("") };
  }

  /** Replaces the text from `start` to the cursor, leaving the cursor after it. */
  replaceToken(start: number, text: string): void {
    const chars = Array.from(text);
    this.#chars.splice(start, this.#cursor - start, ...chars);
    this.#cursor = start + chars.length;
  }

  /** Moves through history when the buffer is a single line; returns false otherwise. */
  historyUp(): boolean {
    if (this.#chars.includes("\n") || this.#historyIndex === 0) return false;
    if (this.#historyIndex === this.#history.length) this.#draft = this.text;
    this.set(this.#history[--this.#historyIndex] ?? "");
    return true;
  }

  historyDown(): boolean {
    if (this.#chars.includes("\n") || this.#historyIndex >= this.#history.length) return false;
    this.#historyIndex++;
    this.set(
      this.#historyIndex === this.#history.length
        ? this.#draft
        : (this.#history[this.#historyIndex] ?? ""),
    );
    return true;
  }

  /**
   * Lays the buffer out in rows of at most `width` columns, each starting with
   * `prefix`, wrapping long lines at spaces where it can. Returns the rows and
   * the cursor's position.
   */
  layout(prefix: string, width: number, mask = false): { rows: string[]; cursor: CursorPosition } {
    const lead = visibleWidth(prefix);
    const room = Math.max(1, width - lead);
    const chars = this.#chars.map((char) =>
      char === "\n" ? char : mask ? "•" : char === "\t" ? " " : char,
    );
    const sizes = chars.map((char) => charWidth(char.codePointAt(0) ?? 0));
    /** Character ranges per row; `hard` when the row ends at a newline or the end. */
    const ranges: { start: number; end: number; hard: boolean }[] = [];
    let start = 0;
    let used = 0;
    let space = -1;
    for (let index = 0; index <= chars.length; index++) {
      if (index === chars.length || chars[index] === "\n") {
        ranges.push({ start, end: index, hard: true });
        start = index + 1;
        used = 0;
        space = -1;
        continue;
      }
      const size = sizes[index] ?? 1;
      if (used + size > room && index > start) {
        const end = space >= start ? space + 1 : index;
        ranges.push({ start, end, hard: false });
        used = 0;
        for (let carried = end; carried < index; carried++) used += sizes[carried] ?? 1;
        start = end;
        space = -1;
      }
      used += size;
      if (chars[index] === " ") space = index;
    }

    const rows = ranges.map((range) => prefix + chars.slice(range.start, range.end).join(""));
    // At a soft break, the cursor belongs at the start of the next row.
    const row = Math.max(
      0,
      ranges.findIndex(
        (range) =>
          this.#cursor >= range.start &&
          (this.#cursor < range.end || (this.#cursor === range.end && range.hard)),
      ),
    );
    const range = ranges[row];
    let column = lead;
    for (let index = range?.start ?? 0; index < this.#cursor; index++) column += sizes[index] ?? 1;
    if (column >= width && row === ranges.length - 1) {
      rows.push(prefix);
      return { rows, cursor: { row: row + 1, column: lead } };
    }
    return { rows, cursor: { row, column: Math.min(column, width - 1) } };
  }

  #wordStart(): number {
    let start = this.#cursor;
    while (start > 0 && /\s/.test(this.#chars[start - 1] ?? "")) start--;
    while (start > 0 && !/\s/.test(this.#chars[start - 1] ?? "")) start--;
    return start;
  }

  #lineStart(from = this.#cursor): number {
    // A negative start index would make lastIndexOf search from the end.
    if (from === 0) return 0;
    const previous = this.#chars.lastIndexOf("\n", from - 1);
    return previous === -1 ? 0 : previous + 1;
  }
}

/** Applies a line-editing key to `editor`; returns false for keys it does not handle. */
export function applyEditingKey(editor: Editor, key: Key): boolean {
  if (key.ctrl) {
    switch (key.name) {
      case "a":
        editor.home();
        return true;
      case "e":
        editor.end();
        return true;
      case "u":
        editor.killToStart();
        return true;
      case "k":
        editor.killToEnd();
        return true;
      case "w":
        editor.deleteWordBack();
        return true;
      case "b":
        editor.left();
        return true;
      case "f":
        editor.right();
        return true;
      case "left":
        editor.wordLeft();
        return true;
      case "right":
        editor.wordRight();
        return true;
      case "h":
        editor.backspace();
        return true;
    }
    return false;
  }
  if (key.meta) {
    if (key.name === "backspace") editor.deleteWordBack();
    else if (key.name === "b" || key.name === "left") editor.wordLeft();
    else if (key.name === "f" || key.name === "right") editor.wordRight();
    else return false;
    return true;
  }
  switch (key.name) {
    case "backspace":
      editor.backspace();
      return true;
    case "delete":
      editor.delete();
      return true;
    case "left":
      editor.left();
      return true;
    case "right":
      editor.right();
      return true;
    case "home":
      editor.home();
      return true;
    case "end":
      editor.end();
      return true;
  }
  if (key.text !== "") {
    editor.insert(key.text);
    return true;
  }
  return false;
}
