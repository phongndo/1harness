// What the mouse does in the transcript: text selected by dragging or by a
// double or triple click, shown in reverse video and copied as plain text,
// and the whole-screen view a picture opens in when clicked.

import { PLACEHOLDER, PLACEHOLDER_LIMIT, fit, pictureRows, type MediaContext } from "./images.ts";
import type { PageEvent } from "../protocol.ts";
import type { Picture, Shown } from "./images.ts";
import { CLICK_MS, type InputEvent, type Key } from "./input.ts";
import { style } from "./theme.ts";
import { charWidth, columnsText, selectColumns, spread, truncate, visibleWidth } from "./text.ts";

/** A place in the transcript: a row counted from its first, and a column on screen. */
export interface Point {
  row: number;
  column: number;
}

/** Text selected with the mouse: from where the button went down to where it is, both included. */
export interface Selection {
  anchor: Point;
  head: Point;
}

/** A selection's ends, the earlier first. */
export function ordered(selection: Selection): [Point, Point] {
  const { anchor, head } = selection;
  const forward =
    anchor.row < head.row || (anchor.row === head.row && anchor.column <= head.column);
  return forward ? [anchor, head] : [head, anchor];
}

/** Whether a row shows a picture, whose cells are no text to select. */
function showsPicture(row: string): boolean {
  return row.includes(PLACEHOLDER);
}

/**
 * Rows with what of them a selection covers shown selected; `top` is the
 * first row's place in the transcript, and `width` how far a row reaches.
 */
export function paintSelection(
  rows: readonly string[],
  selection: Selection,
  top: number,
  width: number,
): string[] {
  const [start, end] = ordered(selection);
  return rows.map((row, index) => {
    const at = top + index;
    if (at < start.row || at > end.row || showsPicture(row)) return row;
    const from = at === start.row ? start.column : 0;
    const to = at === end.row ? end.column + 1 : width;
    return selectColumns(row, from, Math.min(width, to));
  });
}

/**
 * The text a selection covers, given the transcript's rows from its first to
 * its last: each row's selected columns, without the indent they all share,
 * the marker user messages have, or pictures.
 */
