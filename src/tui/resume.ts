import { ago } from "../core/wording.ts";
import type { ThreadListing } from "../protocol.ts";
import { runsOn } from "./agents.ts";
import type { Key } from "./input.ts";
import { hints, lineStep, rule } from "./menu.ts";
import { style } from "./theme.ts";
import { oneLineText, pad, spread, truncate, visibleWidth } from "./text.ts";

// The thread list /resume and ctrl+t open, laid out as Codex's and pi's
// pickers are: a search line, then a thread a row, when it last moved at the
// left, what it is doing, and what it runs on at the right, with its folder
// when every folder's threads show. This folder's threads come first; tab
// shows every folder's, then the archived ones. Only your own threads show,
// not the agents they started. ctrl+r renames the selected thread, ctrl+a
// archives it or brings it back.
//
// /lineage is the same list over one thread's agents, kept up to date as they
// work: enter goes into one, ← back out, and the list stays open over both.

export interface ResumeEntry {
  id: string;
  title: string;
  /** What it runs on: `claude · claude-opus-5-5 · high`. */
  on: string;
  cwd: string;
  /** When it last did something. */
  updatedAt: number;
  /** How deep under the thread that started it: 0 for yours, 1 for its agents. */
  depth: number;
  /** A status dot for a thread at work or waiting on you; empty otherwise. */
  dot: string;
  /** Moved out of the lists with ctrl+a, so it shows only among the archived. */
  archived?: boolean;
}

/** A stored thread's entry, as the host lists it. */
export function listedEntry(thread: ThreadListing): ResumeEntry {
  return {
    id: thread.id,
    title: thread.title,
    on: runsOn(thread.harness, thread.model, thread.effort),
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    depth: 0,
    dot: "",
  };
}

export type ResumeResult =
  | { kind: "choose"; id: string }
  | { kind: "close" }
  /** A thread renamed, or archived or brought back; the list stays open. */
  | { kind: "rename"; id: string; title: string }
  /** In /lineage, ← out of the agent on screen. */
  | { kind: "exit" }
  | { kind: "archive"; id: string; archived: boolean }
  | null;

/** Which threads show: this folder's, every folder's, or the archived ones. */
type Scope = "folder" | "all" | "archived";

const SCOPES: { scope: Scope; label: string }[] = [
  { scope: "folder", label: "This folder" },
  { scope: "all", label: "All" },
  { scope: "archived", label: "Archived" },
];

/**
 * The columns the age takes at the left, at the least: `29d ago` and a gap.
 * A date, past a month, can take more, and the column widens for it.
 */
const AGE_WIDTH = 10;

/** The longest a folder shows in a row; a longer one keeps its last part. */
const FOLDER_WIDTH = 24;

/** A folder as it reads best: under the home folder as `~/…`, and a long one by its end. */
export function shortPath(path: string, home: string): string {
  const shown =
    home && path === home
      ? "~"
      : home && path.startsWith(`${home}/`)
        ? `~${path.slice(home.length)}`
        : path;
  if (shown.length <= FOLDER_WIDTH) return shown;
  const last = shown.split("/").filter(Boolean).at(-1) ?? shown;
  return `…/${last.length > FOLDER_WIDTH - 2 ? `${last.slice(0, FOLDER_WIDTH - 3)}…` : last}`;
}

/** `now`, `5m ago`, `3h ago`, `2d ago`; past a month, the date `ago` gives. */
function shortAge(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : ago(time, now);
}

function entryAge(entry: ResumeEntry, now: number): string {
  return entry.updatedAt ? shortAge(entry.updatedAt, now) : "";
}

