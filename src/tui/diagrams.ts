import { renderMermaidASCII } from "beautiful-mermaid";
import { render as renderMermaid } from "pele";
import type { FigureRenderer } from "./figures.ts";
import { BoundedMap } from "./cache.ts";
import { screenDensity, type CellSize, type Picture } from "./images.ts";
import { drawLater, figureFont, loadResvg, onCells, readable, svgSize } from "./svg.ts";

// Mermaid diagrams as pictures: Pele lays a diagram out as SVG, resvg turns
// it into a PNG, and the transcript shows it as an image. A terminal without
// graphics, or a diagram that cannot be drawn, gets beautiful-mermaid's
// box-drawing version instead.
//
// A diagram floats on the terminal: no background of its own, its boxes
// tinted rather than filled, so it suits whatever color the terminal is,
// which few terminals say. It is drawn to fill whole cells, so the terminal
// shows it pixel for pixel rather than scaling it.

/**
 * Pele's colors, as its CSS variables name them, for a dark and a light
 * terminal. Its background color is left for what must be opaque, such as
 * the text on a pie chart's slices.
 */
const THEMES: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--pele-bg": "#1c1c1c",
    "--pele-fg": "#e4e4e4",
    "--pele-muted": "#9e9e9e",
    "--pele-line": "#a8a8a8",
    "--pele-surface": "rgba(255,255,255,0.06)",
    "--pele-surface-alt": "rgba(255,255,255,0.03)",
    "--pele-border": "#6c6c6c",
    "--pele-accent": "#5fafff",
    "--pele-font": "sans-serif",
    "--pele-font-mono": "monospace",
  },
  light: {
    "--pele-bg": "#fafafa",
    "--pele-fg": "#1c1c1c",
    "--pele-muted": "#6c6c6c",
    "--pele-line": "#3a3a3a",
    "--pele-surface": "rgba(0,0,0,0.04)",
    "--pele-surface-alt": "rgba(0,0,0,0.025)",
    "--pele-border": "#9e9e9e",
    "--pele-accent": "#005fd7",
    "--pele-font": "sans-serif",
    "--pele-font-mono": "monospace",
  },
};

/**
 * A Pele SVG made to float: its edge labels' backings, which hide the line
 * under a label by painting the background over it, become gaps cut in the
 * lines instead, and hollow shapes are left unfilled.
 */
export function floating(svg: string): string {
  const gaps: string[] = [];
  let out = svg.replace(/<rect\b([^>]*)\sfill="var\(--_bg\)"([^>]*)\/>/g, (_, before, after) => {
    gaps.push(`<rect${before} fill="#000"${after}/>`);
    return `<rect${before} fill="none"${after}/>`;
  });
  // A state's start and end rings; an entity's markers sit on lines, which they hide.
  out = out.replace(
    /<circle\b(?![^>]*class="pele-marker")([^>]*)\sfill="var\(--_bg\)"/g,
    '<circle$1 fill="none"',
  );
  if (gaps.length === 0) return out;
  const box = /<svg\b[^>]*\sviewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) return out;
  const [, x, y, width, height] = box;
  const mask =
    `<defs><mask id="pele-gaps" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}">` +
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff"/>${gaps.join("")}</mask></defs>`;
  return out
    .replace(/<svg\b[^>]*>/, (open) => open + mask)
    .replace(/<g class="pele-edges"/g, '<g class="pele-edges" mask="url(#pele-gaps)"');
}

/**
 * An SVG with its CSS variables filled in, since resvg reads none: the
 * theme's values for Pele's own, and every other variable from where the SVG
 * declares it, or its fallback.
 */
