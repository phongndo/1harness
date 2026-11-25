import { BoundedMap } from "./cache.ts";
import { placeholderCells, type CellSize, type Picture, type Shown } from "./images.ts";
import { density, icon, onFill, type Look } from "./look.ts";
import { escapeXml, svgTextWidth } from "./svg.ts";
import { surfaces } from "./theme.ts";

// The composer as a panel: a picture under placeholder cells draws its edges
// and controls, and what is typed is text in the cells between them, on the
// panel's color. So typing sends no picture, and the cursor, input methods,
// and the terminal's own selection work as on any text.

/** The panel's measures, in CSS pixels. */
const RADIUS = 16;
const ICON = 16;
/** From the panel's bottom right to the middle of its button, and the button's size. */
const BUTTON_INSET = 25;
const BUTTON = 32;
/** The height under the text: a gap, the button, and the same margin as beside it. */
const CONTROLS_HEIGHT = 55;
/** Where the model's name ends, left of the button. */
const LABEL_INSET = BUTTON_INSET + BUTTON / 2 + 14;
const LABEL_SIZE = 14;

/** Cells the edges take beside the text, which line it up with the controls. */
const EDGE = 2;
/** Lines the panel holds before it grows. */
const MIN_LINES = 2;
const STOP = "#e33c44";

/** Lucide's paperclip and sparkle (ISC), on a 24px square. */
const PAPERCLIP =
  "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551";
const SPARKLE =
  "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z";
const ARROW = "M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5";

/** What a click on the panel does: adds a file, picks a model, sends, or stops the turn. */
export type ComposerAction = "attach" | "model" | "send" | "stop";

/** What the panel's controls show. */
export interface ComposerState {
  model: string | null;
  effort: string | null;
  /** Nothing is typed, so there is nothing to send. */
  empty: boolean;
  /** A turn runs, which the button stops while nothing is typed. */
  busy: boolean;
}

/** The panel at a screen's width: where it starts, and the room text has in it. */
export interface ComposerFrame {
  left: number;
  columns: number;
  inner: number;
}

/** The panel's rows, its picture, and what a click in it does; places are the footer's columns and these rows'. */
export interface ComposerPanel {
  rows: string[];
  /** The rows the text starts on and where it starts, for the cursor. */
  top: number;
  left: number;
  picture: Shown;
  spots: { row: number; rows: number; column: number; columns: number; action: ComposerAction }[];
}

/**
 * A model's name as it reads in a label: the maker's prefix off, its words
 * capitalized, and a version's numbers joined, as `claude-opus-5-5` is Opus 5.5.
 */
