import type {
  Capabilities,
  HarnessId,
  InteractionMode,
  McpAction,
  McpActionResult,
  McpServer,
  ModelOption,
  RuntimeMode,
  SessionInfo,
  ThreadSummary,
} from "../core/events.ts";
import type { Message } from "../core/thread.ts";
import type { HarnessInfo, ThreadListing } from "../protocol.ts";

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
  /** The tab it goes under, when the pick has tabs. */
  group?: string;
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
    options?: { initial?: number; filter?: boolean; tabs?: boolean },
  ): Promise<number | null>;
  /** Shows work in progress; the returned function replaces it with how it went. */
  progress(text: string): (level: NoticeLevel, text: string) => void;
  /** Replaces the composer's text. */
  setInput(text: string): void;
  /**
   * Shows the client's list of threads, or with `query` the ones that
   * mention it, and opens the one chosen; where the client has such a list.
   */
  threads?(query: string): Promise<void>;
  /** Shows the thread's family as a tree, it and the agents under it, to open one. */
  lineage?(): Promise<void>;
}

/** The current thread as a command reaches it, wherever the thread runs. */
export interface CommandThread {
  /** 1harness's ID for it, a UUID. */
  readonly id: string;
  readonly closed: boolean;
  readonly busy: boolean;
  /** Its session closed, as an idle one is; a message or a session call wakes it. */
  readonly parked: boolean;
  /** Sends a message as the user, which queues while a turn runs. */
  send(text: string): Promise<void>;
  /** Takes back the message the user queued last. */
  unqueue(): Promise<Message | undefined>;
}

/**
 * What a command can ask of the thread's session. The optional methods are the
 * ones its harness has; calling any wakes a parked thread first.
 */
export interface SessionHandle {
  readonly capabilities: Capabilities;
  readonly info: SessionInfo;
  setRuntimeMode(mode: RuntimeMode): Promise<void>;
  setInteractionMode(mode: InteractionMode): Promise<void>;
  setModel?(model: string | null): Promise<void>;
  listModels?(): Promise<ModelOption[]>;
  setEffort?(effort: string | null): Promise<void>;
  compact?(): Promise<void>;
  listThreads?(): Promise<ThreadSummary[]>;
  listMcpServers?(): Promise<McpServer[]>;
  mcpAction?(action: McpAction, server: string): Promise<McpActionResult>;
}

/** What a command can reach: the client's UI and the current thread. */
export interface CommandContext {
  readonly ui: CommandUI;
  readonly harness: HarnessId;
  /** The current thread, or null when there is none. */
  readonly thread: CommandThread | null;
  readonly info: SessionInfo | null;
  /** The thread's session; throws when there is no thread. */
  session(): SessionHandle;
  /** The harnesses threads can run on. */
  harnesses(): HarnessInfo[];
  /** 1harness's threads, newest first, kept ones included. */
  threads(scope: "open" | "recent" | "archived"): Promise<ThreadListing[]>;
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
    /** A 1harness thread ID or the start of one, or a harness's own thread ID. */
    resume?: string;
    defaultModel?: boolean;
    /** The model to start on, and its effort; null for the harness's default. */
    model?: string | null;
    effort?: string | null;
  }): Promise<void>;
  /**
   * Moves the current thread onto another harness, which gets a handoff of the
   * turns it has not seen; with no thread running, starts one there instead.
   * `fresh` starts the harness a new thread rather than resuming its earlier
   * one, and can restart the current harness.
   */
  switchHarness(harness: HarnessId, options?: { fresh?: boolean }): Promise<void>;
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

/** The thread's session, parked or running, or null, for `available` checks. */
export function liveSession(context: CommandContext): SessionHandle | null {
  const thread = context.thread;
  return thread && !thread.closed ? context.session() : null;
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