export function fillVariables(svg: string, theme: Record<string, string>): string {
  const declared = new Map<string, string>();
  for (const match of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+)/g))
    declared.set(match[1] ?? "", (match[2] ?? "").trim());
  const reference = /var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
  const expand = (text: string, depth: number): string =>
    depth > 8
      ? text
      : text.replace(reference, (_, name: string, fallback?: string) => {
          const value = theme[name] ?? declared.get(name) ?? fallback ?? "";
          return expand(value, depth + 1);
        });
  // The declarations go, being resolved; what used them now has the values.
  return expand(svg, 0).replace(/--[\w-]+\s*:[^;"]*;?/g, "");
}

/** Diagrams, and pictures of them, kept: a long reply's worth at a few sizes. */
const KEPT = 64;

/**
 * Renders and keeps diagrams. Drawing needs resvg's WASM, which loads once and
 * in the background: until it has, `picture` says so, and `onReady` is called
 * once there is more to show.
 */
export class Diagrams implements FigureRenderer {
  #onReady: () => void;
  #loading = false;
  #loaded = false;
  #broken = false;
  #pictures = new BoundedMap<string, Picture | null>(KEPT);
  /** Each diagram's layout, by theme and source, which no size changes; null when it has none. */
  #layouts = new BoundedMap<string, { svg: string; width: number; height: number } | null>(KEPT);
  #ascii = new BoundedMap<string, string[] | null>(KEPT);

  constructor(onReady: () => void) {
    this.#onReady = onReady;
  }

  /**
   * The picture of a diagram drawn at most `width` pixels wide, on cells of
   * `cell` pixels, or as large as fits `width` by `fill` pixels: undefined
   * while it is still to be drawn, null when it cannot be.
   */
  picture(
    source: string,
    light: boolean,
    width: number,
    cell: CellSize,
    fill?: number,
  ): Picture | null | undefined {
    if (!this.#loaded) {
      if (!this.#loading) {
        this.#loading = true;
        void loadResvg().then((ready) => {
          this.#loaded = true;
          // Without the engine, every diagram is drawn in characters.
          this.#broken = !ready;
          this.#onReady();
        });
      }
      return undefined;
    }
    if (this.#broken) return null;
    const layout = this.#layout(source, light);
    if (!layout) return null;
    // At the screen's density, as text is, and never wider than the room for it.
    const density = screenDensity(cell);
    // Filling `width` by `fill` pixels instead, as on the whole screen, it grows to them.
    const scale =
      fill === undefined
        ? Math.min(Math.max(cell.width, width), layout.width * density) / layout.width
        : Math.min(width / layout.width, fill / layout.height);
    const drawnWidth = layout.width * scale;
    const drawnHeight = layout.height * scale;
    // Drawn again only for a new size: a wider screen alone changes nothing.
    const key = `${light ? "light" : "dark"}\0${drawnWidth}x${drawnHeight}\0${cell.width}x${cell.height}\0${source}`;
    const known = this.#pictures.get(key);
    if (known !== undefined) return known;
    // Rasterized once sent, so a resize does not draw every diagram off screen again.
    const drawn = drawLater(onCells(layout.svg, drawnWidth, drawnHeight, cell), () => {
      // Drawn in characters instead, once the views draw again.
      this.#pictures.set(key, null);
      this.#onReady();
    });
    this.#pictures.set(key, drawn);
    return drawn;
  }

  /** A diagram laid out as an SVG in the theme's colors, and its size; null when Pele cannot read it. */
  #layout(source: string, light: boolean): { svg: string; width: number; height: number } | null {
    const key = `${light ? "light" : "dark"}\0${source}`;
    const known = this.#layouts.get(key);
    if (known !== undefined) return known;
    let layout = null;
    try {
      const svg = renderMermaid(source).svg;
      const filled = fillVariables(floating(svg), THEMES[light ? "light" : "dark"]);
      if (readable(filled, figureFont())) layout = { svg: filled, ...svgSize(svg) };
    } catch {
      // A diagram Pele cannot read.
    }
    this.#layouts.set(key, layout);
    return layout;
  }

  /** The diagram in box-drawing characters, for a terminal without graphics; null if it cannot be. */
  text(source: string): string[] | null {
    const known = this.#ascii.get(source);
    if (known !== undefined) return known;
    let rows: string[] | null = null;
    try {
      rows = renderMermaidASCII(source).replace(/\s+$/, "").split("\n");
    } catch {
      // Not a diagram it can draw.
    }
    this.#ascii.set(source, rows);
    return rows;
  }

  /** Whether the engine could not load, so pictures are never drawn. */
  get available(): boolean {
    return !this.#broken;
  }
}
