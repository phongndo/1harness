import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { FileFinder } from "@ff-labs/fff-node";

export interface FileMatch {
  /** Relative to the indexed folder; folders end with `/`. */
  path: string;
  directory: boolean;
}

// The first scan of a very large tree stops blocking here; results still fill in as it continues.
const SCAN_TIMEOUT_MS = 15_000;

/**
 * Fuzzy search over a folder's files and folders, for `@` mentions. fff
 * indexes in the background and watches for changes; its native library loads
 * on first use, so sessions that never mention a file never pay for it.
 */
export class FileIndex {
  readonly cwd: string;
  #finder: FileFinder | null = null;
  #loading: Promise<void> | null = null;
  #closed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Loads fff and indexes the folder; settles once the first scan is done. */
  load(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  /**
   * Best matches first; a query ending in `/` shows what is inside that folder.
   * Empty until loading starts, and partial while the first scan runs.
   */
  search(query: string, limit: number): FileMatch[] {
    // fff reads a trailing slash as "folders only", so a folder is searched by its path.
    const folder = query.endsWith("/") ? query : null;
    const result = this.#finder?.mixedSearch(folder ? query.slice(0, -1) : query, {
      pageSize: folder ? limit * 4 : limit + 1,
    });
    if (!result?.ok) return [];
    const matches: FileMatch[] = [];
    for (const { type, item } of result.value.items) {
      // The indexed folder itself matches as an empty path.
      if (item.relativePath === "") continue;
      if (folder && (!item.relativePath.startsWith(folder) || item.relativePath === folder)) {
        continue;
      }
      matches.push({ path: item.relativePath, directory: type === "directory" });
      if (matches.length === limit) break;
    }
    return matches;
  }

  close(): void {
    this.#closed = true;
    this.#finder?.destroy();
    this.#finder = null;
  }

  async #load(): Promise<void> {
    const { FileFinder } = await import("@ff-labs/fff-node");
    const created = FileFinder.create({
      basePath: this.cwd,
      // Path search needs neither; both cost memory and scan time.
      disableMmapCache: true,
      disableContentIndexing: true,
    });
    if (!created.ok) throw new Error(created.error);
    if (this.#closed) {
      created.value.destroy();
      return;
    }
    this.#finder = created.value;
    await created.value.waitForScan(SCAN_TIMEOUT_MS);
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Images the text mentions as `@path` or `@"path"`, as absolute paths that exist. */
export function mentionedImages(text: string, cwd: string): string[] {
  const images: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|(\S+))/g)) {
    // Punctuation after an unquoted path ends the sentence, not the path.
    const path =
      match[1]?.replace(/\\(.)/g, "$1") ?? match[2]?.replace(/[.,;:!?)\]}'"]+$/, "") ?? "";
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const absolute = resolve(cwd, path);
    if (existsSync(absolute) && !images.includes(absolute)) images.push(absolute);
  }
  return images;
}
