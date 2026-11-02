import type { HostClient } from "../client/client.ts";
import type { LiveFrame, PageEvent } from "../protocol.ts";
import { picture, pngSize, type Picture } from "./images.ts";

// Pages kept running on the host, scripts and all, as the transcript and the
// viewer show them: each is a picture whose frames the host sends while it
// is on screen, and which takes the mouse and keys passed to it.

/** How often a live page on screen is asked for a new frame. */
const LIVE_MS = 150;
/** How often the pages are looked over when none is on screen, to close old ones. */
const REST_MS = 5000;
/** A live page out of sight this long is closed, and opened afresh when seen again. */
const LIVE_IDLE_MS = 120_000;
/**
 * The most pixels a live page's frame may have, and the most bytes of frames
 * sent each second: the terminal decodes and keeps every frame, so a page
 * that runs away must not take the terminal with it.
 */
const LIVE_MAX_PIXELS = 6_000_000;
const LIVE_BYTES_PER_SECOND = 2_000_000;

/** A page kept running on the host, as the transcript and the viewer show it. */
export interface LivePage {
  /** The host's ID for it, once it is open. */
  id: string | null;
  /** Its latest frame; new frames change this picture, so rows showing it stay. */
  picture: Picture | null;
  /** Its viewport in CSS pixels now, and as the transcript shows it, at its density there. */
  css: { width: number; height: number };
  inline: { width: number; height: number; scale: number };
  /** A request is out for it. */
  busy: boolean;
  /** It could not run; it is drawn once instead, or as text. */
  failed: boolean;
  /** When a frame last showed it. */
  seen: number;
}

/** What the live pages need from the terminal around them. */
export interface LiveHost {
  client: HostClient;
  /** Lays out every view again, as a page that changed size needs. */
  redraw(): void;
  /** Draws the screen again soon, as a new frame of the same size needs. */
  schedule(): void;
  warn(text: string): void;
  /** Whether someone may be watching, which pages move only for. */
  focused(): boolean;
}

export class LivePages {
  #host: LiveHost;
  /** By page, width, theme, and cells, and by the picture showing each. */
  #pages = new Map<string, LivePage>();
  #byPicture = new Map<number, LivePage>();
  /** The pages the last frame showed: on screen, and kept moving until a frame does not show them. */
  #shown = new Set<LivePage>();
  #timer: NodeJS.Timeout | null = null;
  /** Bytes of frames sent in the current second, and when that second began. */
  #budget = { since: 0, bytes: 0 };
  #stopped = false;

  constructor(host: LiveHost) {
    this.#host = host;
  }

  /** The live page for `key`, opened on the host at `size` the first time it is asked for. */
  open(key: string, html: string, size: { width: number; scale: number }, dark: boolean): LivePage {
    const known = this.#pages.get(key);
    if (known) return known;
    const { width, scale } = size;
    const page: LivePage = {
      id: null,
      picture: null,
      css: { width, height: 0 },
      inline: { width, height: 0, scale },
      busy: true,
      failed: false,
      seen: Date.now(),
    };
    this.#pages.set(key, page);
    void this.#host.client
      .call("page.open", { html, width, scale, dark })
      .then((frame) => {
        page.id = frame.id;
        page.inline = { width: frame.cssWidth, height: frame.cssHeight, scale };
        this.#frame(page, frame);
        this.#poll();
      })
      .catch(() => {
        page.failed = true;
        this.#host.redraw();
      })
      .finally(() => {
        page.busy = false;
      });
    return page;
  }

  /** The live page a picture shows, if it shows one. */
  showing(shown: Picture): LivePage | undefined {
    return this.#byPicture.get(shown.id);
  }

