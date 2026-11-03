import { FileIndex, type FileMatch } from "../core/files.ts";

/** How many folders `files.search` keeps an index of, each with its watchers. */
const FILE_INDEXES = 8;

/** An index of each folder searched lately; the least recently used close first. */
export class FileIndexes {
  /** Most recently used last. */
  #indexes = new Map<string, { index: FileIndex; ready: boolean }>();

  /** What matches in a folder, and whether its index is still loading, so more may match soon. */
  search(cwd: string, query: string, limit: number): { matches: FileMatch[]; loading: boolean } {
    let files = this.#indexes.get(cwd);
    if (files) {
      this.#indexes.delete(cwd);
      this.#indexes.set(cwd, files);
    } else {
      for (const [folder, { index }] of this.#indexes) {
        if (this.#indexes.size < FILE_INDEXES) break;
        index.close();
        this.#indexes.delete(folder);
      }
      const entry = { index: new FileIndex(cwd), ready: false };
      files = entry;
      this.#indexes.set(cwd, entry);
      entry.index.load().then(
        () => {
          entry.ready = true;
        },
        () => {
          entry.ready = true;
        },
      );
    }
    return { matches: files.index.search(query, limit), loading: !files.ready };
  }

  close(): void {
    for (const { index } of this.#indexes.values()) index.close();
    this.#indexes.clear();
  }
}