export class ResumeView {
  readonly title: string;
  /** The entries, or for /lineage where they change as agents work, how to read them. */
  #source: ResumeEntry[] | (() => ResumeEntry[]);
  /** /lineage: every entry, agents at their depths, and no scopes, renames, or archiving. */
  readonly #lineage: boolean;
  #cwd: string;
  #home: string;
  #scope: Scope;
  #query = "";
  /** The title being written for the selected thread, while ctrl+r renames it. */
  #renaming: { id: string; text: string } | null = null;
  #index = 0;
  /** /lineage: the agent selected, kept as agents come in above it. */
  #chosen: string | undefined;
  /** The first entry in view, kept so the selection stays in it. */
  #top = 0;

  constructor(
    title: string,
    source: ResumeEntry[] | (() => ResumeEntry[]),
    options: {
      initial?: string | null;
      cwd: string;
      home?: string;
      all?: boolean;
      lineage?: boolean;
    },
  ) {
    this.title = title;
    this.#source = source;
    this.#lineage = options.lineage === true;
    const entries = this.#entries;
    this.#cwd = options.cwd;
    this.#home = options.home ?? "";
    // This folder's threads, unless it has none, or every folder's were asked for.
    const here = entries.some((entry) => !entry.archived && entry.cwd === options.cwd);
    // /lineage's agents work where their thread does, so no folder column.
    this.#scope = !this.#lineage && (options.all ?? !here) ? "all" : "folder";
    // On an agent, the thread that started it.
    let initial = options.initial;
    let owner: ResumeEntry | undefined;
    for (const entry of entries) {
      if (entry.depth === 0) owner = entry;
      else if (!this.#lineage && entry.id === options.initial) initial = owner?.id;
    }
    this.#index = Math.max(
      0,
      this.#visible().findIndex((entry) => entry.id === initial),
    );
    this.#chosen = this.selected?.id;
  }

  /** /lineage: back on the agent selected, wherever it now is in the list. */
  #follow(): void {
    if (!this.#lineage) return;
    const at = this.#visible().findIndex((entry) => entry.id === this.#chosen);
    if (at >= 0) this.#index = at;
  }

