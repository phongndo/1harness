import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_TYPES, type ImageType } from "../drivers/images.ts";

// What is pasted into the composer, as Claude Code and Codex take it: a
// path pasted or dropped in, or ctrl+v with an image or files copied, shows
// as `[Image #N]`; a long text as `[Pasted text #N +X lines]`, sent whole.
// Images are read where the terminal runs, at once, since a screenshot's
// file may be gone by the time the message is sent, and the host may run
// elsewhere.

/** An image read where the terminal runs, to send with a message. */
export interface PastedImage {
  type: ImageType;
  /** Base64. */
  data: string;
}

/**
 * The most one message's images may be together, before base64, so the
 * message stays under the 16 MiB a server takes.
 */
export const PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The words of a paste as a shell would split them, quotes and backslashes
 * resolved, as terminals write a dropped file's path.
 */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && /["\\$`]/.test(text[index + 1] ?? ""))
        word += text[++index]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < text.length) word = (word ?? "") + text[++index]!;
    else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote) return [];
  if (word !== null) words.push(word);
  return words;
}

/** A word as a local path: `file://` URLs and `~` resolved. */
function localPath(word: string): string | null {
  if (word.startsWith("file://")) {
    try {
      return fileURLToPath(word);
    } catch {
      return null;
    }
  }
  return word === "~" || word.startsWith("~/") ? homedir() + word.slice(1) : word;
}

/**
 * The image files a paste names, when it names only image files that exist,
 * as dropping screenshots in does; null for any other paste.
 */
export function pastedImagePaths(text: string): string[] | null {
  const words = shellWords(text.trim());
  if (words.length === 0) return null;
  const paths: string[] = [];
  for (const word of words) {
    const path = localPath(word);
    if (!path || !(extname(path).toLowerCase() in IMAGE_TYPES)) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    paths.push(path);
  }
  return paths;
}

/** Reads an image file to send; throws when it is too large or cannot be read. */
export function readPastedImage(path: string): PastedImage {
  const size = statSync(path).size;
  if (size > PASTED_IMAGE_BYTES)
    throw new Error(`${path} is too large to send (${tooLarge(size)})`);
  return {
    type: IMAGE_TYPES[extname(path).toLowerCase()] ?? "image/png",
    data: readFileSync(path).toString("base64"),
  };
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function tooLarge(size: number): string {
  return `${megabytes(size)}; at most ${megabytes(PASTED_IMAGE_BYTES)}`;
}

/** Runs a program, resolving with what it wrote, or null if it failed. */
function output(command: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer: PASTED_IMAGE_BYTES * 3, timeout: 5_000 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * The image on the clipboard where the terminal runs, as a PNG: through
 * AppleScript on macOS, and wl-paste or xclip elsewhere. Null when there is
 * none; throws when it is too large.
 */
export async function clipboardImage(
  platform: NodeJS.Platform = process.platform,
): Promise<PastedImage | null> {
  let png: Buffer | null = null;
  if (platform === "darwin") {
    // Written as `«data PNGf89504E47…»`.
    const said = await output("osascript", ["-e", "the clipboard as «class PNGf»"]);
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(said?.toString() ?? "")?.[1];
    png = hex ? Buffer.from(hex, "hex") : null;
  } else {
    png =
      (process.env["WAYLAND_DISPLAY"]
        ? await output("wl-paste", ["--no-newline", "--type", "image/png"])
        : null) ?? (await output("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]));
  }
  if (!png || png.length === 0) return null;
  if (png.length > PASTED_IMAGE_BYTES)
    throw new Error(`The clipboard's image is too large to send (${tooLarge(png.length)})`);
  return { type: "image/png", data: png.toString("base64") };
}

/** How the composer shows the image numbered `n`. */
export function imagePlaceholder(n: number): string {
  return `[Image #${n}]`;
}

/** A paste longer than this many characters, or lines, shows as a placeholder. */
export const PASTE_COLLAPSE_CHARS = 1000;
export const PASTE_COLLAPSE_LINES = 10;

function lineCount(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

/** Whether a paste is long enough to stand in the composer as a placeholder. */
export function collapsesPaste(text: string): boolean {
  return text.length > PASTE_COLLAPSE_CHARS || lineCount(text) > PASTE_COLLAPSE_LINES;
}

/** How the composer shows the long text pasted `n`th. */
export function pastedTextPlaceholder(n: number, text: string): string {
  const lines = lineCount(text);
  return `[Pasted text #${n} ${lines > 1 ? `+${lines} lines` : `${text.length} chars`}]`;
}

/** Paths written as a paste of them would be, spaces and quotes escaped. */
export function pathsAsPaste(paths: string[]): string {
  return paths.map((path) => path.replace(/[^\w/.,:@%+=-]/g, "\\$&")).join(" ");
}

// Finder puts a copied file's icon on the clipboard as an image too, so its
// file is read first.
const MAC_CLIPBOARD_FILES = `ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
  $([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
const paths = [];
if (urls) for (let i = 0; i < urls.count; i++) paths.push(urls.objectAtIndex(i).path.js);
JSON.stringify(paths);`;

/**
 * The files copied to the clipboard where the terminal runs, as from Finder
 * or a file manager; empty when there are none.
 */
export async function clipboardFiles(
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform === "darwin") {
    const said = await output("osascript", ["-l", "JavaScript", "-e", MAC_CLIPBOARD_FILES]);
    try {
      const paths: unknown = JSON.parse(said?.toString() ?? "[]");
      return Array.isArray(paths) ? paths.filter((path) => typeof path === "string") : [];
    } catch {
      return [];
    }
  }
  const list =
    (process.env["WAYLAND_DISPLAY"]
      ? await output("wl-paste", ["--no-newline", "--type", "text/uri-list"])
      : null) ?? (await output("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]));
  return (list?.toString() ?? "")
    .split(/\r?\n/)
    .map((line) => (line.startsWith("file://") ? localPath(line.trim()) : null))
    .filter((path) => path !== null);
}

/**
 * The text on the clipboard where the terminal runs, for a ctrl+v that
 * reaches the composer as a key rather than a paste; null when there is
 * none. Over SSH that clipboard is not the user's, so it is not read.
 */
export async function clipboardText(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return null;
  const text =
    platform === "darwin"
      ? await output("pbpaste", [])
      : ((env["WAYLAND_DISPLAY"]
          ? await output("wl-paste", ["--no-newline", "--type", "text"])
          : null) ?? (await output("xclip", ["-selection", "clipboard", "-o"])));
  const said = text?.toString() ?? "";
  return said === "" ? null : said;
}
