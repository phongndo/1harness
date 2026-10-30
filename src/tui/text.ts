import { stripVTControlCharacters } from "node:util";

const RESET = "\x1b[0m";

export function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  // Combining marks and zero-width joiners and selectors.
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f))
    return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal columns a string occupies, ignoring escape sequences. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
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
    if (onChar(char, charWidth(code)) === false) return;
    index += char.length;
  }
}

/** Tracks the SGR state of styled text so it can be reopened on another row. */
function trackStyle(active: string, sequence: string): string {
  if (!sequence.endsWith("m")) return active;
  return sequence === RESET || sequence === "\x1b[m" ? "" : active + sequence;
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
  if (indentWidth >= width) indent = "";
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
        if (breakAt && !hard) {
          const rest = row.slice(breakAt.index);
          close(row.slice(0, breakAt.index).trimEnd(), breakAt.active);
          row = indent + breakAt.active + rest;
          rowWidth = lead + rowWidth - breakAt.width;
          breakAt = null;
        }
        if (rowWidth + size > limit && rowWidth > lead) newRow();
      }
      row += char;
      rowWidth += size;
      if (char === " " && !hard) breakAt = { index: row.length, width: rowWidth, active };
    },
  );
  close(row, active);
  return rows;
}
