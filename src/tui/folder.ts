import { shortPath } from "./resume.ts";

/**
 * The folder the status line names, with ` · branch` in a repository. The
 * host reads the branch, since the folder is its.
 */
export class FolderLabel {
  #fetch: (cwd: string) => Promise<string | null>;
  #changed: () => void;
  #key = "";
  #cwd = "";
  #branch: string | null = null;

  constructor(fetch: (cwd: string) => Promise<string | null>, changed: () => void) {
    this.#fetch = fetch;
    this.#changed = changed;
  }

  /**
   * A new `turn` asks again, since an agent may switch branches; the last
   * answer stays shown meanwhile.
   */
  label(cwd: string, turn: string, home: string): string {
    const key = `${cwd}\0${turn}`;
    if (key !== this.#key) {
      this.#key = key;
      if (cwd !== this.#cwd) {
        this.#cwd = cwd;
        this.#branch = null;
      }
      this.#fetch(cwd).then(
        (branch) => this.#arrived(key, branch),
        () => this.#arrived(key, null),
      );
    }
    const path = shortPath(cwd, home);
    return this.#branch ? `${path} · ${this.#branch}` : path;
  }

  #arrived(key: string, branch: string | null): void {
    if (key !== this.#key || branch === this.#branch) return;
    this.#branch = branch;
    this.#changed();
  }
}
