import type { HostClient } from "../client/client.ts";
import { FIGURE_NAMES, type Figures } from "./figures.ts";
import { picture, type MediaContext, type Picture, type Shown } from "./images.ts";
import { CLICK_MS, WHEEL_ROWS, type InputEvent, type Key } from "./input.ts";
import type { LivePage, LivePages } from "./live.ts";
import { lineStep } from "./menu.ts";
import { pageKey, viewerFrame } from "./pointer.ts";
import { isLightTheme } from "./theme.ts";
import type { Target } from "./transcript.ts";

/** What the viewer needs from the terminal around it. */
export interface ViewerHost {
  client: HostClient;
  live: LivePages;
  figures: Figures;
  screen(): { columns: number; rows: number };
  media(): MediaContext;
  /** The CSS width and density a page in the transcript is drawn at. */
  pageSize(): { width: number; scale: number };
  copy(text: string, said: string): void;
  schedule(): void;
  /** Takes the viewer off the screen. */
  closed(): void;
}

/**
 * A picture shown on the whole screen, opened by a click on it: drawn again
 * sharper for the screen where it has something to draw from, scrolled where
 * it is taller than the screen. A live page shown so takes the mouse and keys.
 */
export class PictureViewer {
  #host: ViewerHost;
  #target: Extract<Target, { kind: "picture" }>;
  #picture: Picture;
  #live: LivePage | undefined;
  /** Where the picture was last drawn, to put the mouse on the page. */
  #layout: { left: number; top: number; columns: number; rows: number; scroll: number } | null =
    null;
  /** The first of its rows on screen, for one taller than the screen. */
  #scroll = 0;
  /** When it opened, so the click that opened it does not close it. */
  #opened = Date.now();
  #closed = false;

  constructor(target: Extract<Target, { kind: "picture" }>, host: ViewerHost) {
    this.#host = host;
    this.#target = target;
    this.#picture = target.picture;
    this.#live = host.live.showing(target.picture);
    if (!this.#live) {
      void this.#sharpen();
      return;
    }
    // A live page keeps its width and is zoomed to the screen's, its viewport as tall as the screen.
    const live = this.#live;
    const room = this.#room();
    const scale = Math.min(4, Math.max(live.inline.scale, room.width / live.inline.width));
    host.live.resize(live, live.inline.width, Math.floor(room.height / scale), scale);
  }

