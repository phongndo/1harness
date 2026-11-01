import { execFileSync, spawn } from "node:child_process";
import { findExecutable } from "../drivers/index.ts";

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
