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
  NoticeLevel,
} from "./core/events.ts";
import type { FileMatch } from "./core/files.ts";
import type { OperationInfo } from "./operations/operation.ts";
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
  /** How many of its runs a client has shown; later finished ones are news. */
  seenRuns: number;
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
  /** How the user answered a request: an approval's choice, or a question's answer. */
  | {
      type: "decision";
      kind: "approval" | "question";
      title: string;
      answer: string;
      outcome: "allowed" | "declined" | "answered" | "dismissed";
      at: number;
    }
  /** A page the agent showed the user, through its `html_render` tool. */
  | { type: "html"; title: string; html: string; at: number }
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

/**
 * Where a harness stands, the same for every harness: `ready` is installed and
 * signed in; `signed-out` is installed but must sign in, in its own CLI;
 * `missing` is not installed; `unchecked` is installed, with its sign-in not
 * known, as for a harness with no way to ask.
 */
export type HarnessState = "ready" | "signed-out" | "missing" | "unchecked";

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  state: HarnessState;
  /** What to do about the state, such as how to sign in or install it; null when ready. */
  detail: string | null;
  /** Why it cannot run here, or null when it can: the detail of `missing` and `signed-out`. */
  unavailable: string | null;
  /** The executable it runs, where it is installed. */
  path: string | null;
}

