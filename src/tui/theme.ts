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

/** Colors of the panels look: its page and text, and the surfaces on it. */
export interface Surfaces {
  page: string;
  text: string;
  /** Headings, code, and what was sent. */
  strong: string;
  muted: string;
  icon: string;
  /** An icon for what failed. */
  failed: string;
  link: string;
  added: string;
  removed: string;
  active: string;
  attention: string;
  /** Lines across the page, and a quote's at its side. */
  line: string;
  quote: string;
  bubble: string;
  /** Behind code in a line, on the page and in a bubble. */
  chip: string;
  bubbleChip: string;
  code: string;
  codeBorder: string;
  menu: string;
  menuBorder: string;
  highlight: string;
  /** Under what is typed to filter a list. */
  focus: string;
  /** The composer, its border and the light along its top, and its labels. */
  composer: string;
  composerBorder: string;
  composerEdge: string;
  label: string;
  syntax: {
    keyword: string;
    literal: string;
    number: string;
    name: string;
    type: string;
    call: string;
    operator: string;
    mark: string;
  };
  /** Behind selected text. */
  selection: string;
  /** A link to a file. */
  file: string;
}

const SURFACES: Record<"dark" | "light", Surfaces> = {
  dark: {
    page: "#000000",
    text: "#dddddd",
    strong: "#f5f5f5",
    muted: "#a1a1a1",
    icon: "#717171",
    failed: "#7a4a4a",
    link: "#50a2ff",
    added: "#00d492",
    removed: "#ff6467",
    active: "#50a2ff",
    attention: "#ffb900",
    line: "#1a1a1a",
    quote: "#4d4d4d",
    bubble: "#1e1e1e",
    chip: "#191919",
    bubbleChip: "#333333",
    code: "#090909",
    codeBorder: "#090909",
    menu: "#0e0e0e",
    menuBorder: "#1a1a1a",
    highlight: "#1c1c1c",
    focus: "#3b63e0",
    composer: "#0e0e0e",
    composerBorder: "#1a1a1a",
    composerEdge: "#151515",
    label: "#c6c6c6",
    syntax: {
      keyword: "#ff678d",
      literal: "#5ecc71",
      number: "#68cdf2",
      name: "#ffa359",
      type: "#d568ea",
      call: "#9d6afb",
      operator: "#08c0ef",
      mark: "#636363",
    },
    selection: "#26437f",
    file: "#009fb7",
  },
  light: {
    page: "#fcfcfc",
    text: "#2f2f32",
    strong: "#262626",
    muted: "#71717b",
    icon: "#8e8e96",
    failed: "#c98080",
    link: "#1447e6",
    added: "#009966",
    removed: "#e7000b",
    active: "#1447e6",
    attention: "#bb4d00",
    line: "#e4e4e7",
    quote: "#b5b5b5",
    bubble: "#f4f4f5",
    chip: "#e5e5e6",
    bubbleChip: "#dededf",
    code: "#fafafa",
    codeBorder: "#ebebed",
    menu: "#ffffff",
    menuBorder: "#ebebeb",
    highlight: "#f1f1f2",
    focus: "#3b63e0",
    composer: "#ffffff",
    composerBorder: "#ebebeb",
    composerEdge: "#ffffff",
    label: "#3d3d3d",
    syntax: {
      keyword: "#b12251",
      literal: "#106a2b",
      number: "#0b5267",
      name: "#8f4e17",
      type: "#8a2f9e",
      call: "#5b2bc4",
      operator: "#0b5267",
      mark: "#8e8e96",
    },
    selection: "#b4d0ff",
    file: "#0e7490",
  },
};

/** Whether styles draw in the panels look's colors rather than the terminal's own. */
let panels = false;

export function setPanelsLook(value: boolean): void {
  panels = value;
}

/** The panels look's colors for the background there is. */
export function surfaces(): Surfaces {
  return SURFACES[light ? "light" : "dark"];
}

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

/** A hex color as an SGR one, after `38;2` or `48;2`. */
export function rgb(value: string): string {
  return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)).join(";");
}

/** Text in a color of its own, given as hex. */
export function tint(value: string, text: string): string {
  if (!colorEnabled || text === "") return text;
  return wrapStyle(`\x1b[38;2;${rgb(value)}m`, "\x1b[39m", text);
}

/** Text whose chips stand out on a bubble rather than on the page. */
export function onBubble(text: string): string {
  const { chip: page, bubbleChip } = surfaces();
  return text.replaceAll(`\x1b[48;2;${rgb(page)}m`, `\x1b[48;2;${rgb(bubbleChip)}m`);
}

/** Code within a line, on a surface of its own in the panels look. */
export function chip(text: string): string {
  if (!panels || !colorEnabled || text === "") return style.strong(text);
  return wrapStyle(`\x1b[48;2;${rgb(surfaces().chip)}m`, "\x1b[49m", text);
}

/** The panels look's color for a role, where it has one of its own. */
function panelColor(role: keyof typeof PALETTE): string | null {
  const colors = surfaces();
  switch (role) {
    case "link":
    case "added":
    case "removed":
    case "active":
    case "attention":
      return colors[role];
    default:
      return null;
  }
}

function color(role: keyof typeof PALETTE): (text: string) => string {
  return (text) => {
    const own = panels ? panelColor(role) : null;
    if (own) return tint(own, text);
    return colorEnabled && text !== ""
      ? wrapStyle(`\x1b[${PALETTE[role]}m`, "\x1b[39m", text)
      : text;
  };
}

/** Faint, which suits any scheme; in the panels look, the gray it has for it. */
function quiet(role: "muted" | "line"): (text: string) => string {
  const faint = attribute(2, 22);
  return (text) => (panels && colorEnabled ? tint(surfaces()[role], text) : faint(text));
}

function attribute(open: number, close: number): (text: string) => string {
  return (text) => (text !== "" ? wrapStyle(`\x1b[${open}m`, `\x1b[${close}m`, text) : text);
}

export const style = {
  bold: attribute(1, 22),
  faint: quiet("muted"),
  italic: attribute(3, 23),
  strike: attribute(9, 29),
  strong: color("strong"),
  text: color("text"),
  soft: color("soft"),
  /** Tool rows, hints, the status line: faint, which suits any scheme, as its gray may not. */
  muted: quiet("muted"),
  rule: quiet("line"),
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