  get #entries(): ResumeEntry[] {
    return typeof this.#source === "function" ? this.#source() : this.#source;
  }

  /** Your threads in scope, or /lineage's agents, less what a search leaves out. */
  #visible(): ResumeEntry[] {
    const query = this.#query.toLowerCase();
    const shown = this.#entries.filter(
      (entry) =>
        this.#lineage ||
        (entry.depth === 0 &&
          (this.#scope === "archived"
            ? entry.archived === true
            : !entry.archived && (this.#scope === "all" || entry.cwd === this.#cwd))),
    );
    if (!query) return shown;
    return shown.filter((entry) =>
      `${entry.title} ${entry.on} ${shortPath(entry.cwd, this.#home)}`
        .toLowerCase()
        .includes(query),
    );
  }

  get selected(): ResumeEntry | undefined {
    return this.#visible()[this.#index];
  }

  get query(): string {
    return this.#query;
  }

  /** Text pasted into the list searches it, or goes into a title being written. */
  paste(text: string): void {
    const line = text.replace(/\s+/g, " ");
    if (this.#renaming) this.#renaming.text += line;
    else this.#setQuery(this.#query + line);
    this.#chosen = this.selected?.id;
  }

  #setQuery(query: string): void {
    this.#query = query;
    this.#index = 0;
    this.#top = 0;
  }

  /** Moves the selection to a thread, where it is listed. */
  select(id: string): void {
    const at = this.#visible().findIndex((entry) => entry.id === id);
    if (at >= 0) this.#index = at;
    this.#chosen = this.selected?.id;
  }

  #move(step: number): void {
    const count = this.#visible().length;
    this.#index = count > 0 ? Math.max(0, Math.min(count - 1, this.#index + step)) : 0;
  }

  /** Keys while renaming: typing writes the title, enter keeps it, esc leaves it as it was. */
  #renameKey(key: Key): ResumeResult {
    const renaming = this.#renaming!;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.#renaming = null;
      return null;
    }
    if (key.name === "return") {
      this.#renaming = null;
      const title = renaming.text.replace(/\s+/g, " ").trim();
      const entry = this.#entries.find((candidate) => candidate.id === renaming.id);
      if (!title || !entry || title === entry.title) return null;
      entry.title = title;
      return { kind: "rename", id: renaming.id, title };
    }
    if (key.name === "backspace") renaming.text = renaming.text.slice(0, -1);
    else if (key.ctrl && key.name === "u") renaming.text = "";
    else if (!key.ctrl && !key.meta && key.text) renaming.text += key.text;
    return null;
  }

  key(key: Key, page = 10): ResumeResult {
    this.#follow();
    const result = this.#key(key, page);
    this.#chosen = this.selected?.id;
    return result;
  }

  #key(key: Key, page: number): ResumeResult {
    if (this.#renaming) return this.#renameKey(key);
    if (this.#lineage) {
      if (key.name === "left") return { kind: "exit" };
      if (key.name === "tab" || (key.ctrl && (key.name === "r" || key.name === "a"))) return null;
    }
    if (key.ctrl && key.name === "r") {
      const chosen = this.selected;
      if (chosen) this.#renaming = { id: chosen.id, text: chosen.title };
      return null;
    }
    if (key.ctrl && key.name === "a") {
      const chosen = this.selected;
      if (!chosen) return null;
      // The entry itself changes, so it leaves this scope for the other.
      const entry = this.#entries.find((candidate) => candidate.id === chosen.id);
      if (entry) entry.archived = !entry.archived;
      this.#move(0);
      return { kind: "archive", id: chosen.id, archived: entry?.archived === true };
    }
    const step = lineStep(key);
    if (step) {
      this.#move(step);
      return null;
    }
    switch (key.name) {
      case "tab": {
        // This folder's threads, every folder's, or the archived ones, keeping the selection.
        const chosen = this.selected?.id;
        const at = SCOPES.findIndex((option) => option.scope === this.#scope);
        this.#scope = SCOPES[(at + (key.shift ? SCOPES.length - 1 : 1)) % SCOPES.length]!.scope;
        this.#top = 0;
        this.#index = Math.max(
          0,
          this.#visible().findIndex((entry) => entry.id === chosen),
        );
        return null;
      }
      case "pageup":
      case "pagedown":
        this.#move(key.name === "pageup" ? -page : page);
        return null;
      case "home":
        this.#index = 0;
        return null;
      case "end":
        this.#index = Math.max(0, this.#visible().length - 1);
        return null;
      case "return": {
        const chosen = this.selected;
        return chosen ? { kind: "choose", id: chosen.id } : null;
      }
      case "escape":
        // Esc clears a search first, then closes.
        if (this.#query) {
          this.#setQuery("");
          return null;
        }
        return { kind: "close" };
      case "backspace":
        this.#setQuery(this.#query.slice(0, -1));
        return null;
    }
    if (key.ctrl && key.name === "c") return { kind: "close" };
    if (key.ctrl && key.name === "u") {
      this.#setQuery("");
      return null;
    }
    if (!key.ctrl && !key.meta && key.text) this.#setQuery(this.#query + key.text);
    return null;
  }

  /** The list in at most `height` rows: heading, search line, threads, and hints. */
  render(width: number, height: number, now = Date.now()): string[] {
    this.#follow();
    const visible = this.#visible();
    const scopes = this.#lineage
      ? ""
      : SCOPES.map((option) =>
          option.scope === this.#scope
            ? style.strong(`◉ ${option.label}`)
            : style.muted(`○ ${option.label}`),
        ).join("  ");
    const search = this.#renaming
      ? `${style.strong("rename ›")} ${style.text(this.#renaming.text)}${style.strong("▏")}`
      : this.#query
        ? `${style.strong(">")} ${style.text(this.#query)}${style.strong("▏")}`
        : `${style.strong(">")} ${style.faint("type to search")}`;
    const rows = [
      rule(width),
      spread(style.bold(style.strong(this.title)), scopes, width),
      "",
      truncate(search, width),
      "",
    ];
    // Less the counted rule and the hints under the list.
    const room = Math.max(2, height - rows.length - 2);
    if (visible.length === 0)
      rows.push(
        style.muted(
          this.#query
            ? "  No thread matches"
            : this.#lineage
              ? "  No agents"
              : this.#scope === "archived"
                ? "  No archived threads"
                : this.#scope === "all"
                  ? "  No threads yet"
                  : "  No threads in this folder · tab shows every folder's",
        ),
      );
    else {
      this.#index = Math.min(this.#index, visible.length - 1);
      if (this.#index < this.#top) this.#top = this.#index;
      if (this.#index >= this.#top + room) this.#top = this.#index - room + 1;
      this.#top = Math.max(0, Math.min(this.#top, visible.length - room));
      const shown = visible.slice(this.#top, this.#top + room);
      const columns = this.#columns(shown, width, now);
      shown.forEach((entry, offset) =>
        rows.push(this.#row(entry, this.#top + offset === this.#index, width, columns, now)),
      );
    }
    const count = visible.length > 0 ? `${this.#index + 1} / ${visible.length}` : "0";
    const keys = this.#renaming
      ? ["enter rename", "esc back"]
      : this.#lineage
        ? ["↑↓ move", "enter go in", "← back out", "esc close"]
        : [
            "↑↓ move",
            "tab scope",
            "ctrl+r rename",
            this.#scope === "archived" ? "ctrl+a unarchive" : "ctrl+a archive",
            "enter resume",
            "esc close",
          ];
    rows.push(rule(width, count), hints(keys, width));
    return rows;
  }

  /**
   * The columns the rows shown line up in at the right: what each runs on,
   * then, with every folder's threads, its folder; the folder gives way
   * first, then what it runs on, where the titles would have too little room.
   */
  #columns(
    shown: readonly ResumeEntry[],
    width: number,
    now: number,
  ): { age: number; on: number; folder: number } {
    const widest = (pick: (entry: ResumeEntry) => string) =>
      Math.max(0, ...shown.map((entry) => visibleWidth(pick(entry))));
    const age = Math.max(AGE_WIDTH, widest((entry) => entryAge(entry, now)) + 2);
    const on = widest((entry) => entry.on);
    const folder =
      this.#scope === "folder" ? 0 : widest((entry) => shortPath(entry.cwd, this.#home));
    // The marker, the age, and room for a title of a few words.
    const fits = (right: number) => 4 + age + 25 + right <= width;
    if (fits(on + (folder ? folder + 2 : 0))) return { age, on, folder };
    return fits(on) ? { age, on, folder: 0 } : { age, on: 0, folder: 0 };
  }

  /**
   * A thread's row: `›` where selected, its age, what it is doing, and at
   * the right, in columns, what it runs on and, with every folder's, where.
   */
  #row(
    entry: ResumeEntry,
    selected: boolean,
    width: number,
    columns: { age: number; on: number; folder: number },
    now: number,
  ): string {
    const marker = selected ? style.strong("›") : " ";
    const lead = `  ${marker} ${style.muted(entryAge(entry, now).padEnd(columns.age))}${"  ".repeat(entry.depth)}${entry.dot}`;
    const parts: string[] = [];
    if (columns.on) parts.push(pad(entry.on, columns.on));
    if (columns.folder) parts.push(pad(shortPath(entry.cwd, this.#home), columns.folder));
    const right = style.muted(parts.join("  ").trimEnd());
    const used = parts.length > 0 ? columns.on + (columns.folder ? columns.folder + 2 : 0) : 0;
    const room = Math.max(4, width - visibleWidth(lead) - used - 2);
    const title = truncate(oneLineText(entry.title) || "New thread", room);
    const painted = selected ? style.bold(style.strong(title)) : style.text(title);
    // The columns start at one place on every row, so they line up.
    return `${lead}${pad(painted, room + 2)}${right}`.trimEnd();
  }
}
