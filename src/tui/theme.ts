// fx's monochrome palette: hierarchy comes from 256-color grays and weight, with
// color reserved for links, diff markers, and what agents are doing. Values
// follow fx's dark and light themes.

const colorEnabled = process.env["NO_COLOR"] === undefined;

interface Palette {
  /** Primary text: the user marker, inline code, selected rows. */
  strong: number;
  /** Secondary emphasis: the activity label, notice labels, code keywords. */
  text: number;
  /** Tertiary text: notice bodies, code strings and numbers, command flags. */
  soft: number;
  /** Muted text: tool rows, hints, the status line. */
  muted: number;
  rule: number;
  link: number;
  added: number;
  removed: number;
  /** An agent at work. */
  active: number;
  /** An agent waiting on the user. */
  attention: number;
}

const DARK: Palette = {
  strong: 255,
  text: 252,
  soft: 250,
  muted: 245,
  rule: 240,
  link: 75,
  added: 71,
  removed: 167,
  active: 75,
  attention: 179,
};

const LIGHT: Palette = {
  strong: 235,
  text: 238,
  soft: 241,
  muted: 243,
  rule: 250,
  link: 25,
  added: 71,
  removed: 167,
  active: 25,
  attention: 136,
};

let palette = DARK;
let light = false;

/** Switches between the dark and light palettes. Rendered text must be rebuilt afterwards. */
export function setLightTheme(value: boolean): void {
  light = value;
  palette = value ? LIGHT : DARK;
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

function color(role: keyof Palette): (text: string) => string {
  return (text) =>
    colorEnabled && text !== "" ? wrapStyle(`\x1b[38;5;${palette[role]}m`, "\x1b[39m", text) : text;
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
  muted: color("muted"),
  rule: color("rule"),
  link: color("link"),
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
