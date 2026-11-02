import { Diagrams } from "./diagrams.ts";
import type { CellSize, Picture } from "./images.ts";
import { Equations } from "./math.ts";

// Figures: blocks of a reply drawn from their source rather than shown as
// it, Mermaid diagrams and display math. Each kind has a renderer that draws
// it as a picture for terminals with graphics, and as text for the rest;
// Markdown finds them, the transcript lays them out, and the viewer draws
// them again on the whole screen. A new kind is one entry here.

export type FigureKind = "mermaid" | "math";

/** A figure as Markdown found it: what kind, and its source. */
export interface Figure {
  kind: FigureKind;
  source: string;
}

/** Draws one kind of figure. */
export interface FigureRenderer {
  /**
   * The figure drawn at most `width` pixels wide on cells of `cell` pixels,
   * or as large as fits `width` by `fill` pixels: undefined while it is
   * still to be drawn, null when it cannot be.
   */
  picture(
    source: string,
    light: boolean,
    width: number,
    cell: CellSize,
    fill?: number,
  ): Picture | null | undefined;
  /** The figure as lines of text, for a terminal without graphics; null to show its source. */
  text(source: string): string[] | null;
  /** False once drawing pictures has failed for good, so only text is tried. */
  readonly available: boolean;
}

/** How each kind is named: in the viewer's title, while drawing, and when its source is copied. */
export const FIGURE_NAMES: Record<FigureKind, { title: string; drawing: string; copied: string }> =
  {
    mermaid: {
      title: "Diagram",
      drawing: "Drawing the diagram…",
      copied: "Copied the diagram's source",
    },
    math: { title: "Equation", drawing: "Typesetting…", copied: "Copied the equation's TeX" },
  };

/** The figure a fenced code block's language makes, or null for code. */
export function fenceFigure(lang: string): FigureKind | null {
  const name = lang.toLowerCase();
  if (name === "mermaid") return "mermaid";
  if (name === "math") return "math";
  return null;
}

/**
 * Every kind's renderer. Each loads what it draws with on first use; when
 * something new can be shown, the views are told once, after the burst of
 * figures that finished together, so they redraw once for all of them.
 */
export class Figures {
  #renderers: Record<FigureKind, FigureRenderer>;
  #pending = false;

  constructor(onReady: () => void) {
    const ready = () => {
      if (this.#pending) return;
      this.#pending = true;
      setImmediate(() => {
        this.#pending = false;
        onReady();
      });
    };
    this.#renderers = { mermaid: new Diagrams(ready), math: new Equations(ready) };
  }

  renderer(kind: FigureKind): FigureRenderer {
    return this.#renderers[kind];
  }
}
