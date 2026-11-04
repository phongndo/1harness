import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CommandRegistry, type CommandUI } from "../commands/registry.ts";
import type { Thread } from "../core/thread.ts";
import { ExtensionHost, type ExtensionHostOptions } from "../extensions/host.ts";

/** How many folders' extensions stay loaded with nothing using them. */
const EXTENSION_SETS = 16;

/** One folder's extensions, with a set of named modules, and the commands they register. */
export interface ExtensionSet {
  key: string;
  host: ExtensionHost;
  commands: CommandRegistry;
  ready: Promise<void>;
}

export interface ExtensionSetsOptions {
  configDir: () => string;
  stateDir: () => string;
  /** The UI extensions' handlers get for a thread, or for none. */
  ui: (thread: Thread | null) => CommandUI | null;
  /** The sets in use, by their hosts or keys, which are never closed to make room. */
  inUse: () => Iterable<ExtensionHost | string>;
  /** How a set's extensions list and call operations, for its folder and modules. */
  operations: (folder: string, modules: readonly string[]) => ExtensionHostOptions["operations"];
}

/**
 * The extensions for each folder and set of modules a client named: the
 * user's, the folder's own once trusted, and those modules. Each is loaded
 * once, by the folder's real path, and kept while something uses it.
 */
export class ExtensionSets {
  #options: ExtensionSetsOptions;
  /** Most recently used last, so the least used go first. */
  #sets = new Map<string, ExtensionSet>();

  constructor(options: ExtensionSetsOptions) {
    this.#options = options;
  }

  /** The set for a folder and modules, loading it the first time. */
  get(cwd: string, modules: readonly string[]): ExtensionSet {
    const { key, folder, flags } = this.#key(cwd, modules);
    let set = this.#sets.get(key);
    if (set) {
      this.#sets.delete(key);
      this.#sets.set(key, set);
    } else {
      const commands = new CommandRegistry();
      const operations = this.#options.operations(folder, flags);
      const host = new ExtensionHost({
        cwd: folder,
        configDir: this.#options.configDir(),
        stateDir: this.#options.stateDir(),
        commands,
        ui: this.#options.ui,
        ...(operations ? { operations } : {}),
      });
      set = { key, host, commands, ready: host.loadAll(flags) };
      this.#sets.set(key, set);
      this.#trim(set);
    }
    return set;
  }

  /** The key of the set for a folder and modules, loaded or not. */
  key(cwd: string, modules: readonly string[]): string {
    return this.#key(cwd, modules).key;
  }

  /** The set whose extensions these are. */
  of(host: ExtensionHost): ExtensionSet | undefined {
    return [...this.#sets.values()].find((set) => set.host === host);
  }

  async close(): Promise<void> {
    for (const set of this.#sets.values()) await set.host.close();
  }

  #key(cwd: string, modules: readonly string[]): { key: string; folder: string; flags: string[] } {
    let folder = resolvePath(cwd);
    try {
      folder = realpathSync(folder);
    } catch {
      // A folder that is gone still names its set.
    }
    const flags = modules.map((path) => resolvePath(cwd, path)).toSorted();
    return { key: [folder, ...flags].join("\0"), folder, flags };
  }

  /**
   * Closes the least recently used sets past `EXTENSION_SETS` that nothing
   * uses, as a client that wanders through folders would otherwise keep every
   * folder's extensions loaded.
   */
  #trim(newest: ExtensionSet): void {
    if (this.#sets.size <= EXTENSION_SETS) return;
    const used = new Set(this.#options.inUse());
    for (const [key, set] of this.#sets) {
      if (this.#sets.size <= EXTENSION_SETS) break;
      if (set === newest || used.has(key) || used.has(set.host)) continue;
      this.#sets.delete(key);
      void set.ready.then(() => set.host.close()).catch(() => {});
    }
  }
}
