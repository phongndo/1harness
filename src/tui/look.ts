import { BoundedMap } from "./cache.ts";
import {
  PLACEHOLDER_LIMIT,
  placeholderCells,
  type CellSize,
  type Picture,
  type Shown,
} from "./images.ts";
import { drawLater, escapeXml, loadResvg } from "./svg.ts";
import { onBubble, surfaces, type Surfaces } from "./theme.ts";
import { pad, visibleWidth } from "./text.ts";

// The panels look: the conversation in a column, on surfaces with rounded
// corners. Text stays text, on cells colored as the surface is; the corners,
// edges, and icons are small pictures under placeholder cells, drawn once and
// used wherever they recur, so a surface of any height sends nothing new.

/** The column's width at most, in CSS pixels. */
const COLUMN = 736;
/** Narrower than this, surfaces would leave too little room for text. */
const MIN_COLUMNS = 36;

/** Takes the pictures rows show, for the screen to send ahead of them. */
export type Collect = (shown: Shown) => void;

/** Lucide's icons (ISC), on a 24px square, by what each marks. */
export const ICONS = {
  command: "m4 17 6-6-6-6M12 19h8",
  edit: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
  read: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  search: "m21 21-4.34-4.34M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16",
  web: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20",
  agent:
    "M12 8V4H8M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2M2 14h2M20 14h2M15 13v2M9 13v2",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  thinking:
    "M12 18V5M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5M17.997 5.125a4 4 0 0 1 2.526 5.77M18 18a4 4 0 0 0 2-7.464M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517M6 18a4 4 0 0 1-2-7.464M6.003 5.125a4 4 0 0 0-2.526 5.77",
  todo: "M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4",
  copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
} as const;

export type IconName = keyof typeof ICONS;

/** The cells an icon takes, and the size it is drawn at in CSS pixels. */
export const ICON_COLUMNS = 2;
const ICON = 15;

/**
 * Device pixels per CSS pixel: whole, unlike the transcript's figures', since
 * a screen is, and a surface's lines are a pixel wide.
 */
export function density(cell: CellSize): number {
  return Math.max(1, Math.round(cell.height / 17));
}

function hex(color: string): [number, number, number] {
  const at = (from: number) => Number.parseInt(color.slice(from, from + 2), 16);
  return [at(1), at(3), at(5)];
}

/** A line on cells colored `fill`, `width` of them, whatever styles it resets within. */
export function onFill(line: string, width: number, fill: string): string {
  const open = `\x1b[48;2;${hex(fill).join(";")}m`;
  const held = line.replaceAll("\x1b[0m", `\x1b[0m${open}`).replaceAll("\x1b[49m", open);
  return `${open}${pad(held, width)}\x1b[49m`;
}

/** An icon's outline, drawn `size` square. */
export function icon(path: string, left: number, top: number, size: number, color: string): string {
  return (
    `<g transform="translate(${left} ${top}) scale(${size / 24})" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></g>`
  );
}

/** A rectangle's outline with its top corners rounded, or its bottom ones. */
function capPath(
  width: number,
  height: number,
  radius: number,
  top: boolean,
  inset: number,
): string {
  const right = width - inset;
  const r = Math.max(0, radius - inset);
  return top
    ? `M${inset} ${height}V${inset + r}a${r} ${r} 0 0 1 ${r} -${r}H${right - r}a${r} ${r} 0 0 1 ${r} ${r}V${height}z`
    : `M${inset} 0V${height - inset - r}a${r} ${r} 0 0 0 ${r} ${r}H${right - r}a${r} ${r} 0 0 0 ${r} -${r}V0z`;
}

export interface Surface {
  fill: string;
  border?: string;
  radius: number;
}

export interface LookHost {
  cell: () => CellSize;
  graphics: () => boolean;
  /** The look can be drawn now, or cannot any longer: all of it is laid out again. */
  redraw: () => void;
}

export class Look {
  #host: LookHost;
  #ready = false;
  #tiles = new BoundedMap<string, Shown>(256);

  constructor(host: LookHost) {
    this.#host = host;
    void loadResvg().then((ready) => {
      this.#ready = ready;
      if (ready) host.redraw();
    });
  }

  /** Whether it can be drawn: the terminal shows pictures, and resvg draws them. */
  get ready(): boolean {
    return this.#ready && this.#host.graphics();
  }

  get colors(): Surfaces {
    return surfaces();
  }

  get cell(): CellSize {
    return this.#host.cell();
  }

  /** Whether a screen or column `width` wide has room for it. */
  fits(width: number): boolean {
    return this.ready && width >= MIN_COLUMNS;
  }

