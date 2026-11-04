// The API extensions program against. An extension is a module whose default
// export receives an `ExtensionAPI`; it imports this module as
// `1harness/extension`, which resolves to the running 1harness wherever the
// extension lives:
//
//   import type { ExtensionAPI } from "1harness/extension";
//   export default function (api: ExtensionAPI) { api.on("turn.ended", ...) }
//
// Extensions work at four layers, each the same on every harness:
//   client    — commands, through `registerCommand`, shown by whichever client runs;
//               a command's `shortcut` binds a key, `ui.setStatus` writes on the
//               status line, and `registerToolRenderer` says how tool calls show
//   session   — events, messages, and approvals of every thread, through `on`,
//               `onInput`, and `onRequest`
//   agent     — tools the model can call, through `registerTool`, served to each
//               harness as an MCP server; agents find them with `tool_search`
//               unless they are `direct`
//   operation — what people, programs, and agents inside and outside 1harness can
//               all call, through `registerOperation`: a tool, `/op`, `1harness op`,
//               `1harness mcp`, and the server's API at once; `runOperation` calls
//               them from an extension, to open, follow, and message threads

import type { CommandDefinition, CommandUI } from "../commands/registry.ts";
import type {
  ApprovalOption,
  HarnessRequest,
  RequestResponse,
  ToolCallCheck,
  UserInput,
} from "../core/events.ts";
import type { Thread, ThreadEvent, ToolRenderer } from "../core/thread.ts";
import type { AcpAgentSpec } from "../drivers/acp/session.ts";
import type { DriverDefinition } from "../drivers/index.ts";
import type {
  Caller,
  CallerKind,
  Operation,
  OperationContext,
  OperationInfo,
} from "../operations/operation.ts";

export type {
  AcpAgentSpec,
  Caller,
  CallerKind,
  OperationContext,
  OperationInfo,
  CommandDefinition,
  DriverDefinition,
  CommandUI,
  HarnessRequest,
  RequestResponse,
  Thread,
  ThreadEvent,
  ToolCallCheck,
  ToolRenderer,
};

/** What a session handler can reach. */
export interface ExtensionContext {
  /**
   * The thread. Its `session` is null while the thread is parked, after its
   * session ended or closed for being idle, until a message wakes it; read
   * `thread.info` and `thread.capabilities`, which stay, and `await
   * thread.wake()` for a session to call.
   */
  readonly thread: Thread;
  /** 1harness's ID for the thread, which operations take; null where nothing manages it. */
  readonly threadId: string | null;
  /** The client's UI, or null when nobody is watching, as with `--print`. */
  readonly ui: CommandUI | null;
}

export type EventHandler<T extends ThreadEvent["type"]> = (
  event: Extract<ThreadEvent, { type: T }>,
  context: ExtensionContext,
) => void | Promise<void>;

/** Returns a response to answer the request, or undefined to leave it to others. */
export type RequestHandler = (
  request: HarnessRequest,
  context: ExtensionContext,
) => RequestResponse | undefined | Promise<RequestResponse | undefined>;

/** Returns a replacement message, null to drop it, or undefined to keep it. */
export type InputHandler = (
  input: UserInput,
  context: ExtensionContext,
) => UserInput | null | undefined | Promise<UserInput | null | undefined>;

/** Returns a reason to block the call, which the agent sees, or undefined to allow it. */
export type ToolCallHandler = (
  call: ToolCallCheck,
  context: ExtensionContext,
) => string | undefined | Promise<string | undefined>;

