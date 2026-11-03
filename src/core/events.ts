// The harness-neutral vocabulary. Drivers translate native protocols into these
// types; clients render only these and read capabilities, never the harness kind.

/** A driver's ID, such as `claude` or `codex`; drivers register themselves. */
export type HarnessId = string;

/** How much the agent may do without asking. Each driver maps it onto native enforcement. */
export type RuntimeMode = "supervised" | "auto-edit" | "auto" | "full-access";
/** Narrowest first. */
export const RUNTIME_MODES: readonly RuntimeMode[] = [
  "supervised",
  "auto-edit",
  "auto",
  "full-access",
];

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return RUNTIME_MODES.some((mode) => mode === value);
}

/** How much a mode allows: 0 for the narrowest. */
export function modeRank(mode: RuntimeMode): number {
  return RUNTIME_MODES.indexOf(mode);
}

/** The mode threads start in unless the user's settings or `--mode` say otherwise. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/**
 * The broadest of `offered` at or below `requested`, so a harness without a
 * mode steps down instead of up; null when it has none that narrow.
 */
export function fitRuntimeMode(
  requested: RuntimeMode,
  offered: readonly RuntimeMode[],
): RuntimeMode | null {
  const fits = RUNTIME_MODES.filter(
    (mode) => modeRank(mode) <= modeRank(requested) && offered.includes(mode),
  );
  return fits.at(-1) ?? null;
}

export type InteractionMode = "default" | "plan";

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
  /** A unified diff of the change, or of the proposed change before it is applied. */
  diff: string;
  /** Set when an update also moved the file. */
  movePath?: string;
}

/** What a shell command does, as the harness parsed it, for friendlier display. */
export type CommandAction =
  | { type: "read"; path: string }
  | { type: "list"; path: string | null }
  | { type: "search"; query: string | null; path: string | null }
  | { type: "other" };

export interface TodoStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type Item =
  | {
      kind: "user_message";
      id: string;
      text: string;
      /** The `UserInput.id` this echoes, where the harness reports it. */
      inputId?: string;
    }
  | { kind: "assistant_message"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "command";
      id: string;
      command: string;
      output: string;
      exitCode: number | null;
      status: ItemStatus;
      /** Parsed actions, when the harness provides them. */
      actions?: CommandAction[];
    }
  | { kind: "file_change"; id: string; changes: FileChange[]; status: ItemStatus }
  | {
      kind: "tool_call";
      id: string;
      tool: string;
      server: string | null;
      /** What the tool does, set by the driver that knows the harness's tool names. */
      category: ToolCategory;
      summary: string;
      output: string;
      status: ItemStatus;
    }
  | { kind: "web_search"; id: string; query: string; status: ItemStatus }
  | { kind: "todo_list"; id: string; steps: TodoStep[] }
  | { kind: "plan"; id: string; text: string }
  | { kind: "agent"; id: string; description: string; summary: string; status: ItemStatus }
  | { kind: "notice"; id: string; level: NoticeLevel; text: string };

export type NoticeLevel = "info" | "warning" | "error";

/** Tool calls that read, search, or fetch are grouped as exploration. */
export type ToolCategory = "read" | "search" | "fetch" | "other";

export interface ApprovalOption {
  /** The harness's own decision ID, passed back unchanged. */
  id: string;
  label: string;
  /** What choosing it does, so code can answer without reading labels. */
  effect: "allow" | "allow-always" | "deny" | "other";
}

/** What an approval is for, so code can decide without parsing its text. */
export type ApprovalAction =
  | { type: "command"; command: string; cwd: string | null }
  | { type: "file_change"; paths: string[] }
  | { type: "tool"; tool: string; server: string | null; input: unknown }
  | { type: "other" };

/** A tool call about to run, as a policy sees it on any harness. */
export interface ToolCallCheck {
  /** The harness's name for the tool, such as `Bash` or `mcp__docs__search`. */
  tool: string;
  input: unknown;
  action: ApprovalAction;
}