export function modelLabel(model: string): string {
  return model
    .slice(model.lastIndexOf("/") + 1)
    .replace(/^(claude|gpt)[- ]/i, "")
    .replace(/-\d{8}$/, "")
    .replace(/(\d)-(?=\d+(\D|$))/g, "$1.")
    .split(/[-\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** A run of the label: regular glyphs thickened to medium, a weight the font may not have. */
function span(text: string, color: string): string {
  return `<tspan fill="${color}" stroke="${color}" stroke-width="0.3">${escapeXml(text)}</tspan>`;
}

export class ComposerBox {
  #look: Look;
  #pictures = new BoundedMap<string, { picture: Picture; spots: ComposerPanel["spots"] }>(16);

  constructor(look: Look) {
    this.#look = look;
  }

  /** The panel's room in a column `width` wide; null where the plain composer is drawn instead. */
  frame(width: number): ComposerFrame | null {
    const { left, width: columns } = this.#look.column(width);
    return this.#look.fits(width) ? { left, columns, inner: columns - EDGE * 2 } : null;
  }

  /** The rows the panel takes beside its lines of text. */
  chrome(): number {
    return 1 + this.#controls();
  }

  #controls(): number {
    const { cell } = this.#look;
    return Math.max(2, Math.round((CONTROLS_HEIGHT * density(cell)) / cell.height));
  }

  /** The panel around `lines`, which are at most the frame's inner width. */
  render(frame: ComposerFrame, lines: readonly string[], state: ComposerState): ComposerPanel {
    const count = Math.max(MIN_LINES, lines.length);
    const rows = 1 + count + this.#controls();
    const { picture, spots } = this.#drawn(frame.columns, rows, state);
    const lead = " ".repeat(frame.left);
    const fill = this.#look.colors.composer;
    const whole = (row: number) => lead + placeholderCells(picture, row, 0, frame.columns);
    const text = Array.from(
      { length: count },
      (_, index) =>
        lead +
        placeholderCells(picture, index + 1, 0, EDGE) +
        onFill(lines[index] ?? "", frame.inner, fill) +
        placeholderCells(picture, index + 1, frame.columns - EDGE, frame.columns),
    );
    return {
      rows: [
        whole(0),
        ...text,
        ...Array.from({ length: rows - 1 - count }, (_, index) => whole(1 + count + index)),
      ],
      top: 1,
      left: frame.left + EDGE,
      picture: { picture, columns: frame.columns, rows },
      spots: spots.map((spot) => ({ ...spot, column: spot.column + frame.left })),
    };
  }

  #drawn(columns: number, rows: number, state: ComposerState) {
    const { cell, colors } = this.#look;
    const key = JSON.stringify([columns, rows, cell, colors.page, state]);
    let drawn = this.#pictures.get(key);
    if (!drawn) {
      const { svg, spots } = composerSvg(columns, rows, cell, state);
      drawn = { picture: this.#look.draw(svg), spots };
    }
    // Set again, so those in use are the last forgotten.
    this.#pictures.set(key, drawn);
    return drawn;
  }
}

/** The panel's picture, a whole number of cells in size, and its controls' places in them. */
export function composerSvg(
  columns: number,
  rows: number,
  cell: CellSize,
  state: ComposerState,
): { svg: string; spots: ComposerPanel["spots"] } {
  const scale = density(cell);
  const pixels = { width: columns * cell.width, height: rows * cell.height };
  const width = pixels.width / scale;
  const height = pixels.height / scale;
  const colors = surfaces();
  const middle = height - BUTTON_INSET;
  const button = width - BUTTON_INSET;
  const stops = state.busy && state.empty;

  const name = state.model ?? "";
  const effort = state.effort ? effortLabel(state.effort) : "";
  const label = [
    name && span(name, colors.label),
    effort && span(`${name ? " " : ""}${effort}`, colors.muted),
  ].join("");
  const labelled = label
    ? `<text xml:space="preserve" font-size="${LABEL_SIZE}" font-family="sans-serif" text-anchor="end"`
    : "";
  const labelWidth = label
    ? svgTextWidth(`${name}${name && effort ? " " : ""}${effort}`, LABEL_SIZE)
    : 0;
  const labelEnd = width - LABEL_INSET;
  const iconLeft = labelEnd - labelWidth - 6 - ICON;

  const glyph = (path: string, left: number, top: number) =>
    icon(path, left, top, ICON, colors.muted);

  const face = stops
    ? `<circle cx="${button}" cy="${middle}" r="${BUTTON / 2}" fill="${STOP}"/><rect x="${button - 4}" y="${middle - 4}" width="8" height="8" rx="1" fill="#fff"/>`
    : // Dimmed while there is nothing to send.
      `<g opacity="${state.empty ? 0.64 : 1}"><circle cx="${button}" cy="${middle}" r="${BUTTON / 2}" fill="url(#send)"/><path transform="translate(${button - 7} ${middle - 7})" d="${ARROW}" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.width}" height="${pixels.height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="send" x1="0.1" y1="0.95" x2="0.55" y2="0.1"><stop stop-color="#34408a"/><stop offset="0.45" stop-color="#171749"/><stop offset="1" stop-color="#11143c"/></linearGradient>` +
    `</defs>` +
    `<rect width="${width}" height="${height}" rx="${RADIUS}" fill="${colors.composerBorder}"/>` +
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${RADIUS - 1}" fill="${colors.composerEdge}"/>` +
    `<path d="M1 ${RADIUS + 1}a${RADIUS - 1} ${RADIUS - 1} 0 0 1 ${RADIUS - 1} -${RADIUS - 1}h${width - 2 * RADIUS}a${RADIUS - 1} ${RADIUS - 1} 0 0 1 ${RADIUS - 1} ${RADIUS - 1}V${height - RADIUS}a${RADIUS - 1} ${RADIUS - 1} 0 0 1 -${RADIUS - 1} ${RADIUS - 1}H${RADIUS}a${RADIUS - 1} ${RADIUS - 1} 0 0 1 -${RADIUS - 1} -${RADIUS - 1}z" fill="${colors.composer}"/>` +
    glyph(PAPERCLIP, 15, middle - 7) +
    (label
      ? glyph(SPARKLE, iconLeft, middle - ICON / 2) +
        `${labelled} x="${labelEnd}" y="${middle + LABEL_SIZE * 0.36}">${label}</text>`
      : "") +
    face +
    `</svg>`;

  const across = (at: number) => Math.floor((at * scale) / cell.width);
  const top = Math.max(0, Math.floor(((middle - BUTTON / 2) * scale) / cell.height));
  const spot = (action: ComposerAction, from: number, to: number) => {
    const column = Math.max(0, across(from));
    return {
      row: top,
      rows: rows - top,
      column,
      columns: Math.min(columns, across(to) + 1) - column,
      action,
    };
  };
  return {
    svg,
    spots: [
      spot(stops ? "stop" : "send", button - BUTTON / 2, button + BUTTON / 2),
      ...(label ? [spot("model", iconLeft - 8, labelEnd + 4)] : []),
      spot("attach", 9, 37),
    ],
  };
}
