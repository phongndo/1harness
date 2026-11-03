import type { HostClient } from "../client/client.ts";
import type {
  CommandContext,
  CommandDefinition,
  CommandRegistry,
  Completion as Word,
} from "../commands/registry.ts";
import type { NativeCommand } from "../core/events.ts";
import type { FileMatch } from "../core/files.ts";
import { errorMessage } from "../core/errors.ts";
import { FetchCache } from "./cache.ts";
import type { Editor } from "./editor.ts";
import type { Key } from "./input.ts";
import { Menu, entry, lineStep, type MenuEntry } from "./menu.ts";
import { visibleWidth } from "./text.ts";

// The lists that open under the composer as it is typed in: commands after
// `/`, the words a command takes after it, skills after `$`, and files after
// `@`. The composer keeps the typing; arrows move in the list, esc closes it
// until the text changes, and tab or enter takes what is selected.

/**
 * The order the command menu and /help list 1harness's commands in, a group
 * at a time: Threads, Model, Permissions, Tools, General; others follow.
 */
const COMMAND_ORDER = [
  "new",
  "resume",
  "rename",
  "fork",
  "compact",
  "unqueue",
  "reload",
  "close",
  "model",
  "effort",
  "harness",
  "mode",
  "plan",
  "mcp",
  "extensions",
  "help",
  "status",
  "copy",
  "connect",
];
/** Listed last, after commands extensions add. */
const LAST_COMMANDS = ["quit"];

/** Where a command goes in menus: by COMMAND_ORDER, then unlisted ones, then LAST_COMMANDS. */
function commandRank(command: CommandDefinition): number {
  const at = COMMAND_ORDER.indexOf(command.name);
  if (at !== -1) return at;
  return LAST_COMMANDS.includes(command.name) ? COMMAND_ORDER.length + 1 : COMMAND_ORDER.length;
}

/** Commands in the order menus list them, keeping the given order among equals. */
export function inMenuOrder(commands: readonly CommandDefinition[]): CommandDefinition[] {
  return commands
    .map((command, index) => ({ command, index }))
    .toSorted((a, b) => commandRank(a.command) - commandRank(b.command) || a.index - b.index)
    .map(({ command }) => command);
}