/** What the host asks of the client running a command, or tells it. */
export type UiRequest =
  | { id: string; method: "notify"; level: NoticeLevel; text: string }
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
      tabs: boolean;
    }
  | { id: string; method: "progress"; text: string }
  | {
      id: string;
      method: "settle";
      progress: string;
      level: NoticeLevel;
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
  | { seq: number; type: "notice"; level: NoticeLevel; text: string }
  | { seq: number; type: "ui"; clientId: string; request: UiRequest }
  /** A pending pick was answered or dropped; the client closes it. */
  | { seq: number; type: "ui.done"; clientId: string; id: string }
  /** What a check found of the harnesses, when it changed. */
  | { seq: number; type: "harnesses"; harnesses: HarnessInfo[] };

/** A thread a client can open again, from the host's records. */
export interface ThreadListing {
  id: string;
  title: string;
  harness: HarnessId;
  /** The model and reasoning effort it last ran with; null for the harness's default. */
  model: string | null;
  effort: string | null;
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
  /**
   * It is an agent 1harness does not run, as `1harness mcp` is: its operations
   * are held to what settings let such agents do.
   */
  agent?: boolean;
}

export interface HelloResult {
  version: string;
  protocol: number;
  /** This run of the host; a client whose events came from another starts over. */
  instance: string;
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
  /** Pages can run live here, with their scripts: the host has html2term and a Chromium. */
  live: boolean;
}

/** A frame of a live page: a base64 PNG and its size, in device and CSS pixels. */
export interface LiveFrame {
  data: string;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}

/** What the user does to a live page, in its CSS pixels. */
export type PageEvent =
  | { type: "click"; x: number; y: number }
  | {
      type: "mouse";
      action: "mousePressed" | "mouseMoved" | "mouseReleased";
      x: number;
      y: number;
      buttons?: number;
    }
  | { type: "wheel"; x: number; y: number; delta_y: number }
  | { type: "key"; key: string; modifiers?: number }
  | { type: "text"; text: string };

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
  /** The client is leaving; its threads keep working. */
  "client.bye": { params: Record<string, never>; result: null };
  "threads.list": {
    params: { scope: "open" | "recent" | "archived"; query?: string; limit?: number };
    result: ThreadListing[];
  };
  "thread.open": { params: OpenParams; result: ThreadState };
  /** Opens a stored thread or a native one: a 1harness ID or the start of one, or a harness's own. */
  "thread.resume": {
    /** `harness` resumes a harness's own ID there; a 1harness thread needs none. */
    params: { id: string; harness?: HarnessId; settings: SessionOptions };
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
    /**
     * `seq` is the feed position when it was sent; `ahead` is how many turns
     * end before the one it starts, which follows them. Both are absent on a
     * retry, which sent nothing.
     */
    result: { messageId: string; seq?: number; ahead?: number };
  };
  "thread.respond": {
    params: { threadId: string; requestId: string; response: RequestResponse };
    result: null;
  };
  "thread.stop": { params: { threadId: string }; result: null };
  /** The user has seen the thread's first `runs` runs, so finished ones are no longer news. */
  "thread.seen": { params: { threadId: string; runs: number }; result: null };
  "thread.close": { params: { threadId: string }; result: null };
  "thread.unqueue": { params: { threadId: string }; result: Message | null };
  "thread.rename": { params: { threadId: string; title: string }; result: null };
  /** Pins a thread to the top of listings, or archives one out of them; archiving closes it. */
  "thread.flag": {
    params: { threadId: string; pinned?: boolean; archived?: boolean };
    result: ThreadListing;
  };
  /**
   * A new thread on the same harness and folder that starts from this one's
   * turns, through `turn` or all of them, with a handoff of them.
   */
  "thread.fork": { params: { threadId: string; turn?: number }; result: ThreadState };
  /** Deletes a thread, and the threads it started, for good. */
  "thread.forget": { params: { threadId: string }; result: { forgotten: string[] } };
  /** Threads whose transcripts match, with where. */
  "threads.search": {
    params: { query: string; limit?: number };
    result: { thread: ThreadListing; snippet: string }[];
  };
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
  /** Every harness, after asking `id`, or all of them, whether it is installed and signed in. */
  "harnesses.list": { params: { id?: HarnessId }; result: HarnessInfo[] };
  /** What the client may call through `operations.call`, for the thread or its folder. */
  "operations.list": { params: { threadId?: string | null }; result: OperationInfo[] };
  /** Runs an operation, the same one agents call as a tool. */
  "operations.call": {
    params: { name: string; input?: Record<string, unknown>; threadId?: string | null };
    result: { result: unknown };
  };
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
  /**
   * An image where the host runs, as a base64 PNG no larger than the box in
   * pixels, for showing it; null when it is none. Without html2term on the
   * host, only a PNG comes, at its own size.
   */
  "files.image": {
    params: { path: string; width?: number; height?: number };
    result: { data: string } | null;
  };
  /**
   * A page kept running, scripts and all, for this client: its first frame,
   * `width` CSS pixels wide and as tall as its content unless `height` says.
   */
  "page.open": {
    params: { html: string; width: number; height?: number; scale: number; dark: boolean };
    result: LiveFrame & { id: string };
  };
  /** A live page's frame now; null when it shows what was last sent. */
  "page.frame": { params: { id: string }; result: LiveFrame | null };
  /** Passes what the user did to a live page; its frame after, or null when nothing changed. */
  "page.input": { params: { id: string; event: PageEvent }; result: LiveFrame | null };
  /** Gives a live page a viewport of another size, and with `scale` another density; its frame then. */
  "page.resize": {
    params: { id: string; width: number; height: number; scale?: number };
    result: LiveFrame;
  };
  "page.close": { params: { id: string }; result: null };
  /** HTML as a base64 PNG `width` CSS pixels wide and as tall as its content. */
  "media.html": {
    /** `transparent` leaves what the page does not paint clear, so it shows over the terminal. */
    params: { html: string; width: number; scale: number; dark: boolean; transparent?: boolean };
    result: { data: string };
  };
  "ui.reply": { params: { id: string; result: number | null }; result: null };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

/** What `GET /v1/hello` says about a server, before any client says hello. */
export interface ServerHello {
  name: "1harness";
  version: string;
  protocol: number;
  /** The oldest protocol it still speaks. */
  minProtocol: number;
  pid: number;
  startedAt: number;
  /** This run of the server, which `/v1/events?instance=` names to catch up within it. */
  instance: string;
  /** Started by a client, so it stops once idle. */
  autostarted: boolean;
  store: string | null;
  /** Who the server takes the caller to be, on listeners that tell. */
  identity: string | null;
}

/** A request the host refused, with a stable code a client can act on. */
export class RpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