export function selectedText(lines: readonly string[], selection: Selection): string {
  const [start, end] = ordered(selection);
  const parts: { text: string; whole: boolean }[] = [];
  for (const [index, line] of lines.entries()) {
    if (showsPicture(line)) continue;
    const from = index === 0 ? start.column : 0;
    const to = index === lines.length - 1 ? end.column + 1 : Infinity;
    parts.push({ text: columnsText(line, from, to).replace(/\s+$/, ""), whole: from === 0 });
  }
  // A message the user wrote is marked on each row; what they wrote is under it.
  const rows = lines.filter((line) => !showsPicture(line)).map((line) => columnsText(line, 0));
  if (rows.length > 0 && rows.every((row) => row.trim() === "" || /^\s*┃ ?/.test(row)))
    for (const part of parts) part.text = part.text.replace(/^(\s*)┃ ?/, "$1");
  // A first row taken from partway in still has its indent, which the others share.
  const first = columnsText(lines[0] ?? "", 0);
  const indents = parts
    .filter(({ text }) => text.trim() !== "")
    .map(({ text, whole }) =>
      whole ? text.length - text.trimStart().length : first.length - first.trimStart().length,
    );
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return parts
    .map(({ text, whole }) =>
      whole ? text.slice(Math.min(common, text.length - text.trimStart().length)) : text,
    )
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** The columns of the word under `column` in a row, as a double click takes: a run of anything but spaces. */
export function wordAt(row: string, column: number): { from: number; to: number } | null {
  const cells: string[] = [];
  for (const char of columnsText(row, 0)) {
    const width = charWidth(char.codePointAt(0) ?? 0);
    // A mark goes with the character before it; a wide character takes two cells.
    if (width === 0 && cells.length > 0) cells[cells.length - 1] += char;
    else cells.push(char);
    if (width === 2) cells.push(char);
  }
  const blank = (at: number) => /^\s?$/.test(cells[at] ?? "");
  if (blank(column)) return null;
  let from = column;
  let to = column;
  while (from > 0 && !blank(from - 1)) from--;
  while (to < cells.length - 1 && !blank(to + 1)) to++;
  return { from, to };
}

/** What the mouse needs from the terminal around it. */
export interface MouseHost {
  /** The screen's width, in columns. */
  width(): number;
  /** Scrolls the transcript up by `rows`, or down for fewer than none. */
  scrollBy(rows: number): void;
  /** How many rows the transcript is scrolled up. */
  scrolled(): number;
  /** The transcript's rows from `from` through `to`, however far they are out of view. */
  rows(from: number, to: number): string[];
  /** A click on a screen row, at a column on screen. */
  click(row: number, column: number): void;
  copy(text: string, said: string): void;
  schedule(): void;
}

/**
 * The left button over the transcript: a drag selects its text, copied when
 * the button is let go; a double click takes a word, a third the row. Any
 * other click goes to the host.
 */
export class Mouse {
  #host: MouseHost;
  /** Text selected, or being selected, in the transcript's rows. */
  #selection: Selection | null = null;
  /** Where the button went down, to tell a click from a drag. */
  #press: { row: number; column: number; dragged: boolean; anchor: Point | null } | null = null;
  /** The last clicks, for double ones. */
  #clicks = { at: 0, row: -1, column: -1, count: 0 };
  /** The last frame's transcript rows, and the first one's place in the transcript. */
  #rows: readonly string[] = [];
  #top = 0;

  constructor(host: MouseHost) {
    this.#host = host;
  }

  /** The selection, shown selected until the next key or click. */
  get selection(): Selection | null {
    return this.#selection;
  }

  clear(): void {
    this.#selection = null;
  }

  /** Takes the transcript rows a frame showed, from `top` on, which the mouse goes by. */
  drawn(rows: readonly string[], top: number): void {
    this.#rows = rows;
    this.#top = top;
  }

  event(event: Extract<InputEvent, { type: "mouse" }>): void {
    if (event.button !== 0) return;
    const column = Math.max(0, Math.min(this.#host.width() - 1, event.column));
    const rows = this.#rows.length;
    if (event.action === "press") {
      // A selection starts where the button went down, once it moves.
      const anchor = event.row < rows ? { row: this.#top + event.row, column } : null;
      this.#press = { row: event.row, column: event.column, dragged: false, anchor };
      this.#selection = null;
      this.#host.schedule();
      return;
    }
    const press = this.#press;
    if (event.action === "drag") {
      if (!press?.anchor || rows === 0) return;
      if (!press.dragged && event.row === press.row && event.column === press.column) return;
      press.dragged = true;
      this.#selection ??= { anchor: press.anchor, head: press.anchor };
      // Held past the transcript's top or bottom, it scrolls to take in more.
      if (event.row <= 0) this.#host.scrollBy(1);
      else if (event.row >= rows && this.#host.scrolled() > 0) this.#host.scrollBy(-1);
      const row = Math.max(0, Math.min(rows - 1, event.row));
      this.#selection.head = { row: this.#top + row, column };
      this.#host.schedule();
      return;
    }
    this.#press = null;
    if (press?.dragged && this.#selection) {
      this.#copySelection();
      return;
    }
    this.#selection = null;
    if (!press) return;
    const now = Date.now();
    const last = this.#clicks;
    const again =
      now - last.at < CLICK_MS &&
      last.row === event.row &&
      Math.abs(last.column - event.column) <= 1;
    this.#clicks = {
      at: now,
      row: event.row,
      column: event.column,
      count: again ? last.count + 1 : 1,
    };
    if (this.#clicks.count > 1 && event.row < rows) {
      this.#selectAt(event.row, column, this.#clicks.count > 2);
      return;
    }
    this.#host.click(event.row, column);
  }

  /** Selects and copies the word under a double click, or a triple click's whole row. */
  #selectAt(row: number, column: number, whole: boolean): void {
    const text = this.#rows[row] ?? "";
    const range = whole
      ? { from: 0, to: Math.max(0, visibleWidth(text) - 1) }
      : wordAt(text, column);
    if (!range) return;
    const at = this.#top + row;
    this.#selection = {
      anchor: { row: at, column: range.from },
      head: { row: at, column: range.to },
    };
    this.#copySelection();
  }

  /** Copies the selected text; it stays shown selected until the next key or click. */
  #copySelection(): void {
    const selection = this.#selection;
    if (!selection) return;
    const [start, end] = ordered(selection);
    const text = selectedText(this.#host.rows(start.row, end.row), selection);
    if (!text) {
      this.#selection = null;
      this.#host.schedule();
      return;
    }
    const count = text.split("\n").length;
    this.#host.copy(text, count > 1 ? `Copied ${count} lines` : `Copied “${truncate(text, 48)}”`);
  }
}

/** What the whole-screen view shows: its rows, the picture's placement, and how far it scrolls. */
export interface ViewerFrame {
  rows: string[];
  shown: Shown;
  /** The first of the picture's rows on screen, kept within what it can scroll. */
  scroll: number;
  /** How many of the picture's rows are past the screen, 0 when it fits. */
  more: number;
  /** The screen column and row its first cell on screen is drawn at. */
  left: number;
  top: number;
}

/**
 * A picture on the whole screen, under a line naming it: as large as fits,
 * or, for one taller than the screen that reads down, as a page does, as wide
 * as fits and scrolled to `scroll`.
 */
export function viewerFrame(
  picture: Picture,
  title: string,
  hints: string,
  screen: { columns: number; rows: number },
  media: MediaContext,
  scroll: number,
  tall: boolean,
): ViewerFrame {
  const room = { columns: Math.max(1, screen.columns - 4), rows: Math.max(1, screen.rows - 2) };
  const wide = fit(picture, room.columns, { ...media, maxRows: PLACEHOLDER_LIMIT });
  const size =
    tall && wide.rows > room.rows
      ? wide
      : fit(picture, room.columns, { ...media, maxRows: room.rows });
  const more = Math.max(0, size.rows - room.rows);
  const first = Math.max(0, Math.min(scroll, more));
  const indent = Math.max(0, Math.floor((screen.columns - size.columns) / 2));
  const left = " ".repeat(indent);
  const above = Math.max(0, Math.floor((room.rows - size.rows) / 2));
  const name = `  ${style.text(title)} ${style.muted(`· ${picture.pixelWidth}×${picture.pixelHeight}`)}`;
  const rows = [
    spread(truncate(name, screen.columns - 2), style.muted(`${hints}  `), screen.columns),
  ];
  for (let row = 0; row < above; row++) rows.push("");
  rows.push(...pictureRows(picture, size, left).slice(first, first + room.rows));
  while (rows.length < screen.rows - 1) rows.push("");
  const position = more > 0 ? `${Math.round((first / more) * 100)}% · ↑↓ scroll` : "";
  rows.push(position ? truncate(style.muted(`  ${position}`), screen.columns) : "");
  return { rows, shown: { picture, ...size }, scroll: first, more, left: indent, top: 1 + above };
}

/** Names a live page knows keys by, for the terminal's names of them. */
const PAGE_KEYS: Record<string, string> = {
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: " ",
};

/**
 * A key as a live page takes it: a named key, or one held with a modifier, as
 * a key press; text as text, which fields take.
 */
export function pageKey(key: Key): PageEvent | null {
  // As Chrome counts them: alt 1, ctrl 2, meta 4, shift 8.
  const modifiers = (key.meta ? 1 : 0) | (key.ctrl ? 2 : 0) | (key.shift ? 8 : 0);
  const named = PAGE_KEYS[key.name];
  if (named) return { type: "key", key: named, ...(modifiers ? { modifiers } : {}) };
  if ((key.ctrl || key.meta) && key.name.length === 1)
    return { type: "key", key: key.name, modifiers };
  return key.text ? { type: "text", text: key.text } : null;
}
