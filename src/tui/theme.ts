// fx's monochrome palette: hierarchy comes from 256-color grays and weight, with
// color reserved for links and diff markers. Values follow fx's dark and light themes.

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

function color(role: keyof Palette): (text: string) => string {
  return (text) =>
    colorEnabled && text !== "" ? `\x1b[38;5;${palette[role]}m${text}\x1b[39m` : text;
}

function attribute(open: number, close: number): (text: string) => string {
  return (text) => (text !== "" ? `\x1b[${open}m${text}\x1b[${close}m` : text);
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