  /** The pixels the picture can take: the screen less a margin and its title. */
  #room(): { width: number; height: number } {
    const { cell } = this.#host.media();
    const screen = this.#host.screen();
    return {
      width: Math.max(1, screen.columns - 4) * cell.width,
      height: Math.max(1, screen.rows - 2) * cell.height,
    };
  }

  /**
   * Draws the picture again at the screen's size, where it has something to
   * draw from: its file, its figure's source, or its page, drawn denser so it
   * reads the same.
   */
  async #sharpen(): Promise<void> {
    const { client, figures } = this.#host;
    const box = this.#room();
    const target = this.#target;
    let sharper: Picture | null | undefined = null;
    try {
      if (target.path) {
        const found = await client.call("files.image", { path: target.path, ...box });
        sharper = found ? picture(Buffer.from(found.data, "base64")) : null;
      } else if (target.figure) {
        sharper = figures
          .renderer(target.figure.kind)
          .picture(
            target.figure.source,
            isLightTheme(),
            box.width,
            this.#host.media().cell,
            box.height,
          );
      } else if (target.html !== undefined) {
        const { width } = this.#host.pageSize();
        const scale = Math.round(Math.min(4, Math.max(1, box.width / width)) * 100) / 100;
        const drawn = await client.call("media.html", {
          html: target.html,
          width,
          scale,
          dark: !isLightTheme(),
          transparent: true,
        });
        sharper = picture(Buffer.from(drawn.data, "base64"));
      }
    } catch {
      // The picture it opened with stays.
    }
    if (sharper && !this.#closed) {
      this.#picture = sharper;
      this.#host.schedule();
    }
  }

  close(): void {
    this.#closed = true;
    this.#host.closed();
    this.#host.schedule();
    // A live page goes back to the transcript's width and height.
    const live = this.#live;
    if (live)
      this.#host.live.resize(live, live.inline.width, live.inline.height, live.inline.scale);
  }

  /** Keys: to a live page, all but esc; otherwise they scroll, copy what it was drawn from, or close. */
  key(key: Key): void {
    const live = this.#live;
    if (live) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) this.close();
      else {
        const event = pageKey(key);
        if (event) this.#host.live.input(live, event);
      }
      return;
    }
    const page = Math.max(1, this.#host.screen().rows - 4);
    const step = lineStep(key);
    if (step) this.#scroll += step;
    else if (key.name === "pageup" || key.name === "pagedown")
      this.#scroll += key.name === "pageup" ? -page : page;
    else if (key.name === "home" || key.text === "g") this.#scroll = 0;
    else if (key.name === "end" || key.text === "G") this.#scroll = Number.MAX_SAFE_INTEGER;
    else if (key.text === "c") {
      const target = this.#target;
      if (target.html !== undefined) this.#host.copy(target.html, "Copied the page's HTML");
      else if (target.figure)
        this.#host.copy(target.figure.source, FIGURE_NAMES[target.figure.kind].copied);
      else if (target.path) this.#host.copy(target.path, "Copied the image's path");
    } else if (
      key.name === "escape" ||
      key.name === "return" ||
      key.name === "space" ||
      key.text === "q" ||
      (key.ctrl && key.name === "c")
    )
      this.close();
    this.#host.schedule();
  }

  /** The wheel scrolls the picture, or a live page's own content. */
  wheel(delta: number): void {
    const live = this.#live;
    if (live)
      this.#host.live.input(live, {
        type: "wheel",
        x: live.css.width / 2,
        y: live.css.height / 2,
        delta_y: delta * 100,
      });
    else this.#scroll += delta * WHEEL_ROWS;
  }

  /** Text pasted goes to a live page; returns whether it took it. */
  paste(text: string): boolean {
    if (!this.#live) return false;
    this.#host.live.input(this.#live, { type: "text", text });
    return true;
  }

  /** The mouse over a live page goes to it; a click elsewhere, or anywhere on a picture, closes the view. */
  mouse(event: Extract<InputEvent, { type: "mouse" }>): void {
    const closes = event.action === "release" && Date.now() - this.#opened > CLICK_MS;
    const live = this.#live;
    if (!live) {
      if (closes) this.close();
      return;
    }
    const layout = this.#layout;
    if (!layout || event.button !== 0) return;
    const across = event.column - layout.left;
    const down = event.row - layout.top;
    const inside = across >= 0 && across < layout.columns && down >= 0 && down < layout.rows;
    if (!inside) {
      if (closes) this.close();
      return;
    }
    this.#host.live.input(live, {
      type: "mouse",
      action:
        event.action === "press"
          ? "mousePressed"
          : event.action === "release"
            ? "mouseReleased"
            : "mouseMoved",
      x: ((across + 0.5) / layout.columns) * live.css.width,
      y: ((down + layout.scroll + 0.5) / layout.rows) * live.css.height,
      buttons: event.action === "release" ? 0 : 1,
    });
  }

  /** The screen's rows: the picture as large as the screen takes, under its name; `toast` says what was just done. */
  render(toast: string | null): { rows: string[]; shown: Shown } {
    const target = this.#target;
    const live = this.#live;
    const what =
      target.html !== undefined
        ? "HTML"
        : target.figure
          ? target.figure.kind === "math"
            ? "TeX"
            : "source"
          : target.path
            ? "path"
            : "";
    const hints = live
      ? "the mouse and keys go to the page · esc closes"
      : `${toast ? `✓ ${toast} · ` : ""}${what ? `c copies the ${what} · ` : ""}esc closes`;
    const shown = live?.picture ?? this.#picture;
    this.#host.live.seen(live ? [shown] : []);
    const frame = viewerFrame(
      shown,
      target.title,
      hints,
      this.#host.screen(),
      this.#host.media(),
      this.#scroll,
      target.html !== undefined && !live,
    );
    this.#scroll = frame.scroll;
    this.#layout = {
      left: frame.left,
      top: frame.top,
      columns: frame.shown.columns,
      rows: frame.shown.rows,
      scroll: frame.scroll,
    };
    return { rows: frame.rows, shown: frame.shown };
  }
}