/**
 * Checks every tool call before it runs, in every permission mode: returns a
 * reason to block it, which the agent sees, or undefined to let it through.
 */
export type ToolPolicy = (call: ToolCallCheck) => Promise<string | undefined>;

export interface ApprovalRequest {
  kind: "approval";
  id: string;
  title: string;
  detail: string;
  action: ApprovalAction;
  options: ApprovalOption[];
  /** Selected first; a decline when the harness asks that approval not be one keystroke away. */
  defaultOptionId: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  secret: boolean;
}

export interface QuestionRequest {
  kind: "question";
  id: string;
  questions: Question[];
}

export type HarnessRequest = ApprovalRequest | QuestionRequest;

export type RequestResponse =
  | { kind: "approval"; optionId: string }
  | { kind: "question"; answers: Record<string, string[]> }
  /**
   * Turns an approval down but lets the agent carry on, telling it why. For code
   * that answers for the user, such as a policy; a person picks an option.
   */
  | { kind: "decline"; reason: string }
  | { kind: "cancel" };

export interface SessionInfo {
  harness: HarnessId;
  /** The native thread or session ID, used to resume. Null until the harness assigns one. */
  threadId: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  version: string | null;
  /** The name the harness gave the session for what it is doing, once it has given one. */
  title?: string | null;
}

/** One subscription usage window, such as a five-hour or weekly limit. */
export interface RateLimit {
  label: string;
  /** 0–100, or null when the harness only reports the status. */
  usedPercent: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  status: "ok" | "warning" | "exceeded";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  /** Subscription limits, newest snapshot. */
  limits: RateLimit[];
}

export type TurnStatus = "completed" | "interrupted" | "failed";

export type HarnessEvent =
  | { type: "session.updated"; info: SessionInfo }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.ended"; turnId: string; status: TurnStatus; error: string | null }
  | { type: "item.started"; item: Item }
  | { type: "item.updated"; item: Item }
  | { type: "item.completed"; item: Item }
  /** Text for messages, reasoning, and plans; output for commands and tools. */
  | { type: "item.delta"; itemId: string; chunk: string }
  | { type: "request.opened"; request: HarnessRequest }
  | { type: "request.resolved"; requestId: string }
  | { type: "usage.updated"; usage: Usage }
  /** The harness's own commands changed; clients refetch them with `listCommands`. */
  | { type: "commands.updated" }
  | { type: "session.closed"; error: string | null };

export interface Capabilities {
  /** Messages can join the running turn instead of waiting for it to finish. */
  steer: boolean;
  planMode: boolean;
  /** The runtime modes the harness can carry out; `MODE_DESCRIPTIONS` says what each means. */
  runtimeModes: readonly RuntimeMode[];
  /** Messages can carry images. */
  images: boolean;
  /** `SessionOptions.toolPolicy` sees every tool call, even in full access. */
  toolChecks: boolean;
  /** Unknown slash commands are sent to the harness, which runs its own. */
  nativeSlashCommands: boolean;
  /** What `mcpAction` can do with this harness's MCP servers. */
  mcpActions: readonly McpAction[];
}

export type McpServerState =
  | "connected"
  | "starting"
  | "needs-login"
  | "failed"
  | "disabled"
  | "stopped";

/** An MCP server a session uses, as its harness reports it. */
export interface McpServer {
  name: string;
  state: McpServerState;
  /** Where the harness found it: a config file, a scope such as `project`, or a plugin. */
  source: string | null;
  transport: "stdio" | "http" | "sse" | null;
  /** The command it runs, or its URL. */
  target: string | null;
  /** How the harness signs in to it, such as `OAuth`. */
  auth: string | null;
  error: string | null;
  tools: string[];
}

export type McpAction = "login" | "reconnect" | "enable" | "disable";

export interface McpActionResult {
  /** What the harness did, in its own terms. */
  message: string;
  /** A page to open, such as a login. */
  url: string | null;
}

export interface ModelOption {
  id: string;
  /** Other IDs this option stands for, such as the full model ID behind an alias. */
  aliases: string[];
  label: string;
  description: string;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
}

