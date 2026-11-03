// Colors come from the terminal's own scheme: text in its foreground, muted
// text and rules faint, and accents in its ANSI colors, so 1harness reads as
// the rest of the terminal does, light or dark. Fixed shades of gray drew
// brighter than the scheme's own text.

const colorEnabled = process.env["NO_COLOR"] === undefined;

/** Each role's SGR color: `39` the terminal's foreground, 30–37 its ANSI colors. */
const PALETTE = {
  /** Primary text: inline code, selected rows. */
  strong: 39,
  /** Secondary emphasis: the activity label, notice labels, code keywords. */
  text: 39,
  /** Tertiary text: notice bodies, code strings and numbers, command flags. */
  soft: 39,
  link: 34,
  added: 32,
  removed: 31,
  /** The marker on what you sent, apart from what agents wrote. */
  prompt: 34,
  /** An agent at work. */
  active: 36,
  /** An agent waiting on the user. */
  attention: 33,
} as const;

let light = false;

/** Whether the background is light, which pictures are drawn for. Rendered pictures must be rebuilt afterwards. */
export function setLightTheme(value: boolean): void {
  light = value;
}

export function isLightTheme(): boolean {
  return light;
}

/**
 * Wraps text in an opener and its closer. A style nested inside that ends
 * with the same closer would end this one too, so this one opens again after
 * it: `## Use **foo** now` stays bold after `foo`.
 */
function wrapStyle(open: string, close: string, text: string): string {
  return `${open}${text.replaceAll(close, close + open)}${close}`;
}

/** A line of a diff's changes in its colors, and any other line in `other`. */
export function diffLine(line: string, other: (text: string) => string): string {
  if (line.startsWith("+")) return style.added(line);
  if (line.startsWith("-")) return style.removed(line);
  return other(line);
}

function color(role: keyof typeof PALETTE): (text: string) => string {
  return (text) =>
    colorEnabled && text !== "" ? wrapStyle(`\x1b[${PALETTE[role]}m`, "\x1b[39m", text) : text;
}

function attribute(open: number, close: number): (text: string) => string {
  return (text) => (text !== "" ? wrapStyle(`\x1b[${open}m`, `\x1b[${close}m`, text) : text);
}

export const style = {
  bold: attribute(1, 22),
  faint: attribute(2, 22),
  italic: attribute(3, 23),
  strike: attribute(9, 29),
  strong: color("strong"),
  text: color("text"),
  soft: color("soft"),
  /** Tool rows, hints, the status line: faint, which suits any scheme, as its gray may not. */
  muted: attribute(2, 22),
  rule: attribute(2, 22),
  link: color("link"),
  prompt: color("prompt"),
  added: color("added"),
  removed: color("removed"),
  active: color("active"),
  attention: color("attention"),
};

/** Parses an OSC 11 reply such as `rgb:ffff/ffff/ffff` and reports whether the background is light. */
export function isLightBackground(reply: string): boolean | null {
  const match = /rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return null;
  const [r, g, b] = [match[1], match[2], match[3]].map(
    (hex = "0") => Number.parseInt(hex, 16) / (16 ** hex.length - 1),
  );
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) > 0.5;
}
