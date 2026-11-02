import { execFileSync, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Thread } from "../core/thread.ts";
import { findExecutable } from "../drivers/index.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import type { LivePages } from "./live.ts";

// Pictures the host makes for terminals, through html2term (a Rust tool):
// images shrunk to the size they show at, in any format it reads, and HTML
// rendered to a PNG, by its native engine or, for a page with scripts, a
// headless Chromium. Without html2term, images go as they are when they are
// PNGs, and HTML shows as its source.

/** How long one render may take before it is given up on. */
const TIMEOUT_MS = 20_000;
/** The most a render may write, so a runaway page cannot fill memory. */
const MAX_OUTPUT = 48 * 1024 * 1024;
/** The most HTML a page may be, as html2term takes it. */
export const MAX_HTML_BYTES = 512 * 1024;
/** The largest image `files.image` sends as it is, in bytes. */
const IMAGE_BYTES = 8 * 1024 * 1024;
/** The largest image file html2term is given to shrink. */
const IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
/** How wide `html_preview` draws a page when the agent names no width, in CSS pixels. */
const PREVIEW_WIDTH = 800;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether a page runs scripts: in a script tag, or in a handler such as onclick. */
export function runsScripts(html: string): boolean {
  return /<script\b|<[^>]*\son[a-z]+\s*=/i.test(html);
}

/** What an html2term says it can do; one too old to say can do none of it. */
export interface Capabilities {
  version: string | null;
  features: string[];
  /** The Chromium its live pages and scripted pages would use, if it finds one. */
  browser: string | null;
}

const NONE: Capabilities = { version: null, features: [], browser: null };

export interface HtmlOptions {
  /** The page's width in CSS pixels. */
  width: number;
  /** Device pixels per CSS pixel, for screens with small cells. */
  scale: number;
  dark: boolean;
  /** Leave what the page does not paint clear, rather than the theme's canvas color. */
  transparent?: boolean;
}

