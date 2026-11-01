// What a client and the host say to each other, the same in-process and over
// the server's socket: requests a client makes, the events it is sent, and
// the thread state both sides agree on. Everything here is plain JSON.

import type { Completions, PickEntry, Report } from "./commands/registry.ts";
import type {
  Capabilities,
  HarnessId,
  HarnessRequest,
  InteractionMode,
  Item,
  McpAction,
  NativeCommand,
  RequestResponse,
  RuntimeMode,
  SessionInfo,
  SessionMethod,
  SessionOptions,
  TurnStatus,
  Usage,
} from "./core/events.ts";
import type { FileMatch } from "./core/files.ts";
import type { Message } from "./core/thread.ts";
import type { RunRecord, SwitchResult, ThreadStatus } from "./host/manager.ts";

/** Bumped when a change would break a client of the previous version. */
export const PROTOCOL_VERSION = 1;

/** A thread as every client sees it, running or parked. */
export interface ThreadState {
  id: string;
  title: string;
  harness: HarnessId;
  parentId: string | null;
  /** The parent's tool call that started it, where the parent's harness said which. */
  parentCallId: string | null;
  origin: "user" | "delegated";
  createdAt: number;
  /** When it last did anything. */
  updatedAt: number;
  status: ThreadStatus;
  /** Why its session ended, when it ended badly. */
  error: string | null;
  /** The session's info, or the last session's while it is parked. */
  info: SessionInfo;
  capabilities: Capabilities;
  /** The optional session methods its harness has, which `thread.call` runs. */
  methods: SessionMethod[];
  busy: boolean;
  queue: Message[];
  /** Restored after a restart, the queue waits until the thread is sent something. */
  held: boolean;
  /** Open approvals and questions, oldest first. */
  requests: HarnessRequest[];
  usage: Usage | null;
  /** How many runs it has; `lastRun` is the newest. */
  runCount: number;
  lastRun: RunRecord | null;
  /** Work its harness runs between turns, such as background agents. */
  background: string[];
  /** Bumped when the harness's own commands may have changed, so clients list them again. */
  commandsVersion: number;
  /** The client that opened it, which shows it; null for agents' threads. */
  openedBy: string | null;
  pinned: boolean;
  archived: boolean;
}

/** A turn's estimated tokens, as the transcript's summary line shows them. */
export interface TurnTokens {
  up: number;
  down: number;
}

/**
 * One step of a thread's transcript. A thread's log is these in order, and
 * replaying it shows the transcript as it was shown live: items are kept in
 * place as they change, at the point they first appeared.
 */
export type LogEntry =
  | { type: "turn.started"; turnId: string; at: number }
  | ({
      type: "turn.ended";
      turnId: string;
      status: TurnStatus;
      error: string | null;
      at: number;
    } & TurnTokens)
  /** An item as it now stands; `message` is the one a `user_message` echoes, where known. */
  | { type: "item"; item: Item; done: boolean; message?: Message }
  /** Text streamed into an item; live only, since the item's entry holds the text. */
  | { type: "delta"; itemId: string; chunk: string }
  /** A thread this one started, whose row goes here. */
  | { type: "agent"; threadId: string }
  | { type: "session.ended"; error: string | null };

export interface LoggedEntry {
  seq: number;
  entry: LogEntry;
}

/** A command the host runs, such as an extension's, as a client lists it. */
export interface CommandInfo {
  name: string;
  aliases: string[];
  usage: string | null;
  description: string;
  group: string;
  /** Whether it runs for the thread it was listed for. */
  available: boolean;
  /** Whether `commands.complete` offers words for its arguments. */
  completes: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  /** Why it cannot run here, or null when it can. */
  unavailable: string | null;
}

/** What the host asks of the client running a command, or tells it. */
export type UiRequest =
  | { id: string; method: "notify"; level: "info" | "warning" | "error"; text: string }
  | { id: string; method: "report"; report: Report }
  | { id: string; method: "panel"; title: string; rows: [string, string][] }
  /** Answered with `ui.reply`: the chosen index, or null. */
  | {
      id: string;
      method: "pick";
      title: string;
      entries: PickEntry[];
      initial: number;
      filter: boolean;
    }
  | { id: string; method: "progress"; text: string }
  | {
      id: string;
      method: "settle";
      progress: string;
      level: "info" | "warning" | "error";
      text: string;
    }
  | { id: string; method: "setInput"; text: string }
  /** Show this thread, as one a command opened. */
  | { id: string; method: "show"; threadId: string }
  | { id: string; method: "exit" };

