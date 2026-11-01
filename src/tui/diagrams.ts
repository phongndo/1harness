import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { renderMermaidASCII } from "beautiful-mermaid";
import { render as renderMermaid } from "pele";
import { picture, type CellSize, type Picture } from "./images.ts";

// Mermaid diagrams as pictures: Pele lays a diagram out as SVG, resvg (Rust,
// as WASM, so nothing native to build) turns it into a PNG, and the
// transcript shows it as an image. A terminal without graphics, or a diagram
// that cannot be drawn, gets beautiful-mermaid's box-drawing version instead.
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

/** The size an SVG says it is, in its own pixels. */
function svgSize(svg: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1] ?? "0") || 600;
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1] ?? "0") || width / 2;
  return { width, height };
}

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
 * An SVG `width` × `height` pixels, drawn at the top left of a transparent
 * canvas a whole number of cells in size, centered in its height.
 */
function onCells(svg: string, width: number, height: number, cell: CellSize): string {
  const canvasWidth = Math.max(1, Math.ceil(width / cell.width - 1e-6)) * cell.width;
  const canvasHeight = Math.max(1, Math.ceil(height / cell.height - 1e-6)) * cell.height;
  const top = (canvasHeight - height) / 2;
  const inner = svg.replace(/<svg\b[^>]*>/, (open) =>
    open
      .replace(/\swidth="[\d.]+"/, ` width="${width}"`)
      .replace(/\sheight="[\d.]+"/, ` height="${height}"`)
      .replace(/^<svg/, `<svg x="0" y="${top}"`),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" ` +
    `viewBox="0 0 ${canvasWidth} ${canvasHeight}">${inner}</svg>`
  );
}

/** Fonts tried for diagram text when ONEHARNESS_FONT and fontconfig name none. */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

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

/** A font file for diagram text: ONEHARNESS_FONT, fontconfig's sans-serif, or a common one. */
function findFont(): Uint8Array | null {
  const named = process.env["ONEHARNESS_FONT"];
  const candidates = [named];
  try {
    candidates.push(
      execFileSync("fc-match", ["-f", "%{file}", "sans-serif"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    // No fontconfig, as on macOS; the usual places follow.
  }
  candidates.push(...FONT_CANDIDATES);
  for (const path of candidates)
    if (path && existsSync(path)) {
      try {
        return readFileSync(path);
      } catch {
        // Unreadable; try the next.
      }
    }
  return null;
}

/**
 * Renders and keeps diagrams. Drawing needs resvg's WASM, which loads once and
 * in the background: until it has, and while a diagram draws, `picture` says
 * so, and `onReady` is called once there is more to show.
 */
export class Diagrams {
  #onReady: () => void;
  #engine: Promise<Uint8Array | null> | null = null;
  #font: Uint8Array | null = null;
  #loaded = false;
  #pictures = new Map<string, Picture | null>();
  #ascii = new Map<string, string[] | null>();

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
    const key = `${light ? "light" : "dark"}\0${width}\0${fill ?? ""}\0${cell.width}x${cell.height}\0${source}`;
    if (this.#pictures.has(key)) return this.#pictures.get(key);
    if (!this.#loaded) {
      void this.#load();
      return undefined;
    }
    let drawn: Picture | null = null;
    try {
      const svg = renderMermaid(source).svg;
      const filled = fillVariables(floating(svg), THEMES[light ? "light" : "dark"]);
      // At the screen's density, as text is (16px cells being 1×), and never wider than the room for it.
      const density = Math.min(3, Math.max(1, Math.round((cell.height / 16) * 4) / 4));
      const natural = svgSize(svg);
      // Filling `width` by `fill` pixels instead, as on the whole screen, it grows to them.
      const scale =
        fill === undefined
          ? Math.min(Math.max(cell.width, width), natural.width * density) / natural.width
          : Math.min(width / natural.width, fill / natural.height);
      const png = new Resvg(onCells(filled, natural.width * scale, natural.height * scale, cell), {
        font: this.#font
          ? {
              fontBuffers: [this.#font],
              loadSystemFonts: false,
              defaultFontFamily: "sans-serif",
            }
          : { loadSystemFonts: false },
      })
        .render()
        .asPng();
      drawn = picture(png);
    } catch {
      // A diagram Pele cannot read, or text with no font to draw it in.
    }
    this.#pictures.set(key, drawn);
    return drawn;
  }

  /** The diagram in box-drawing characters, for a terminal without graphics; null if it cannot be. */
  ascii(source: string): string[] | null {
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

  /** Loads resvg's WASM and a font, once. */
  #load(): Promise<Uint8Array | null> {
    this.#engine ??= (async () => {
      try {
        const require = createRequire(import.meta.url);
        await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
        this.#font = findFont();
        this.#loaded = true;
      } catch {
        // Without the engine, every diagram is drawn in characters.
        this.#loaded = true;
        this.#broken = true;
      }
      this.#onReady();
      return this.#font;
    })();
    return this.#engine;
  }

  /** Whether the engine could not load, so pictures are never drawn. */
  #broken = false;

  get available(): boolean {
    return !this.#broken;
  }
}