  /** The column on a screen `width` wide: where it starts and how wide it is. */
  column(width: number): { left: number; width: number } {
    if (!this.fits(width)) return { left: 0, width };
    const cell = this.cell;
    const most = Math.floor((COLUMN * density(cell)) / cell.width);
    const columns = Math.min(width, Math.max(MIN_COLUMNS, most), PLACEHOLDER_LIMIT);
    return { left: Math.floor((width - columns) / 2), width: columns };
  }

  /** A picture a whole number of cells in size, drawn in CSS pixels, kept by `key` and its colors. */
  tile(
    key: string,
    columns: number,
    rows: number,
    draw: (width: number, height: number) => string,
  ): Shown {
    const cell = this.cell;
    const scale = density(cell);
    const pixels = { width: columns * cell.width, height: rows * cell.height };
    const full = `${key}:${columns}x${rows}:${cell.width}x${cell.height}:${scale}:${this.colors.page}`;
    let shown = this.#tiles.get(full);
    if (!shown) {
      const width = pixels.width / scale;
      const height = pixels.height / scale;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.width}" height="${pixels.height}" viewBox="0 0 ${width} ${height}">${draw(width, height)}</svg>`;
      shown = { picture: this.draw(svg), columns, rows };
    }
    // Set again, so those in use are the last forgotten.
    this.#tiles.set(full, shown);
    return shown;
  }

  draw(svg: string): Picture {
    return drawLater(svg, () => {
      this.#ready = false;
      this.#host.redraw();
    });
  }

  /** A row that closes a surface at its top or bottom, with its rounded corners. */
  cap(
    edge: "top" | "bottom",
    surface: Surface,
    columns: number,
    collect: Collect | undefined,
  ): string {
    const { fill, border, radius } = surface;
    const shown = this.tile(
      `cap:${edge}:${fill}:${border}:${radius}`,
      columns,
      1,
      (width, height) => {
        const r = Math.min(radius, height);
        const shape = (inset: number, color: string) =>
          `<path d="${capPath(width, height, r, edge === "top", inset)}" fill="${color}"/>`;
        return border ? shape(0, border) + shape(1, fill) : shape(0, fill);
      },
    );
    collect?.(shown);
    return placeholderCells(shown.picture, 0, 0, columns);
  }

  /** A row of a bordered surface: its sides, and `line` on its fill between them. */
  body(line: string, surface: Surface, columns: number, collect: Collect | undefined): string {
    const { fill, border } = surface;
    if (!border) return onFill(line, columns, fill);
    const side = (right: boolean) => {
      const shown = this.tile(`side:${right}:${fill}:${border}`, 1, 1, (width, height) => {
        const at = right ? width - 1 : 0;
        return `<rect width="${width}" height="${height}" fill="${fill}"/><rect x="${at}" width="1" height="${height}" fill="${border}"/>`;
      });
      collect?.(shown);
      return placeholderCells(shown.picture, 0, 0, 1);
    };
    return side(false) + onFill(line, columns - 2, fill) + side(true);
  }

  /** A line marked out on a surface, as a list's chosen row is: rounded at both ends. */
  chosen(line: string, columns: number, fill: string, collect: Collect | undefined): string {
    const { highlight } = this.colors;
    const end = (right: boolean) => {
      const shown = this.tile(`chosen:${right}:${fill}:${highlight}`, 1, 1, (width, height) => {
        const radius = Math.min(6, width);
        const path = right
          ? `M0 0H${width - radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}V${height - radius}a${radius} ${radius} 0 0 1 -${radius} ${radius}H0z`
          : `M${width} 0H${radius}a${radius} ${radius} 0 0 0 -${radius} ${radius}V${height - radius}a${radius} ${radius} 0 0 0 ${radius} ${radius}H${width}z`;
        return `<rect width="${width}" height="${height}" fill="${fill}"/><path d="${path}" fill="${highlight}"/>`;
      });
      collect?.(shown);
      return placeholderCells(shown.picture, 0, 0, 1);
    };
    return end(false) + onFill(line, columns - 2, highlight) + end(true);
  }

  /** A line across a bordered surface. */
  divide(surface: Surface, columns: number, color: string, collect: Collect | undefined): string {
    const { fill, border } = surface;
    const shown = this.tile(`divide:${fill}:${border}:${color}`, columns, 1, (width, height) => {
      const middle = Math.floor(height / 2);
      const side = (at: number) =>
        `<rect x="${at}" width="1" height="${height}" fill="${border ?? fill}"/>`;
      return `<rect width="${width}" height="${height}" fill="${fill}"/>${side(0)}${side(width - 1)}<rect x="12" y="${middle}" width="${width - 24}" height="1" fill="${color}"/>`;
    });
    collect?.(shown);
    return placeholderCells(shown.picture, 0, 0, columns);
  }

  /** A line across the column, as under what a turn did. */
  rule(columns: number, collect: Collect | undefined): string {
    const shown = this.tile("rule", columns, 1, (width, height) => {
      return `<rect y="${Math.floor(height / 2)}" width="${width}" height="1" fill="${this.colors.line}"/>`;
    });
    collect?.(shown);
    return placeholderCells(shown.picture, 0, 0, columns);
  }

  /** An icon's cells, which a row starts with; `failed` dims it red. */
  icon(name: IconName, collect: Collect | undefined, failed = false, fill?: string): string {
    const color = failed ? this.colors.failed : this.colors.icon;
    const shown = this.tile(`icon:${name}:${color}:${fill}`, ICON_COLUMNS, 1, (width, height) => {
      const size = Math.min(ICON, width, height);
      const ground = fill ? `<rect width="${width}" height="${height}" fill="${fill}"/>` : "";
      return ground + icon(ICONS[name], (width - size) / 2, (height - size) / 2, size, color);
    });
    collect?.(shown);
    return placeholderCells(shown.picture, 0, 0, ICON_COLUMNS);
  }

  /** The rows over a code block: its corners, its language, and the mark that says it copies. */
  codeHead(lang: string, columns: number, collect: Collect | undefined): string[] {
    const { code, codeBorder, muted } = this.colors;
    const rows = 2;
    const shown = this.tile(`code:${lang}:${codeBorder}`, columns, rows, (width, height) => {
      const shape = (inset: number, color: string) =>
        `<path d="${capPath(width, height, 8, true, inset)}" fill="${color}"/>`;
      const ground = codeBorder === code ? shape(0, code) : shape(0, codeBorder) + shape(1, code);
      const label = lang
        ? `<text x="15" y="${height / 2 + 4}" font-size="12" font-family="sans-serif" fill="${muted}">${escapeXml(lang)}</text>`
        : "";
      return ground + label + icon(ICONS.copy, width - 30, height / 2 - 7, 14, muted);
    });
    collect?.(shown);
    return Array.from({ length: rows }, (_, row) =>
      placeholderCells(shown.picture, row, 0, columns),
    );
  }

  codeSurface(): Surface {
    const { code, codeBorder } = this.colors;
    return { fill: code, radius: 8, ...(codeBorder === code ? {} : { border: codeBorder }) };
  }

  menuSurface(): Surface {
    return { fill: this.colors.menu, border: this.colors.menuBorder, radius: 16 };
  }

  /** Cells a list gives up on each side, so it sits in from the composer it opens over. */
  static readonly POPOVER_INSET = 3;

  /** Rows on a surface that opens over the composer, which its bottom meets. */
  popover(lines: readonly string[], width: number, collect: Collect | undefined): string[] {
    const columns = Math.max(MIN_COLUMNS - Look.POPOVER_INSET * 2, width - Look.POPOVER_INSET * 2);
    const surface = this.menuSurface();
    const lead = " ".repeat(Look.POPOVER_INSET);
    return [
      lead + this.cap("top", surface, columns, collect),
      ...lines.map((line) => lead + this.body(line, surface, columns, collect)),
    ];
  }

  /** The columns a popover's lines have between its sides. */
  popoverInner(width: number): number {
    return Math.max(MIN_COLUMNS - Look.POPOVER_INSET * 2, width - Look.POPOVER_INSET * 2) - 2;
  }
}

/** What someone said, on a surface of its own at the right of the column. */
export function bubbleRows(
  lines: readonly string[],
  width: number,
  look: Look,
  collect: Collect | undefined,
): string[] {
  const surface: Surface = { fill: look.colors.bubble, radius: 16 };
  const columns = Math.min(width, Math.max(4, ...lines.map((line) => visibleWidth(line) + 4)));
  const lead = " ".repeat(width - columns);
  return [
    lead + look.cap("top", surface, columns, collect),
    ...lines.map((line) => lead + onFill(`  ${onBubble(line)}`, columns, surface.fill)),
    lead + look.cap("bottom", surface, columns, collect),
  ];
}

/** The most columns a bubble's text takes of a column `width` wide. */
export function bubbleInner(width: number): number {
  return Math.max(10, Math.floor(width * 0.8) - 4);
}
