import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { LiveFrame, PageEvent } from "../protocol.ts";
import { MAX_HTML_BYTES, floatingPage } from "./media.ts";

// Pages that keep running: html2term's browser worker holds each one open in
// Chromium, with its scripts, timers, and canvas alive, and draws a frame of
// it when asked, so what moves keeps moving and what takes clicks takes them.
// One worker serves every client; each page belongs to the client that opened
// it and closes when that client leaves.

export interface LiveOptions {
  /** Its viewport's width in CSS pixels. */
  width: number;
  /** Its viewport's height; without one, it is as tall as its content. */
  height?: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  dark: boolean;
}

/** Pages open at once; html2term's worker takes 32. */
const LIMIT = 24;
/** The most pixels a frame may have: more than any screen shows. */
const MAX_FRAME_PIXELS = 8_000_000;
/** How long one request may take, Chromium's start included. */
const TIMEOUT_MS = 20_000;

interface Worker {
  child: ChildProcess;
  pending: Map<number, { resolve: (value: Response) => void; reject: (error: Error) => void }>;
  buffer: string;
  errors: string;
}

type Response = Record<string, unknown>;

function frameOf(response: Response): LiveFrame {
  return {
    data: String(response["png"] ?? ""),
    width: Number(response["width"] ?? 0),
    height: Number(response["height"] ?? 0),
    cssWidth: Number(response["css_width"] ?? 0),
    cssHeight: Number(response["css_height"] ?? 0),
  };
}

function digest(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

export class LivePages {
  #binary: () => string | null;
  #browser: () => boolean;
  #worker: Worker | null = null;
  #next = 1;
  /** Open pages: who opened them, the last frame sent, and when they were last used. */
  #pages = new Map<string, { owner: string; shown: string; used: number }>();

  /** `binary` finds html2term when it is needed; `browser` says whether it has a Chromium. */
  constructor(binary: () => string | null, browser: () => boolean = () => true) {
    this.#binary = binary;
    this.#browser = browser;
  }

  /** Whether pages can run here: html2term and a Chromium for it. */
  get available(): boolean {
    return Boolean(this.#binary()) && this.#browser();
  }

  /** Opens a page for `owner`; its first frame comes with its ID. */
  async open(
    owner: string,
    html: string,
    options: LiveOptions,
  ): Promise<LiveFrame & { id: string }> {
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error("The page is too large to run");
    await this.#makeRoom();
    const response = await this.#call({
      op: "open",
      html: floatingPage(html),
      options: {
        width: Math.max(80, Math.round(options.width)),
        ...(options.height ? { height: Math.max(40, Math.round(options.height)) } : {}),
        scale: options.scale,
        appearance: options.dark ? "dark" : "light",
        transparent: true,
      },
    });
    const id = String(response["document"] ?? "");
    const frame = frameOf(response);
    this.#pages.set(id, { owner, shown: digest(frame.data), used: Date.now() });
    return { id, ...frame };
  }

  /** The page's frame now; null when it shows what was last sent. */
  async frame(id: string): Promise<LiveFrame | null> {
    this.#owned(id);
    // The page says when nothing happened in it, which spares drawing it.
    const response = await this.#call({ op: "frame", document: id, if_changed: true });
    if (response["unchanged"] === true) {
      this.#used(id);
      return null;
    }
    return this.#fresh(id, response);
  }

  /** Passes what the user did to the page; its frame after, or null when nothing changed. */
  async input(id: string, event: PageEvent): Promise<LiveFrame | null> {
    this.#owned(id);
    return this.#fresh(id, await this.#call({ op: "input", document: id, event }));
  }

  /** Gives the page a viewport of another size, and maybe density, as when it is zoomed; its frame then. */
  async resize(id: string, width: number, height: number, scale?: number): Promise<LiveFrame> {
    this.#owned(id);
    const response = await this.#call({
      op: "resize",
      document: id,
      width: Math.max(80, Math.round(width)),
      height: Math.max(40, Math.round(height)),
      ...(scale ? { scale: Math.round(scale * 100) / 100 } : {}),
    });
    return this.#fresh(id, response, true) as LiveFrame;
  }

  async close(id: string): Promise<void> {
    if (!this.#pages.delete(id) || !this.#worker) return;
    await this.#call({ op: "close", document: id }).catch(() => {});
  }

  /** Closes the pages a client opened, as when it leaves. */
  closeOwned(owner: string): void {
    for (const [id, page] of this.#pages) if (page.owner === owner) void this.close(id);
  }

  /** Ends the worker, and every page with it. */
  stop(): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#pages.clear();
    if (!worker) return;
    worker.child.stdin?.end();
    setTimeout(() => worker.child.kill("SIGKILL"), 2000).unref();
  }

  #owned(id: string): void {
    if (!this.#pages.has(id)) throw new Error("The page is closed");
  }

  #used(id: string): void {
    const page = this.#pages.get(id);
    if (page) page.used = Date.now();
  }

  #fresh(id: string, response: Response, force = false): LiveFrame | null {
    const page = this.#pages.get(id);
    if (!page) throw new Error("The page is closed");
    page.used = Date.now();
    const frame = frameOf(response);
    // A page that has grown past any screen is closed rather than drawn on.
    if (frame.width * frame.height > MAX_FRAME_PIXELS) {
      void this.close(id);
      throw new Error("The page grew too large to run");
    }
    const shown = digest(frame.data);
    if (!force && shown === page.shown) return null;
    page.shown = shown;
    return frame;
  }

  /** Closes the page used longest ago while as many are open as may be. */
  async #makeRoom(): Promise<void> {
    while (this.#pages.size >= LIMIT) {
      const [oldest] = [...this.#pages].toSorted(([, a], [, b]) => a.used - b.used);
      if (!oldest) return;
      await this.close(oldest[0]);
    }
  }

  #call(request: Response): Promise<Response> {
    const worker = this.#start();
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        reject(new Error("The page took too long to answer"));
      }, TIMEOUT_MS);
      worker.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const binary = this.#binary();
    if (!binary) throw new Error("html2term is not installed; set HTML2TERM_BIN or put it on PATH");
    const child = spawn(binary, ["serve", "--backend", "browser"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: Worker = { child, pending: new Map(), buffer: "", errors: "" };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      worker.buffer += chunk;
      for (let end = worker.buffer.indexOf("\n"); end !== -1; end = worker.buffer.indexOf("\n")) {
        const line = worker.buffer.slice(0, end);
        worker.buffer = worker.buffer.slice(end + 1);
        let response: Response;
        try {
          response = JSON.parse(line) as Response;
        } catch {
          continue;
        }
        const waiting = worker.pending.get(Number(response["id"]));
        if (!waiting) continue;
        worker.pending.delete(Number(response["id"]));
        if (response["ok"] === false) waiting.reject(new Error(String(response["error"] ?? "")));
        else waiting.resolve(response);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      worker.errors = (worker.errors + chunk.toString()).slice(-2000);
    });
    const ended = (error?: Error) => {
      if (this.#worker === worker) {
        this.#worker = null;
        this.#pages.clear();
      }
      const why =
        error?.message || worker.errors.trim().split("\n").at(-1) || "The page worker stopped";
      for (const waiting of worker.pending.values()) waiting.reject(new Error(why));
      worker.pending.clear();
    };
    child.on("error", ended);
    child.on("close", () => ended());
    child.stdin?.on("error", () => {});
    this.#worker = worker;
    return worker;
  }
}