/**
 * A command or skill the harness runs itself, typed as `/name args` in the
 * composer. Drivers list what works inside a session and leave out what
 * belongs to the harness's own terminal UI.
 */
export interface NativeCommand {
  name: string;
  /** Other names that run it, such as Claude's /cost for /usage. */
  aliases: string[];
  description: string;
  argumentHint: string;
  /** A skill gives the agent instructions; a command is the harness's own. */
  kind: "command" | "skill";
  /**
   * Whether it runs as a turn: sent as the message `/name args`, it waits for a
   * running turn. Others run at once through `runCommand`, even mid-turn.
   */
  startsTurn: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface UserInput {
  /**
   * Set by the thread that sends it. The driver echoes it as the
   * `user_message`'s `inputId`, so the thread knows which message that is.
   */
  id?: string;
  /** Set by the thread: whether the user wrote it, rather than another thread. */
  fromUser?: boolean;
  text: string;
  /** Local images sent with the text, where `capabilities.images` allows. */
  images?: string[];
}

/** An MCP server 1harness adds to a session, besides the harness's own. */
export type McpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | {
      type: "http";
      url: string;
      headers: Record<string, string>;
      /** How long one tool call may take, for tools that wait on other work. */
      timeoutSec?: number;
    };

export interface SessionOptions {
  cwd: string;
  model: string | null;
  effort: string | null;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** A native thread ID to resume instead of starting a new thread. */
  resume: string | null;
  /** Servers to add for this session only; the harness's config is left alone. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Runs before each tool call where `capabilities.toolChecks` says it can. */
  toolPolicy?: ToolPolicy;
}

/** Optional `HarnessSession` methods, which clients check for rather than for a harness. */
export const SESSION_METHODS = [
  "setModel",
  "listModels",
  "setEffort",
  "compact",
  "listThreads",
  "listCommands",
  "runCommand",
  "listMcpServers",
  "mcpAction",
] as const;

export type SessionMethod = (typeof SESSION_METHODS)[number];

/**
 * One live conversation with a harness. `events` has a single consumer and ends
 * after `session.closed`. Commands resolve when the harness accepts them, not
 * when the resulting work finishes. Optional methods are ones a harness may
 * lack; clients check for them rather than for a harness.
 */
export interface HarnessSession {
  readonly capabilities: Capabilities;
  readonly info: SessionInfo;
  readonly events: AsyncIterable<HarnessEvent>;
  start(): Promise<void>;
  startTurn(input: UserInput): Promise<void>;
  steer(input: UserInput): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, response: RequestResponse): Promise<void>;
  setRuntimeMode(mode: RuntimeMode): Promise<void>;
  setInteractionMode(mode: InteractionMode): Promise<void>;
  close(): Promise<void>;
  setModel?(model: string | null): Promise<void>;
  listModels?(): Promise<ModelOption[]>;
  setEffort?(effort: string | null): Promise<void>;
  compact?(): Promise<void>;
  /** Earlier threads in the session's folder, for resuming. */
  listThreads?(): Promise<ThreadSummary[]>;
  /** Commands and skills the harness runs when sent as `/name args` through `startTurn`. */
  listCommands?(): Promise<NativeCommand[]>;
  /** Runs a listed command that does not start a turn; it reports through notices. */
  runCommand?(name: string, args: string): Promise<void>;
  /** The session's MCP servers, from every source the harness reads. */
  listMcpServers?(): Promise<McpServer[]>;
  /** Runs one of `capabilities.mcpActions` on a server. */
  mcpAction?(action: McpAction, server: string): Promise<McpActionResult>;
  /**
   * The ID of the tool call item behind a call to `tool`, one of 1harness's MCP
   * tools: from the `_meta` the harness sends with the call, where it says
   * which, or null when it cannot tell.
   */
  mcpCallId?(meta: Record<string, unknown>, tool: string): string | null;
  /**
   * Work the harness keeps doing after a turn ends, such as background agents,
   * which closing the session would stop: one description per task.
   */
  backgroundTasks?(): string[];
}
