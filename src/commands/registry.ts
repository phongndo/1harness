import type { HarnessId, HarnessSession, SessionInfo } from "../core/events.ts";
import type { Thread } from "../core/thread.ts";

/** Report text, styled by the client so it follows theme changes. */
export interface ReportSpan {
  text: string;
  tone: "strong" | "text" | "soft" | "muted" | "good" | "bad";
}

/** A command's output: a heading over lines of spans, with the last span wrapping. */
export interface Report {
  title: string;
  lines: ReportSpan[][];
}

export interface PickEntry {
  label: string;
  detail?: string;
  /** Shown at the right edge, such as `current`. */
  tag?: string;
}

export type NoticeLevel = "info" | "warning" | "error";

/** How a client shows things to the user and asks them, for commands to use. */
export interface CommandUI {
  notify(level: NoticeLevel, text: string): void;
  report(report: Report): void;
  /** A read-only panel of labelled values. */
  panel(title: string, rows: [string, string][]): void;
  /** Resolves with the chosen entry's index, or null when dismissed. */
  pick(
    title: string,
    entries: PickEntry[],
    options?: { initial?: number; filter?: boolean },
  ): Promise<number | null>;
  /** Shows work in progress; the returned function replaces it with how it went. */
  progress(text: string): (level: NoticeLevel, text: string) => void;
  /** Replaces the composer's text. */
  setInput(text: string): void;
}

/** What a command can reach: the client's UI and the current thread. */
export interface CommandContext {
  readonly ui: CommandUI;
  readonly harness: HarnessId;
  /** The current thread, or null when none is running. */
  readonly thread: Thread | null;
  readonly info: SessionInfo | null;
  /** The running session; throws when there is none. */
  session(): HarnessSession;
  /**
   * A list kept for the current thread, such as models. The first call starts
   * fetching it and returns nothing; completion menus fill in when it arrives.
   */
  lookup<T>(key: string, load: () => Promise<T[]>): T[];
  /** The same list, waiting for it when it is not there yet. */
  fetch<T>(key: string, load: () => Promise<T[]>): Promise<T[]>;
  forget(key: string): void;
  /** Starts a thread: another harness, a resumed one, or a fresh one by default. */
  openThread(options?: {
    harness?: HarnessId;
    resume?: string;
    defaultModel?: boolean;
  }): Promise<void>;
  exit(): Promise<void>;
}

/** A word that can follow a command, offered as it is typed. */
export interface Completion {
  value: string;
  detail: string;
  /** Another word follows it, so choosing it keeps the menu open. */
  more: boolean;
}

/** Candidates for the word being typed, which starts at `start` in the arguments. */
export interface Completions {
  start: number;
  items: Completion[];
}

/** A `/name` command. 1harness's own commands and extensions' use the same shape. */
export interface CommandDefinition {
  name: string;
  aliases?: readonly string[];
  /** The arguments as help shows them, such as `[id]`. */
  usage?: string;
  description: string;
  /** The help tab it appears under. */
  group: string;
  /** False hides it, such as for a harness without the feature. */
  available?(context: CommandContext): boolean;
  complete?(context: CommandContext, args: string): Completions | null;
  run(context: CommandContext, args: string): Promise<void> | void;
}

export function completion(value: string, detail = "", more = false): Completion {
  return { value, detail, more };
}

/** The running session, or null, for `available` checks. */
export function liveSession(context: CommandContext): HarnessSession | null {
  const thread = context.thread;
  return thread && !thread.closed ? thread.session : null;
}

export class CommandRegistry {
  #commands = new Map<string, CommandDefinition>();

  /** Adds a command, replacing one of the same name. Returns a function that removes it. */
  register(command: CommandDefinition): () => void {
    this.#commands.set(command.name, command);
    return () => {
      if (this.#commands.get(command.name) === command) this.#commands.delete(command.name);
    };
  }

  /** The command with this name or alias. */
  find(name: string): CommandDefinition | undefined {
    return (
      this.#commands.get(name) ??
      [...this.#commands.values()].find((command) => command.aliases?.includes(name))
    );
  }

  list(): CommandDefinition[] {
    return [...this.#commands.values()];
  }
}