/** One event of the host's feed, numbered in order. */
export type HostEvent =
  | { seq: number; type: "thread"; thread: ThreadState }
  /** A thread left the feed, such as an empty one discarded. */
  | { seq: number; type: "removed"; threadId: string }
  | { seq: number; type: "entry"; threadId: string; entry: LogEntry }
  /** Something every client should show, such as an extension that failed. */
  | { seq: number; type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { seq: number; type: "ui"; clientId: string; request: UiRequest }
  /** A pending pick was answered or dropped; the client closes it. */
  | { seq: number; type: "ui.done"; clientId: string; id: string }
  | { seq: number; type: "commands" }
  | { seq: number; type: "harnesses"; harnesses: HarnessInfo[] };

/** A thread a client can open again, from the host's records. */
export interface ThreadListing {
  id: string;
  title: string;
  harness: HarnessId;
  cwd: string;
  status: ThreadStatus;
  parentId: string | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Runs finished since a client last showed it. */
  unseen: boolean;
  /** The harness's own thread ID. */
  native: string | null;
}

export interface HelloParams {
  clientId: string;
  /** The folder the client runs in, for extensions and listings. */
  cwd: string;
  version: string;
  /** Extension modules this client loads, as `-x` named them. */
  extensions: string[];
}

export interface HelloResult {
  version: string;
  protocol: number;
  /** Events after this one follow; earlier ones are in this snapshot. */
  seq: number;
  threads: ThreadState[];
  harnesses: HarnessInfo[];
  commands: CommandInfo[];
  /** Pick requests still waiting for this client, from before it reconnected. */
  pending: UiRequest[];
  /** Problems to show once, such as with config files. */
  warnings: string[];
  /** Where the host keeps its records; null when it keeps none. */
  store: string | null;
}

export interface OpenParams {
  harness: HarnessId;
  settings: SessionOptions;
  title?: string;
}

export interface AttachResult {
  thread: ThreadState;
  /** The newest entries, oldest first, up to the limit. */
  entries: LoggedEntry[];
  /** Earlier entries exist; ask again with `before`. */
  more: boolean;
  /** The feed position this page reflects; later events apply on top. */
  cursor: number;
  /** The threads it started, for their rows. */
  children: ThreadState[];
}

/** Session operations `thread.call` runs, with their arguments. */
export interface SessionCalls {
  listModels: [];
  setModel: [model: string | null];
  setEffort: [effort: string | null];
  setRuntimeMode: [mode: RuntimeMode];
  setInteractionMode: [mode: InteractionMode];
  compact: [];
  listThreads: [];
  listCommands: [];
  listMcpServers: [];
  mcpAction: [action: McpAction, server: string];
}

export type SessionCall = keyof SessionCalls;

export const SESSION_CALLS: readonly SessionCall[] = [
  "listModels",
  "setModel",
  "setEffort",
  "setRuntimeMode",
  "setInteractionMode",
  "compact",
  "listThreads",
  "listCommands",
  "listMcpServers",
  "mcpAction",
];

/** Every request a client can make: its parameters and what it resolves with. */
export interface Methods {
  "client.hello": { params: HelloParams; result: HelloResult };
  /** The thread the client shows, or null; extensions' UI goes to the client showing a thread. */
  "client.show": { params: { threadId: string | null }; result: null };
  "threads.list": {
    params: { scope: "open" | "recent" | "archived"; cwd?: string; query?: string; limit?: number };
    result: ThreadListing[];
  };
  "thread.open": { params: OpenParams; result: ThreadState };
  /** Opens a stored thread or a native one: a 1harness ID such as `t42`, or a harness's own. */
  "thread.resume": {
    params: { id: string; harness: HarnessId; settings: SessionOptions };
    result: ThreadState;
  };
  "thread.attach": {
    params: { threadId: string; before?: number; limit?: number };
    result: AttachResult;
  };
  "thread.send": {
    params: {
      threadId: string;
      text: string;
      /** Join the running turn where the harness can; queue otherwise. */
      steer?: boolean;
      /** A harness command, sent as written. */
      command?: boolean;
      /** The client's own ID for this message; a retry with the same ID sends nothing. */
      requestId?: string;
    };
    result: { messageId: string | null };
  };
  "thread.respond": {
    params: { threadId: string; requestId: string; response: RequestResponse };
    result: null;
  };
  "thread.stop": { params: { threadId: string }; result: null };
  "thread.close": { params: { threadId: string }; result: null };
  "thread.unqueue": { params: { threadId: string }; result: Message | null };
  "thread.switchHarness": {
    params: { threadId: string; harness: HarnessId; fresh?: boolean };
    result: SwitchResult;
  };
  "thread.call": {
    params: { threadId: string; method: SessionCall; args: unknown[] };
    result: unknown;
  };
  /** Runs one of the harness's own commands that does not start a turn. */
  "thread.command": {
    params: { threadId: string; command: NativeCommand; args: string };
    result: null;
  };
  "harnesses.list": { params: Record<string, never>; result: HarnessInfo[] };
  "commands.list": { params: { threadId: string | null }; result: CommandInfo[] };
  "commands.run": {
    params: { threadId: string | null; name: string; args: string };
    result: null;
  };
  "commands.complete": {
    params: { threadId: string | null; name: string; args: string };
    result: Completions | null;
  };
  "files.search": {
    params: { cwd: string; query: string; limit: number };
    result: { matches: FileMatch[]; loading: boolean };
  };
  "ui.reply": { params: { id: string; result: number | null }; result: null };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

/** A request the host refused, with a stable code a client can act on. */
export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