  /** Passes what the user did to a page, and shows what it did. */
  input(page: LivePage, event: PageEvent): void {
    if (!page.id) return;
    void this.#host.client
      .call("page.input", { id: page.id, event })
      .then((frame) => this.#frame(page, frame))
      .catch(() => {});
  }

  /** Gives a page a new viewport, in CSS pixels at `scale`. */
  resize(page: LivePage, width: number, height: number, scale: number): void {
    if (!page.id) return;
    void this.#host.client
      .call("page.resize", { id: page.id, width, height, scale })
      .then((frame) => this.#frame(page, frame))
      .catch(() => {});
  }

  /** The pages a frame shows are on screen, and kept moving. */
  seen(pictures: readonly (Picture | undefined)[]): void {
    const now = Date.now();
    this.#shown = new Set();
    for (const shown of pictures) {
      const page = shown ? this.#byPicture.get(shown.id) : undefined;
      if (page) {
        page.seen = now;
        this.#shown.add(page);
      }
    }
    if (this.#shown.size > 0) this.#poll();
  }

  /** Asks for no more frames, as the terminal exits. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Takes a page's new frame into the picture showing it, so the rows that
   * show it stay as they are and the terminal is sent the frame alone; a
   * frame of another size lays them out again.
   */
  #frame(page: LivePage, frame: LiveFrame | null): void {
    if (!frame || page.failed) return;
    // A frame too large is not sent: the page stops where it was, as a picture.
    if (frame.width * frame.height > LIVE_MAX_PIXELS) {
      page.failed = true;
      if (page.id) void this.#host.client.call("page.close", { id: page.id }).catch(() => {});
      this.#host.warn("A live page grew too large to keep running; it stays as it was.");
      return;
    }
    this.#budget.bytes += frame.data.length;
    page.css = { width: frame.cssWidth, height: frame.cssHeight };
    const current = page.picture;
    if (!current) {
      const first = picture(Buffer.from(frame.data, "base64"));
      if (!first) return;
      page.picture = first;
      this.#byPicture.set(first.id, page);
      this.#host.redraw();
      return;
    }
    const size = pngSize(Buffer.from(frame.data.slice(0, 64), "base64"));
    if (!size) return;
    const resized = size.width !== current.pixelWidth || size.height !== current.pixelHeight;
    current.data = frame.data;
    current.pixelWidth = size.width;
    current.pixelHeight = size.height;
    current.version = (current.version ?? 0) + 1;
    if (resized) this.#host.redraw();
    else this.#host.schedule();
  }

  /** Asks for new frames of the pages on screen soon; at rest, now and then, to close old ones. */
  #poll(delay = LIVE_MS): void {
    if (this.#timer || this.#stopped || this.#pages.size === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#tick();
    }, delay);
  }

  #tick(): void {
    const now = Date.now();
    let showing = false;
    if (now - this.#budget.since >= 1000) this.#budget = { since: now, bytes: 0 };
    // Pages move only while someone can be watching, and within the second's budget.
    const paused = !this.#host.focused() || this.#budget.bytes >= LIVE_BYTES_PER_SECOND;
    for (const [key, page] of this.#pages) {
      if (this.#shown.has(page)) page.seen = now;
      if (now - page.seen > LIVE_IDLE_MS && !page.busy) {
        this.#drop(key, page);
        continue;
      }
      if (!this.#shown.has(page)) continue;
      showing = true;
      if (page.busy || !page.id || paused || page.failed) continue;
      page.busy = true;
      void this.#host.client
        .call("page.frame", { id: page.id })
        .then((frame) => this.#frame(page, frame))
        .catch(() => this.#drop(key, page))
        .finally(() => {
          page.busy = false;
        });
    }
    this.#poll(showing ? LIVE_MS : REST_MS);
  }

  /** Forgets a page, closed or lost; seen again, it opens afresh. */
  #drop(key: string, page: LivePage): void {
    if (this.#pages.get(key) !== page) return;
    this.#pages.delete(key);
    if (page.picture) this.#byPicture.delete(page.picture.id);
    if (page.id) void this.#host.client.call("page.close", { id: page.id }).catch(() => {});
    this.#host.redraw();
  }
}
