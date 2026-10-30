// The API extensions program against. An extension is a module whose default
// export receives an `ExtensionAPI`; it imports this module as
// `1harness/extension`, which resolves to the running 1harness wherever the
// extension lives:
//
//   import type { ExtensionAPI } from "1harness/extension";
//   export default function (api: ExtensionAPI) { api.on("turn.ended", ...) }
//
// Extensions work at three layers, each the same on every harness:
//   client  — commands, through `registerCommand`, shown by whichever client runs
//   session — events, messages, and approvals of every thread, through `on`,
//             `onInput`, and `onRequest`
//   agent   — tools the model can call, through `registerTool`, served to each
//             harness as an MCP server

import type { CommandDefinition, CommandUI } from "../commands/registry.ts";
import type {
  ApprovalOption,
  HarnessRequest,
  RequestResponse,
  ToolCallCheck,
  UserInput,
} from "../core/events.ts";
import type { Thread, ThreadEvent } from "../core/thread.ts";
import type { AcpAgentSpec } from "../drivers/acp/session.ts";
import type { DriverDefinition } from "../drivers/index.ts";

export type {
  AcpAgentSpec,
  CommandDefinition,
  DriverDefinition,
  CommandUI,
  HarnessRequest,
  RequestResponse,
  Thread,
  ThreadEvent,
  ToolCallCheck,
};

/** What a session handler can reach. */
export interface ExtensionContext {
  readonly thread: Thread;
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
  execute(input: Record<string, unknown>, context: ToolContext): ToolResult | Promise<ToolResult>;
}

export interface ExtensionAPI {
  /** The extension's name, from its file or folder name. */
  readonly name: string;
  readonly storage: ExtensionStorage;
  registerCommand(command: CommandDefinition): void;
  registerTool(tool: ToolDefinition): void;
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
   * Sees every tool call before it runs, in every permission mode, on harnesses
   * whose sessions have `capabilities.toolChecks`. Codex asks the user once to
   * trust the hook this needs. Applies to sessions started after it registers.
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