/** JSON values kept for an extension across runs. */
export interface ExtensionStorage {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

/** What a tool returns: text, or MCP content such as images. */
export type ToolResult = string | { content: unknown[]; isError?: boolean };

export interface ToolContext {
  /** The thread whose agent called the tool. */
  readonly thread: Thread;
  /** The ID of the tool call item in that thread, where its harness says which call this is. */
  readonly callId?: string;
}

/** A tool every harness's agent can call, served to it over MCP. */
export interface ToolDefinition {
  /** Letters, digits, `_` and `-`; harnesses show it under the `1harness` server. */
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  inputSchema: Record<string, unknown>;
  /** Marks a tool that only reads, which harnesses may run with fewer prompts. */
  readOnly?: boolean;
  /**
   * Offers it to agents by name, in every thread's context. Other tools are
   * found with `tool_search` and cost nothing until then, so keep this for a
   * tool agents should reach for without looking.
   */
  direct?: boolean;
  execute(input: Record<string, unknown>, context: ToolContext): ToolResult | Promise<ToolResult>;
}

/**
 * Something people, programs, and agents can all call. `run` gets who called:
 * check `context.caller.kind`, and for an agent in a 1harness thread, its
 * `thread`. Its result is JSON, or text.
 */
export type OperationDefinition = Omit<Operation, "effect" | "callers"> & {
  /** A read changes nothing; `act` by default. */
  effect?: Operation["effect"];
  /** Who may call it; everyone by default. */
  callers?: readonly CallerKind[];
};

export interface ExtensionAPI {
  /** The extension's name, from its file or folder name. */
  readonly name: string;
  readonly storage: ExtensionStorage;
  registerCommand(command: CommandDefinition): void;
  registerTool(tool: ToolDefinition): void;
  /**
   * Adds an operation: a tool for agents in 1harness threads, `/op` and
   * `1harness op` for people, `operations.call` for programs, and a tool for
   * agents outside 1harness through `1harness mcp`, as `callers` allows.
   */
  registerOperation(operation: OperationDefinition): void;
  /** The operations `runOperation` can call: 1harness's, and those of the extensions loaded here. */
  operations(): Promise<OperationInfo[]>;
  /**
   * Calls an operation as the user would, so an extension can open, follow, and
   * message threads on its own, such as from a handler: `thread_open`,
   * `thread_wait`, `thread_read`, `thread_send`. It acts with the user's
   * authority, which installing the extension gave it. Not while extensions
   * load; start from a handler or a command.
   */
  runOperation(name: string, input?: Record<string, unknown>): Promise<unknown>;
  /**
   * Starts a task as `delegate_task` does for the agent in `thread`, optionally
   * in a folder the extension chose, such as one it prepared. Only an extension
   * can choose: a sandboxed agent could otherwise start a child outside its
   * sandbox. Pass the `callId` of the tool call this serves to tie the task to it.
   */
  delegate(
    thread: Thread,
    input: Record<string, unknown>,
    options?: { cwd?: string; callId?: string },
  ): Promise<unknown>;
  /**
   * Chooses the line tool calls show as, returning it, or undefined to leave a
   * call to the next renderer. It runs on the server, on each change to a call,
   * so it should be quick.
   */
  registerToolRenderer(render: ToolRenderer): void;
  /** Runs on each event of every thread. */
  on<T extends ThreadEvent["type"]>(type: T, handler: EventHandler<T>): void;
  /** Sees each message before it is sent or queued. */
  onInput(handler: InputHandler): void;
  /**
   * Sees each approval and question before the user does. A harness asks only
   * what its permission mode makes it ask, so a policy can only answer those.
   */
  onRequest(handler: RequestHandler): void;
  /**
   * Sees tool calls before they run, in every permission mode. It always covers
   * 1harness's own tools, on every harness and from the moment it registers,
   * with a call through `tool_read` or `tool_act` seen as the tool it reaches.
   * Other tools need a session with `capabilities.toolChecks`, started after it
   * registers. For those, Codex asks the user once to trust the hook this needs,
   * and blocks a call whose check takes over four minutes.
   */
  onToolCall(handler: ToolCallHandler): void;
  /**
   * Runs before the extension is reloaded or 1harness exits: stop timers,
   * servers, and watchers it started. What it registered is removed for it.
   */
  onUnload(handler: () => void | Promise<void>): void;
  /**
   * Adds a harness, selectable with `/harness` and `--harness`. Most agents
   * need only `acpAgent`; a full driver implements `HarnessSession` itself.
   */
  registerDriver(driver: DriverDefinition): void;
  /** A driver for an agent that speaks the Agent Client Protocol over stdio. */
  acpAgent(spec: AcpAgentSpec): DriverDefinition;
  /** Answers an approval with its first option that has `effect`; see `choose`. */
  choose(request: HarnessRequest, effect: ApprovalOption["effect"]): RequestResponse | undefined;
}

/** An extension module's default export. */
export type Extension = (api: ExtensionAPI) => void | Promise<void>;

/** Answers an approval with its first option that has `effect`, if it has one. */
export function choose(
  request: HarnessRequest,
  effect: ApprovalOption["effect"],
): RequestResponse | undefined {
  if (request.kind !== "approval") return undefined;
  const option = request.options.find((candidate) => candidate.effect === effect);
  return option ? { kind: "approval", optionId: option.id } : undefined;
}
