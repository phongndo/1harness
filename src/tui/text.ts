import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

const RESET = "\x1b[0m";

/** Characters that combine with the one before them, taking no column of their own. */
const COMBINING = /^[\p{Mn}\p{Me}]$/u;
const combining = new Map<number, boolean>();

function isCombining(code: number): boolean {
  let known = combining.get(code);
  if (known === undefined) {
    known = COMBINING.test(String.fromCodePoint(code));
    combining.set(code, known);
  }
  return known;
}

export function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code < 0x300) return 1;
  // Combining marks, such as the ones Kitty's image placeholders carry, and
  // zero-width joiners and selectors.
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || isCombining(code)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    WIDE_SYMBOLS.has(code) ||
    (code >= 0x1f000 && code <= 0x1f2ff && wideEnclosed(code))
  ) {
    return 2;
  }
  return 1;
}

/**
 * Symbols below U+3000 that terminals draw two columns wide, as Unicode's
 * East Asian Width gives them: the ones with an emoji look by default, such
 * as ✅ ❌ ⚡ ✨ ⭐ ⏳.
 */
const WIDE_SYMBOLS = new Set<number>(
  [
    [0x231a, 0x231b],
    [0x2329, 0x232a],
    [0x23e9, 0x23ec],
    [0x23f0, 0x23f0],
    [0x23f3, 0x23f3],
    [0x25fd, 0x25fe],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267f, 0x267f],
    [0x2693, 0x2693],
    [0x26a1, 0x26a1],
    [0x26aa, 0x26ab],
    [0x26bd, 0x26be],
    [0x26c4, 0x26c5],
    [0x26ce, 0x26ce],
    [0x26d4, 0x26d4],
    [0x26ea, 0x26ea],
    [0x26f2, 0x26f3],
    [0x26f5, 0x26f5],
    [0x26fa, 0x26fa],
    [0x26fd, 0x26fd],
    [0x2705, 0x2705],
    [0x270a, 0x270b],
    [0x2728, 0x2728],
    [0x274c, 0x274c],
    [0x274e, 0x274e],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27b0, 0x27b0],
    [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c],
    [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
  ].flatMap(([from = 0, to = 0]) => Array.from({ length: to - from + 1 }, (_, at) => from + at)),
);

/** The wide ones among the mahjong, card, and enclosed symbols before U+1F300. */
function wideEnclosed(code: number): boolean {
  return (
    code === 0x1f004 ||
    code === 0x1f0cf ||
    code === 0x1f18e ||
    (code >= 0x1f191 && code <= 0x1f19a) ||
    code >= 0x1f200
  );
}

/** Whether text has only printable characters and line breaks, as `plainText` leaves it. */
function isPlain(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 ? code !== 0x0a : code >= 0x7f && code < 0xa0) return false;
  }
  return true;
}

/**
 * Text from outside, such as a reply or a tool's input, as plain printable
 * text: escape sequences and control characters would move the cursor, so
 * they go, and tabs become spaces.
 */
export function plainText(text: string): string {
  // Most text is plain already, as a reply is; taking it apart to find so is slow.
  return isPlain(text) ? text : printableLines(text, false).join("\n");
}

