import { createHash } from "node:crypto";
import type { HostClient } from "../client/client.ts";
import { runsScripts } from "../host/media.ts";
import { FetchCache } from "./cache.ts";
import { FIGURE_NAMES, Figures, type Figure } from "./figures.ts";
import {
  DEFAULT_CELL,
  PLACEHOLDER_LIMIT,
  fit,
  maxImageRows,
  picture,
  pictureRows,
  screenDensity,
  type CellSize,
  type MediaContext,
  type Picture,
  type Shown,
} from "./images.ts";
import type { LivePages } from "./live.ts";
import { isLightTheme, style } from "./theme.ts";
import { visibleWidth, wrap } from "./text.ts";

// The pictures the transcript shows in place of text, where the terminal
// shows images: image files and pages, which the host draws, and figures,
// which the terminal draws itself.

/**
 * Pictures of image files and of pages kept: more than one transcript shows,
 * since one forgotten while its transcript still shows it is fetched again,
 * and the transcript drawn again when it comes.
 */
const PICTURES_KEPT = 256;

/** What the pictures need from the terminal around them. */
export interface PictureHost {
  client: HostClient;
  /** Where the host runs pages with scripts live. */
  live: LivePages;
  /** Whether the host runs pages live, scripts and all. */
  liveHost(): boolean;
  /** The width the transcript is laid out in. */
  columnWidth(): number;
  screenRows(): number;
  /** Something the views wait for came, so they draw again. */
  redraw(): void;
}

/** Lines set in the middle of `columns` together, keeping their alignment; wrapped where too wide. */
function centered(lines: string[], columns: number): string[] {
  const widest = Math.max(0, ...lines.map((line) => visibleWidth(line)));
  if (widest > columns) return lines.flatMap((line) => wrap(line, columns, "  "));
  const indent = " ".repeat(Math.max(0, Math.floor((columns - widest) / 2)));
  return lines.map((line) => indent + line);
}

export class Pictures {
  #host: PictureHost;
  /** Whether the terminal shows images, which it says when asked. */
  graphics = false;
  /** A character cell's size in pixels, which images are sized by. */
  cell: CellSize = DEFAULT_CELL;
  /** Diagrams and equations drawn as pictures; as more can be shown, the views draw again. */
  readonly figures: Figures;
  /** Pictures of image files, by cells and path, as the host sent them. */
  #images = new FetchCache<string, Picture | null>({
    limit: PICTURES_KEPT,
    arrived: (shown) => {
      if (shown) this.#host.redraw();
    },
  });
  /** Pages drawn as pictures, by theme, width, cell size, and content. */
  #pages = new FetchCache<string, Picture | null>({
    limit: PICTURES_KEPT,
    arrived: () => this.#host.redraw(),
  });

  constructor(host: PictureHost) {
    this.#host = host;
    this.figures = new Figures(() => host.redraw());
  }

  /** What the transcript lays pictures out by. */
  media(): MediaContext {
    return {
      graphics: this.graphics,
      cell: this.cell,
      maxRows: maxImageRows(this.#host.screenRows()),
    };
  }

  /**
   * A page's rows, drawn by the host as a picture as wide as `columns`, at
   * the screen's density and in its theme; null for its text, where the
   * terminal shows no pictures or the page cannot be drawn.
   */
  page(html: string, columns: number): { rows: string[]; picture?: Shown; live?: boolean } | null {
    const media = this.media();
    if (!media.graphics) return null;
    const light = isLightTheme();
    const digest = createHash("sha1").update(html).digest("hex");
    const key = `${light ? "light" : "dark"}:${columns}:${media.cell.width}x${media.cell.height}:${digest}`;
    // A page is as tall as its content; it scrolls with the transcript, so it may run past the screen.
    const rows = (shown: Picture) => {
      const size = fit(shown, columns, { ...media, maxRows: PLACEHOLDER_LIMIT });
      return { rows: pictureRows(shown, size), picture: { picture: shown, ...size } };
    };
    // A page with scripts runs live where the host can; one that cannot is drawn once.
    if (this.#host.liveHost() && runsScripts(html)) {
      const live = this.#host.live.open(key, html, this.pageSize(columns), !light);
      if (!live.failed || live.picture) {
        if (!live.picture) return { rows: [style.muted("Starting the page…")], live: true };
        return { ...rows(live.picture), live: true };
      }
    }
    const { width, scale } = this.pageSize(columns);
    const known = this.#pages.get(key, () =>
      this.#host.client
        .call("media.html", { html, width, scale, dark: !light, transparent: true })
        .then((drawn) => picture(Buffer.from(drawn.data, "base64")))
        .catch(() => null),
    );
    if (known === undefined) return { rows: [style.muted("Drawing the page…")] };
    return known && rows(known);
  }

  /**
   * The CSS width a page is drawn at to fill `columns`, and the device pixels
   * per CSS pixel: small cells mean a dense screen, which the page is drawn
   * at, so its text stays legible.
   */
  pageSize(columns: number): { width: number; scale: number } {
    const scale = screenDensity(this.cell);
    return { width: Math.round((columns * this.cell.width) / scale), scale };
  }

  /**
   * An image file's picture, from the host, where the file is: asked for the
   * first time, and the views drawn again once it comes.
   */
  image(path: string): Picture | null | undefined {
    // Fetched again for other cells, as a new font size makes, so it stays sharp.
    return this.#images.get(`${this.cell.width}x${this.cell.height}\0${path}`, () =>
      this.#host.client
        .call("files.image", { path, ...this.#imageBox() })
        .then((found) => (found ? picture(Buffer.from(found.data, "base64")) : null))
        .catch(() => null),
    );
  }

  /** The most pixels an image takes on screen, which the host shrinks one to. */
  #imageBox(): { width: number; height: number } {
    const media = this.media();
    return {
      width: Math.max(1, this.#host.columnWidth() - 4) * media.cell.width,
      height: media.maxRows * media.cell.height,
    };
  }

  /**
   * A figure's rows, centered in the column as a figure is: a picture where
   * the terminal shows images, else text that fits (a diagram in box-drawing
   * characters, an equation in Unicode), else null for its source.
   */
  figure(figure: Figure, columns: number): { rows: string[]; picture?: Shown } | null {
    const media = this.media();
    const renderer = this.figures.renderer(figure.kind);
    if (media.graphics && renderer.available) {
      const drawn = renderer.picture(
        figure.source,
        isLightTheme(),
        columns * media.cell.width,
        media.cell,
      );
      if (drawn === undefined) {
        // Until it is drawn, its text holds its place, or a line saying it is coming.
        const text = figure.kind === "math" ? renderer.text(figure.source) : null;
        if (text) return { rows: centered(text.map(style.soft), columns) };
        return { rows: [style.muted(FIGURE_NAMES[figure.kind].drawing)] };
      }
      if (drawn) {
        const size = fit(drawn, columns, media);
        const indent = " ".repeat(Math.max(0, Math.floor((columns - size.columns) / 2)));
        return {
          rows: pictureRows(drawn, size, indent),
          picture: { picture: drawn, ...size },
        };
      }
    }
    const text = renderer.text(figure.source);
    if (!text) return null;
    const paint = figure.kind === "math" ? style.text : style.soft;
    // A diagram too wide for characters shows its source; an equation's text wraps.
    if (figure.kind === "mermaid" && text.some((line) => visibleWidth(line) > columns)) return null;
    return { rows: centered(text.map(paint), columns) };
  }
}
