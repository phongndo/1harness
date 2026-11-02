import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { CellSize } from "./images.ts";

// SVG to PNG for the pictures the transcript draws itself, diagrams and
// equations: resvg (Rust, as WASM, so nothing native to build) loads once, in
// the background, for every kind of figure.

let engine: Promise<boolean> | null = null;

/** Loads resvg's WASM, once; resolves with whether it can draw. */
export function loadResvg(): Promise<boolean> {
  engine ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
      return true;
    } catch {
      return false;
    }
  })();
  return engine;
}

/** An SVG as PNG bytes, its text in `font` where it has text; resvg must have loaded. */
export function rasterize(svg: string, font: Uint8Array | null): Uint8Array {
  return new Resvg(svg, {
    font: font
      ? { fontBuffers: [font], loadSystemFonts: false, defaultFontFamily: "sans-serif" }
      : { loadSystemFonts: false },
  })
    .render()
    .asPng();
}

/** The size an SVG says it is, in its own pixels. */
export function svgSize(svg: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1] ?? "0") || 600;
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1] ?? "0") || width / 2;
  return { width, height };
}

/**
 * An SVG `width` × `height` pixels, drawn at the top left of a transparent
 * canvas a whole number of cells in size, centered in its height, so the
 * terminal shows it pixel for pixel rather than scaling it.
 */
export function onCells(svg: string, width: number, height: number, cell: CellSize): string {
  const canvasWidth = Math.max(1, Math.ceil(width / cell.width - 1e-6)) * cell.width;
  const canvasHeight = Math.max(1, Math.ceil(height / cell.height - 1e-6)) * cell.height;
  const top = (canvasHeight - height) / 2;
  const inner = svg.replace(/<svg\b[^>]*>/, (open) =>
    open
      .replace(/\swidth="[^"]*"/, ` width="${width}"`)
      .replace(/\sheight="[^"]*"/, ` height="${height}"`)
      .replace(/^<svg/, `<svg x="0" y="${top}"`),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" ` +
    `viewBox="0 0 ${canvasWidth} ${canvasHeight}">${inner}</svg>`
  );
}

/** Fonts tried for figure text when ONEHARNESS_FONT and fontconfig name none. */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

let font: Uint8Array | null | undefined;

/** A font file for figure text: ONEHARNESS_FONT, fontconfig's sans-serif, or a common one; found once. */
export function figureFont(): Uint8Array | null {
  if (font !== undefined) return font;
  const candidates = [process.env["ONEHARNESS_FONT"]];
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
  font = null;
  for (const path of candidates)
    if (path && existsSync(path)) {
      try {
        font = readFileSync(path);
        break;
      } catch {
        // Unreadable; try the next.
      }
    }
  return font;
}