/** Outside text as `plainText` leaves it, in one line, as a row shows a title. */
export function oneLineText(text: string): string {
  return printableLines(text, false)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * A command's output as `plainText` leaves it, but with `\r` read as a
 * terminal does, so a rewritten line shows what it ends as.
 */
export function outputText(text: string): string {
  return printableLines(text, true).join("\n");
}

function printableLines(text: string, overwrite: boolean): string[] {
  const unified = stripVTControlCharacters(text).replace(/\r\n/g, "\n");
  // Outside a terminal's output, a lone \r is a line break, as old Mac text has it.
  return (overwrite ? unified : unified.replace(/\r/g, "\n")).split("\n").map((line) => {
    const shown = line.includes("\r")
      ? line.slice(line.lastIndexOf("\r", line.length - 2) + 1)
      : line;
    return [...shown.replace(/\t/g, "    ")]
      .filter((char) => {
        const code = char.charCodeAt(0);
        return code >= 0x20 && (code < 0x7f || code >= 0xa0);
      })
      .join("");
  });
}

/** The first line of text with something on it, trimmed, for a one-line preview. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** A path from outside, in one line, relative to `cwd` when inside it. */
export function shownPath(path: string, cwd: string): string {
  const line = oneLineText(path);
  if (!isAbsolute(line)) return line;
  const inside = relative(cwd, line);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : line;
}

/** Terminal columns a string occupies, ignoring escape sequences. */
export function visibleWidth(text: string): number {
  let width = 0;
  const plain = stripVTControlCharacters(text);
  for (let index = 0; index < plain.length;) {
    // Most of what is measured is printable ASCII, a column each.
    const unit = plain.charCodeAt(index);
    if (unit >= 0x20 && unit < 0x7f) {
      width++;
      index++;
      continue;
    }
    const code = plain.codePointAt(index) ?? 0;
    const length = code > 0xffff ? 2 : 1;
    width += widthBefore(code, plain.codePointAt(index + length));
    index += length;
  }
  return width;
}

/**
 * A character's width given the one after it: a symbol followed by U+FE0F,
 * which asks for its emoji look, is drawn two columns wide, as ⚠️ is.
 */
function widthBefore(code: number, next: number | undefined): number {
  const width = charWidth(code);
  return next === 0xfe0f && width === 1 && code >= 0x2000 ? 2 : width;
}

/** Length of the CSI sequence at `index`, or 0. Styled text here only contains SGR. */
function csiLength(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x1b || text[index + 1] !== "[") return 0;
  for (let end = index + 2; end < text.length; end++) {
    const code = text.charCodeAt(end);
    if (code >= 0x40 && code <= 0x7e) return end - index + 1;
    if (code < 0x20 || code > 0x3f) return 0;
  }
  return 0;
}

/** Walks styled text, passing escape sequences and characters separately. */
function scan(
  text: string,
  onEscape: (sequence: string) => void,
  onChar: (char: string, size: number) => boolean | void,
): void {
  let index = 0;
  while (index < text.length) {
    const length = csiLength(text, index);
    if (length > 0) {
      onEscape(text.slice(index, index + length));
      index += length;
      continue;
    }
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    if (onChar(char, widthBefore(code, text.codePointAt(index + char.length))) === false) return;
    index += char.length;
  }
}

/** Styles in effect after a sequence, by the styles before it and the sequence. */
const tracked = new Map<string, string>();
const TRACKED = 1024;

/**
 * The styles in effect after an SGR sequence, as the shortest sequence that
 * sets them again: one entry per kind, so a long styled line does not carry
 * every code it ever set onto each row.
 */
function trackStyle(active: string, sequence: string): string {
  if (!sequence.endsWith("m")) return active;
  // The transcript's few styles meet in few ways, each met again on every row wrapped.
  const key = `${active}\0${sequence}`;
  const known = tracked.get(key);
  if (known !== undefined) return known;
  const state = new Map<string, string>();
  // What is in effect is a run of SGR sequences, each `ESC [ params m`.
  for (const part of active.split("\x1b[").slice(1)) applySgr(state, part.slice(0, -1));
  applySgr(state, sequence.slice(2, -1));
  const after = [...state.values()].map((codes) => `\x1b[${codes}m`).join("");
  if (tracked.size >= TRACKED) tracked.clear();
  tracked.set(key, after);
  return after;
}

/** Applies one SGR's parameters to the styles in effect, by kind. */
function applySgr(state: Map<string, string>, params: string): void {
  const codes = params === "" ? ["0"] : params.split(";");
  for (let index = 0; index < codes.length; index++) {
    const code = Number(codes[index]);
    if (code === 0) state.clear();
    else if (code === 38 || code === 48) {
      // 38;5;n and 38;2;r;g;b set a color; the rest of the sequence is its value.
      const length = codes[index + 1] === "2" ? 5 : 3;
      state.set(code === 38 ? "fg" : "bg", codes.slice(index, index + length).join(";"));
      index += length - 1;
    } else if (code === 39) state.delete("fg");
    else if (code === 49) state.delete("bg");
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
      state.set("fg", String(code));
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
      state.set("bg", String(code));
    else if (code === 22) {
      state.delete("1");
      state.delete("2");
    } else if (code >= 23 && code <= 29) state.delete(String(code - 20));
    else if (code >= 1 && code <= 9) state.set(String(code), String(code));
  }
}