/** Runs html2term with `args`, writing `input` to it; resolves with what it wrote. */
function run(binary: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(errors.trim().split("\n").at(-1) || `html2term exited ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export class Media {
  #binary: string | null | undefined;
  #capabilities: Capabilities | undefined;

  /** With `binary`, that html2term, or null for none; else it is looked for when first needed. */
  constructor(binary?: string | null) {
    this.#binary = binary;
  }

  /** html2term's path: HTML2TERM_BIN, or the one on PATH; null when there is none. */
  get binary(): string | null {
    if (this.#binary === undefined)
      this.#binary = process.env["HTML2TERM_BIN"] || findExecutable("html2term");
    return this.#binary;
  }

  /** What html2term can do, asked once; nothing, without one or from one too old to say. */
  get capabilities(): Capabilities {
    if (this.#capabilities) return this.#capabilities;
    const binary = this.binary;
    let found = NONE;
    if (binary)
      try {
        const said = JSON.parse(
          execFileSync(binary, ["capabilities"], {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
          }),
        ) as Partial<Capabilities>;
        found = {
          version: typeof said.version === "string" ? said.version : null,
          features: Array.isArray(said.features) ? said.features.map(String) : [],
          browser: typeof said.browser === "string" ? said.browser : null,
        };
      } catch {
        // Too old to say, or not working: nothing beyond drawing pages and images.
      }
    this.#capabilities = found;
    return found;
  }

  /** An image file as a PNG within a box of pixels, or null when it cannot be read. */
  async image(path: string, width?: number, height?: number): Promise<Buffer | null> {
    const binary = this.binary;
    if (!binary) return null;
    const box = [
      ...(width ? ["--width", String(Math.round(width))] : []),
      ...(height ? ["--height", String(Math.round(height))] : []),
    ];
    try {
      return await run(binary, ["image", path, ...box]);
    } catch {
      return null;
    }
  }

  /**
   * HTML as a PNG as wide as asked and as tall as its content: html2term's own
   * engine, or Chromium for a page with scripts where Chromium is installed.
   */
  async html(html: string, options: HtmlOptions): Promise<Buffer> {
    const binary = this.binary;
    if (!binary) throw new Error("html2term is not installed; set HTML2TERM_BIN or put it on PATH");
    if (Buffer.byteLength(html) > MAX_HTML_BYTES)
      throw new Error("The page is too large to render");
    const { browser, features } = this.capabilities;
    const scripted = runsScripts(html) && browser !== null;
    const args = [
      "render",
      "-",
      "--width",
      String(Math.max(80, Math.round(options.width))),
      "--scale",
      String(options.scale),
      ...(options.dark ? ["--dark"] : []),
      ...(scripted ? ["--backend", "browser"] : []),
    ];
    // One that cannot leave the page clear draws it on its canvas.
    if (!options.transparent || !features.includes("transparent")) return run(binary, args, html);
    return run(binary, [...args, "--transparent"], floatingPage(html));
  }
}

/**
 * A page made to float in the transcript as text does: its own background is
 * not drawn, though its cards and the like keep theirs. Last, so it wins
 * among rules as strong.
 */
export function floatingPage(html: string): string {
  return `${html}\n<style>html,body{background:transparent!important}</style>`;
}

/**
 * A page tool's HTML: given whole as `html`, or as `path`, a file where the
 * thread runs, such as one a script wrote.
 */
async function pageInput(input: Record<string, unknown>, cwd: string): Promise<string> {
  const given = input["html"];
  const path = input["path"];
  let html: string;
  if (typeof given === "string" && given.trim() !== "") html = given;
  else if (typeof path === "string" && path.trim() !== "") {
    const file = resolvePath(cwd, path.trim());
    const size = (await stat(file)).size;
    if (size > MAX_HTML_BYTES) throw new Error(`${path} is over ${MAX_HTML_BYTES / 1024} KB`);
    html = await readFile(file, "utf8");
    if (html.trim() === "") throw new Error(`${path} is empty`);
  } else throw new Error("html or path is required");
  if (Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw new Error(`html is over ${MAX_HTML_BYTES / 1024} KB`);
  return html;
}

/**
 * An image file for a terminal, as base64: shrunk to the size it shows at,
 * from any format html2term reads; else only a PNG, as the terminal shows it,
 * and not one so large it stalls the feed. Null when there is none to send.
 */
export async function fileImage(
  media: Media,
  path: string,
  width?: number,
  height?: number,
): Promise<{ data: string } | null> {
  try {
    const found = await stat(path);
    if (!found.isFile()) return null;
    if (media.binary && found.size <= IMAGE_SOURCE_BYTES) {
      const fitted = await media.image(path, width, height);
      if (fitted && fitted.length <= IMAGE_BYTES) return { data: fitted.toString("base64") };
    }
    if (found.size > IMAGE_BYTES) return null;
    const bytes = await readFile(path);
    const png = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    return png ? { data: bytes.toString("base64") } : null;
  } catch {
    return null;
  }
}

/** What the page tools need of the host. */
export interface PageHost {
  media: Media;
  live: LivePages;
  /** Where the thread a tool call came from runs; throws for one the host does not manage. */
  cwd(thread: Thread): string;
  /** Puts a page in the calling thread's transcript. */
  show(thread: Thread, title: string, html: string): void;
}

/**
 * The tools that put pages in front of the user: `html_render` shows one in
 * the transcript, where each client draws it at its own width, and
 * `html_preview` shows the agent what it will look like.
 */
export function pageTools(host: PageHost): ToolDefinition[] {
  const self = "a self-contained HTML document: inline CSS, SVG, and scripts, no network requests";
  const live = host.live.available
    ? "Its scripts run, in Chromium where 1harness runs: animations and canvases play in the transcript, controls take the user's clicks there, and opened whole it takes their keys too."
    : "Scripts do not run where 1harness runs, which has no Chromium: the page is drawn as its HTML and CSS stand.";
  const source = {
    html: { type: "string", description: "The page" },
    path: {
      type: "string",
      description:
        "A file holding the page instead, where the thread runs: one a script wrote, say, building a chart from real data, which keeps the numbers exact and out of your context",
    },
  };
  return [
    {
      name: "html_render",
      description: `Shows HTML to the user in their terminal's transcript, drawn at its width and as tall as the content: a chart, a table, a diagram, a mockup, a small report, a small interactive tool. The page is ${self}, given as html or as a path. ${live} The page's own background is not drawn: the terminal shows through it, so it sits in the transcript as text does; group things with faint translucent fills, such as rgba(127,127,127,0.1), rather than solid ones. It should read well on a dark background (prefers-color-scheme) and at 600 to 900 pixels wide. Call html_preview first to check how it looks.`,
      inputSchema: {
        type: "object",
        properties: {
          ...source,
          title: { type: "string", description: "A few words naming it, shown under it" },
        },
      },
      execute: async (input, context) => {
        const html = await pageInput(input, host.cwd(context.thread));
        const title =
          typeof input["title"] === "string" && input["title"].trim()
            ? input["title"].trim().slice(0, 120)
            : "Page";
        host.show(context.thread, title, html);
        if (!host.media.binary)
          return "Shown to the user as text: html2term is not installed where 1harness runs, so the page is not drawn.";
        if (runsScripts(html))
          return host.live.available
            ? "Shown live in the transcript: its scripts run, so it moves, and its controls take the user's clicks; opened whole, it takes their keys too."
            : "Shown to the user as text: its scripts need a Chromium where 1harness runs, and there is none.";
        return "Shown to the user in the transcript.";
      },
    },
    {
      name: "html_preview",
      description: `Draws HTML as a PNG and returns it to you, without showing the user, to check a page before html_render: its first frame, for one with scripts. The page is ${self}, given as html or as a path.`,
      inputSchema: {
        type: "object",
        properties: {
          ...source,
          width: {
            type: "number",
            description: `Its width in CSS pixels; ${PREVIEW_WIDTH} by default`,
          },
          dark: {
            type: "boolean",
            description: "Draw it with a dark color scheme; true by default",
          },
        },
      },
      readOnly: true,
      execute: async (input, context) => {
        const html = await pageInput(input, host.cwd(context.thread));
        const width = typeof input["width"] === "number" ? input["width"] : PREVIEW_WIDTH;
        const png = await host.media.html(html, {
          width: Math.min(1600, Math.max(200, width)),
          scale: 1,
          dark: input["dark"] !== false,
        });
        return {
          content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
        };
      },
    },
  ];
}