/** How a file mention is written: `@path`, quoted when the path has spaces. */
function mentionText(path: string): string {
  return /[\s"\\]/.test(path) ? `@"${path.replace(/["\\]/g, "\\$&")}"` : `@${path}`;
}

/** How many files an `@` mention lists. */
const MENTION_LIMIT = 50;
/** How often a file search the host is still indexing for is asked again. */
const FILES_RETRY_MS = 300;
/** File searches kept, by folder and query, as a mention is typed and typed again. */
const FILE_SEARCHES = 200;

/** What the suggestions need from the terminal around them. */
export interface SuggestionsHost {
  client: HostClient;
  editor: Editor;
  commands: CommandRegistry;
  context: CommandContext;
  /** 1harness's commands the thread on screen can run, in menu order. */
  available(): CommandDefinition[];
  isAvailable(command: CommandDefinition): boolean;
  /** The harness's skills, listed after `$`. */
  skills(): readonly NativeCommand[];
  /** The folder files are mentioned from. */
  cwd(): string;
  submit(text: string): void;
  notice(level: "warning", text: string): void;
  schedule(): void;
}

/** The composer text a list was closed at, which keeps it closed until the text changes. */
class Dismissed {
  #at: string | null = null;

  set(text: string): void {
    this.#at = text;
  }

  /** Whether the list stays closed for `text`. */
  holds(text: string): boolean {
    if (text !== this.#at) this.#at = null;
    return this.#at !== null;
  }
}

/** A list under the composer, as its keys reach it. */
interface Suggesting {
  menu: Menu;
  /** The user moved in it, so its choice holds as it refreshes. */
  moved(): void;
  /** Esc closed it. */
  dismissed(): void;
  /** Tab or enter takes what is selected; false leaves the key to the composer. */
  accept(how: "tab" | "enter"): boolean;
}

/** Keys for a list under the composer; returns false for keys that go to the composer. */
function suggestingKey(list: Suggesting, key: Key): boolean {
  // The composer takes typing, so only arrows and ctrl+j/k move here.
  const step = lineStep(key);
  if (step) {
    list.menu.move(step);
    list.moved();
    return true;
  }
  if (key.name === "escape") {
    list.dismissed();
    return true;
  }
  if (key.name === "tab" && !key.shift) return list.accept("tab");
  if (key.name === "return" && !key.meta) return list.accept("enter");
  return false;
}

/** The words a command takes, listed from where the word starts in the composer. */
interface WordList {
  menu: Menu;
  start: number;
  items: Word[];
  moved: boolean;
  typed: string;
  /** The word is one a word before needs, so enter takes it even with nothing typed. */
  required: boolean;
}

/** Files for the `@` word that starts at `start`. */
interface FileList {
  menu: Menu;
  start: number;
  options: { entry: MenuEntry; match: FileMatch }[];
}

export class Suggestions {
  #host: SuggestionsHost;
  /** Commands after `/`, or skills after `$`, as the composer starts. */
  #slash: Menu | null = null;
  #slashDismissed = new Dismissed();
  /** Composer text at which the user moved in the slash or skill menu, which keeps their choice. */
  #slashMoved: string | null = null;
  /** Completion for the words after a command, such as `/mcp login NAME`. */
  #args: WordList | null = null;
  /** Where the word goes that a chosen word needs after it, such as `/mcp show`'s server. */
  #argsRequired: number | null = null;
  #argsDismissed = new Dismissed();
  /** Files for `@` mentions, as the host found them, by folder and query. */
  #fileResults = new FetchCache<string, { matches: FileMatch[]; loading: boolean }>({
    limit: FILE_SEARCHES,
    arrived: (found, key) => {
      // Results fill in as the host's first scan goes on.
      if (found.loading)
        setTimeout(() => {
          if (this.#fileResults.peek(key) === found) this.#fileResults.delete(key);
          this.#syncMention();
          this.#host.schedule();
        }, FILES_RETRY_MS).unref();
      this.#syncMention();
      this.#host.schedule();
    },
  });
  #mention: FileList | null = null;
  #mentionDismissed = new Dismissed();

  constructor(host: SuggestionsHost) {
    this.#host = host;
  }

  /** The list open under the composer, if any. */
  get menu(): Menu | null {
    return this.#slash ?? this.#args?.menu ?? this.#mention?.menu ?? null;
  }

  /** Opens, narrows, or closes the lists to match the composer. */
  sync(): void {
    this.#syncSlash();
    this.#syncArgs();
    this.#syncMention();
  }

  /** Closes every list, as sending the composer's text does. */
  clear(): void {
    this.#slash = null;
    this.#args = null;
    this.#mention = null;
  }

  /** Keeps the command menu closed for the composer's text, as for a command /help put there. */
  dismissCommands(): void {
    this.#slashDismissed.set(this.#host.editor.text);
  }

  /** Keys for the open list; returns false for keys that go to the composer. */
  key(key: Key): boolean {
    if (this.#slash) return this.#slashKey(this.#slash, key);
    if (this.#args) return this.#argsKey(this.#args, key);
    if (this.#mention) return this.#mentionKey(this.#mention, key);
    return false;
  }

  #slashKey(menu: Menu, key: Key): boolean {
    const { editor } = this.#host;
    return suggestingKey(
      {
        menu,
        moved: () => {
          this.#slashMoved = editor.text;
        },
        dismissed: () => {
          this.#slashDismissed.set(editor.text);
          this.#slash = null;
        },
        accept: (how) => {
          const selected = menu.selected();
          if (!selected) return false;
          if (how === "tab") {
            editor.set(`${selected.label} `);
            this.sync();
          } else {
            this.#slash = null;
            editor.set(selected.label);
            this.#host.submit(editor.text);
          }
          return true;
        },
      },
      key,
    );
  }

  #argsKey(args: WordList, key: Key): boolean {
    const { editor } = this.#host;
    return suggestingKey(
      {
        menu: args.menu,
        moved: () => {
          args.moved = true;
        },
        dismissed: () => {
          this.#argsDismissed.set(editor.text);
          this.#args = null;
        },
        accept: (how) => {
          // With nothing typed for the word, the list only suggests: enter runs what is
          // there, so `/harness codex ` does not become `/harness codex fresh`. Moving
          // to a word picks it.
          if (
            how === "enter" &&
            !args.moved &&
            !args.required &&
            editor.text.slice(args.start).trim() === ""
          )
            return false;
          const selected = args.menu.selected();
          const item = args.items.find((candidate) => candidate.value === selected?.label);
          if (!item) return false;
          const text = `${editor.text.slice(0, args.start)}${item.value}${item.more ? " " : ""}`;
          editor.set(text);
          this.#argsRequired = item.more ? text.length : null;
          // Enter runs a finished command; a word that needs another keeps the list open.
          if (how === "enter" && !item.more) this.#host.submit(text);
          else this.sync();
          return true;
        },
      },
      key,
    );
  }

  #mentionKey(mention: FileList, key: Key): boolean {
    const { editor } = this.#host;
    return suggestingKey(
      {
        menu: mention.menu,
        moved: () => {},
        dismissed: () => {
          this.#mentionDismissed.set(editor.text);
          this.#mention = null;
        },
        accept: () => {
          const selected = mention.menu.selected();
          const match = mention.options.find((option) => option.entry === selected)?.match;
          if (!match) return false;
          // A folder stays open for its contents; a file ends the word.
          const text = mentionText(match.path);
          editor.replaceToken(mention.start, match.directory ? text : `${text} `);
          this.sync();
          return true;
        },
      },
      key,
    );
  }

  /** Opens, narrows, or closes the command or skill menu to match the composer. */
  #syncSlash(): void {
    const text = this.#host.editor.text;
    const sigil = text[0];
    if (this.#slashDismissed.holds(text) || !/^[/$]\S*$/.test(text)) {
      this.#slash = null;
      return;
    }
    const entries: MenuEntry[] = [];
    // A name typed in full comes first and is selected, so /mode runs /mode, not /model.
    let exact: string | null = null;
    const add = (names: string[], made: MenuEntry) => {
      if (!names.some((name) => `${sigil}${name}`.startsWith(text))) return;
      if (exact === null && names.some((name) => `${sigil}${name}` === text)) {
        exact = made.label;
        entries.unshift(made);
      } else entries.push(made);
    };
    if (sigil === "$")
      for (const skill of this.#host.skills())
        add([skill.name, ...skill.aliases], entry(`$${skill.name}`, skill.description));
    else
      for (const command of this.#host.available())
        add(
          [command.name, ...(command.aliases ?? [])],
          entry(`/${command.name}`, command.description, { tag: command.group }),
        );
    if (entries.length === 0) {
      this.#slash = null;
      return;
    }
    const title = sigil === "$" ? "Skills" : "Commands";
    if (this.#slash?.config.title === title) this.#slash.setEntries(entries);
    else this.#slash = new Menu({ title, entries, describe: true });
    // A name the user moved to stays chosen while the text is the same, as lists refresh.
    if (this.#slashMoved !== text) this.#slashMoved = null;
    if (exact !== null && this.#slashMoved === null) this.#slash.select(exact);
  }

  /** Opens, narrows, or closes the list of words that can follow a command. */
  #syncArgs(): void {
    const { editor, commands, context } = this.#host;
    const text = editor.text;
    const match = this.#argsDismissed.holds(text) ? null : /^\/(\S+) ([^\n]*)$/.exec(text);
    const command = match ? commands.find(match[1] ?? "") : undefined;
    const found =
      match && command && this.#host.isAvailable(command)
        ? (command.complete?.(context, match[2] ?? "") ?? null)
        : null;
    if (!match || !found) {
      this.#args = null;
      return;
    }
    const typed = (match[2] ?? "").slice(found.start).toLowerCase();
    const items = found.items.filter((item) => item.value.toLowerCase().startsWith(typed));
    if (items.length === 0) {
      this.#args = null;
      return;
    }
    const entries = items.map((item) => entry(item.value, item.detail));
    const menu = this.#args?.menu ?? new Menu({ title: "", entries, bare: true });
    menu.setEntries(entries);
    const start = text.length - (match[2] ?? "").length + found.start;
    // Lined up under the word.
    menu.indent = visibleWidth(text.slice(0, start));
    // A move holds while the word is the same; typing more of it starts over.
    const moved = this.#args?.start === start && this.#args.typed === typed && this.#args.moved;
    // A word typed in full is chosen over longer ones, so /resume t1 is not t12.
    const exact = items.find((item) => item.value.toLowerCase() === typed);
    if (exact && !moved) menu.select(exact.value);
    // The word after one that needs another, as `/mcp show NAME`, is the list's to give.
    const required = this.#argsRequired === start;
    this.#args = { menu, start, items, moved, typed, required };
  }

  /** Opens, narrows, or closes the file menu for an `@` word at the cursor. */
  #syncMention(): void {
    const { editor } = this.#host;
    const dismissed = this.#mentionDismissed.holds(editor.text);
    const token = this.#slash || this.#args ? null : editor.token("@");
    const matches = token && !dismissed ? this.#searchFiles(token.query) : [];
    if (!token || matches.length === 0) {
      this.#mention = null;
      return;
    }
    const options = matches.map((match) => {
      const trimmed = match.directory ? match.path.slice(0, -1) : match.path;
      const slash = trimmed.lastIndexOf("/");
      const name = trimmed.slice(slash + 1) + (match.directory ? "/" : "");
      return { entry: entry(name, trimmed.slice(0, slash + 1)), match };
    });
    const entries = options.map((option) => option.entry);
    const menu = this.#mention?.menu ?? new Menu({ title: "Files", entries });
    menu.setEntries(entries);
    this.#mention = { menu, start: token.start, options };
  }

  /**
   * Files matching an `@` mention, which the host searches where the thread
   * runs. The first call for a query asks; the menu fills in when it answers,
   * and again while the host is still indexing the folder.
   */
  #searchFiles(query: string): FileMatch[] {
    const cwd = this.#host.cwd();
    const found = this.#fileResults.get(`${cwd}\0${query}`, () =>
      this.#host.client
        .call("files.search", { cwd, query, limit: MENTION_LIMIT })
        .catch((error: unknown) => {
          this.#host.notice("warning", `File completion is unavailable: ${errorMessage(error)}`);
          return { matches: [], loading: false };
        }),
    );
    return found?.matches ?? [];
  }
}