/** Cuts styled text to at most `width` columns, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  let styled = false;
  scan(
    text,
    (sequence) => {
      result += sequence;
      styled = true;
    },
    (char, size) => {
      if (used + size > width - 1) return false;
      result += char;
      used += size;
    },
  );
  return `${result}…${styled ? RESET : ""}`;
}

/**
 * Styled text with columns `from` to before `to` shown selected, in reverse
 * video kept through any style the text sets inside them; past the text's
 * end the selection goes on over blank cells.
 */
export function selectColumns(text: string, from: number, to: number): string {
  if (to <= from) return text;
  const on = "\x1b[7m";
  const off = "\x1b[27m";
  let result = "";
  let column = 0;
  let inside = false;
  scan(
    text,
    (sequence) => {
      result += sequence;
      // A reset inside the selection would end its look.
      if (inside && sequence.endsWith("m")) result += on;
    },
    (char, size) => {
      if (!inside && column >= from && column < to && size > 0) {
        result += on;
        inside = true;
      } else if (inside && column >= to && size > 0) {
        result += off;
        inside = false;
      }
      result += char;
      column += size;
    },
  );
  if (column < to) {
    const start = Math.max(column, from);
    result += " ".repeat(start - column);
    if (!inside) result += on;
    result += " ".repeat(to - start);
    inside = true;
  }
  return inside ? result + off : result;
}

/** The plain text in columns `from` to before `to` of styled text; a wide character goes where it starts. */
export function columnsText(text: string, from: number, to = Infinity): string {
  let result = "";
  let column = 0;
  scan(
    text,
    () => {},
    (char, size) => {
      if (column >= to) return false;
      if (column >= from) result += char;
      column += size;
    },
  );
  return result;
}

/** Pads styled text with spaces to `width` columns. */
export function pad(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** Places `right` at the right edge of a `width`-column row, truncating `left` to fit. */
export function spread(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (right === "" || rightWidth + 2 > width) return truncate(left, width);
  const fitted = truncate(left, width - rightWidth - 2);
  return pad(fitted, width - rightWidth) + right;
}

/**
 * Splits one styled line into rows of at most `width` columns. Prose breaks at
 * spaces where it can; `hard` breaks anywhere, for code. Rows after the first
 * start with `indent`, and styles carry over from row to row.
 */
export function wrap(line: string, width: number, indent = "", hard = false): string[] {
  if (visibleWidth(line) <= width) return [line];
  const indentWidth = visibleWidth(indent);
  // An indent leaves room for a wide character after it.
  if (indentWidth >= width - 1) indent = "";
  const lead = indent === "" ? 0 : indentWidth;
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  let active = "";
  /** The last break opportunity: just after a space in `row`. */
  let breakAt: { index: number; width: number; active: string } | null = null;

  const close = (text: string, styled: string) => rows.push(styled === "" ? text : text + RESET);
  const newRow = () => {
    close(row, active);
    row = indent + active;
    rowWidth = lead;
    breakAt = null;
  };

  scan(
    line,
    (sequence) => {
      row += sequence;
      active = trackStyle(active, sequence);
    },
    (char, size) => {
      if (rowWidth + size > limit) {
        if (char === " " && !hard) {
          newRow();
          return;
        }
        // A word carried to the next row must fit there, past its indent; one that
        // would not is broken here instead, so no row runs wider than `width`.
        if (breakAt && !hard && lead + rowWidth - breakAt.width + size <= limit) {
          const rest = row.slice(breakAt.index);
          close(row.slice(0, breakAt.index).trimEnd(), breakAt.active);
          row = indent + breakAt.active + rest;
          rowWidth = lead + rowWidth - breakAt.width;
          breakAt = null;
        }
        // A row with something on it moves on; the first row has no indent to count.
        if (rowWidth + size > limit && rowWidth > (rows.length === 0 ? 0 : lead)) newRow();
      }
      row += char;
      rowWidth += size;
      if (char === " " && !hard) breakAt = { index: row.length, width: rowWidth, active };
    },
  );
  close(row, active);
  return rows;
}

/** Lines that head a diff: which files, and how; only at the top, before its first change. */
const DIFF_HEADER =
  /^(diff --git |index [\da-f]|--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) |old mode |new mode )/;

/**
 * A diff's lines past its header, the changes themselves: a removed line
 * that reads `--- …` further down is content, not a header.
 */
export function diffBody(lines: readonly string[]): readonly string[] {
  let start = 0;
  while (start < lines.length && DIFF_HEADER.test(lines[start] ?? "")) start++;
  return lines.slice(start);
}
