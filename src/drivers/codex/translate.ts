import {
  modeRank,
  type CommandAction,
  type FileChange,
  type HarnessEvent,
  type Item,
  type ItemStatus,
  type McpServer,
  type McpServerState,
  type RateLimit,
  type RuntimeMode,
  type TurnStatus,
  type Usage,
  type NoticeLevel,
} from "../../core/events.ts";
import { limitNotice } from "../../core/wording.ts";
import { truncate } from "../../core/wording.ts";
import { todoStatus } from "../text.ts";
import { INIT_PROMPT } from "./prompts.ts";

// The subset of the app-server protocol this driver reads. Generate the full
// bindings with `codex app-server generate-ts --experimental --out <dir>`.
// Items of other types reach the translator as well, typed as these, and are dropped.

type JsonValue = unknown;

export type CodexCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type CodexWebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type CodexThreadItem =
  | { type: "userMessage"; id: string; clientId?: string | null; content: CodexUserInput[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      status: string;
      commandActions: CodexCommandAction[] | null;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[];
      status: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: JsonValue;
      result: { content: JsonValue[] } | null;
      error: { message: string } | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: JsonValue;
      status: string;
      contentItems: { type: string; text?: string }[] | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: string;
      prompt: string | null;
      receiverThreadIds: string[] | null;
      agentsStates: Record<string, { status: string; message: string | null } | undefined> | null;
    }
  | { type: "subAgentActivity"; id: string; kind: string; agentThreadId: string; agentPath: string }
  | { type: "webSearch"; id: string; query: string; action: CodexWebSearchAction | null }
  | { type: "imageView"; id: string; path: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: string; [key: string]: unknown };

export interface CodexTurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: CodexTurnError | null;
  startedAt: number | null;
}

export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: "dangerFullAccess" }
  | { type: "externalSandbox"; networkAccess: unknown };

export interface CodexRuntimePolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: CodexSandboxPolicy;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/**
 * Maps a runtime mode onto Codex's approval policy and sandbox, so each mode
 * is enforced by Codex itself. Supervised uses `untrusted`:
 * under Codex's on-request read-only preset, models tend to report the
 * workspace as read-only instead of asking to edit. `base` is the thread's
 * effective sandbox from the user's config; its writable roots and network
 * access carry over instead of being reset every turn.
 */
export function codexRuntimePolicy(
  mode: RuntimeMode,
  base: CodexSandboxPolicy | null = null,
): CodexRuntimePolicy {
  const configured = base?.type === "workspaceWrite" ? base : null;
  const workspaceWrite: CodexSandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: configured?.writableRoots ?? [],
    networkAccess: configured?.networkAccess ?? false,
    excludeTmpdirEnvVar: configured?.excludeTmpdirEnvVar ?? false,
    excludeSlashTmp: configured?.excludeSlashTmp ?? false,
  };
  switch (mode) {
    case "supervised":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: base?.type === "readOnly" ? base.networkAccess : false,
        },
      };
    case "auto-edit":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        sandboxPolicy: workspaceWrite,
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        sandboxPolicy: workspaceWrite,
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

/**
 * The mode a thread runs in, given the sandbox Codex granted for the one
 * asked for. Codex's own requirements can grant a narrower sandbox; outside
 * one, a thread counts as full access.
 */
export function grantedRuntimeMode(asked: RuntimeMode, sandbox: CodexSandboxPolicy): RuntimeMode {
  if (sandbox.type === codexRuntimePolicy(asked).sandboxPolicy.type) return asked;
  switch (sandbox.type) {
    case "readOnly":
      return "supervised";
    case "workspaceWrite":
      return modeRank(asked) < modeRank("auto-edit") ? asked : "auto-edit";
    case "dangerFullAccess":
    case "externalSandbox":
      return "full-access";
  }
}

function itemStatus(status: string): ItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "running";
  }
}

function compact(value: JsonValue): string {
  return truncate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), 120);
}

function contentText(content: JsonValue[]): string {
  return content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        return String((part as { text: unknown }).text);
      }
      return compact(part);
    })
    .join("\n");
}

/** Codex's file changes as 1harness's, moves included. */
export function fileChanges(
  changes: Extract<CodexThreadItem, { type: "fileChange" }>["changes"],
): FileChange[] {
  return changes.map((entry) => ({
    path: entry.path,
    kind: changeKind(entry.kind.type),
    diff: entry.diff,
    ...(entry.kind.move_path ? { movePath: entry.kind.move_path } : {}),
  }));
}

function changeKind(kind: string): FileChange["kind"] {
  return kind === "add" || kind === "delete" ? kind : "update";
}

/** Undoes POSIX shell quoting of a single argument, as in `'it'\''s'` or `"a \"b\""`. */
function unquote(text: string): string | null {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return null;
      result += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === '"') {
      index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && /["\\$`]/.test(text[index + 1] ?? "")) index++;
        result += text[index];
        index++;
      }
      if (index >= text.length) return null;
      index++;
    } else if (char === "\\") {
      result += text[index + 1] ?? "";
      index += 2;
    } else if (/\s/.test(char)) {
      return null;
    } else {
      result += char;
      index++;
    }
  }
  return result;
}

/**
 * Codex runs commands as `<login shell> -lc '<command>'`; its own UI shows
 * only the command, and so does this one.
 */
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!match?.[1]) return command;
  return unquote(match[1].trim()) ?? command;
}

function commandActions(actions: CodexCommandAction[] | null | undefined): CommandAction[] {
  return (actions ?? []).map((action) => {
    switch (action.type) {
      case "read":
        return { type: "read", path: action.path };
      case "listFiles":
        return { type: "list", path: action.path };
      case "search":
        return { type: "search", query: action.query, path: action.path };
      default:
        return { type: "other" };
    }
  });
}

function webSearchItem(item: Extract<CodexThreadItem, { type: "webSearch" }>, done: boolean): Item {
  const status: ItemStatus = done ? "completed" : "running";
  const action = item.action;
  if (action?.type === "openPage" && action.url) {
    return {
      kind: "tool_call",
      id: item.id,
      tool: "WebFetch",
      server: null,
      category: "fetch",
      summary: action.url,
      output: "",
      status,
    };
  }
  if (action?.type === "findInPage") {
    const where = action.url ? ` in ${action.url}` : "";
    return {
      kind: "tool_call",
      id: item.id,
      tool: "Find in page",
      server: null,
      category: "search",
      summary: `${action.pattern ?? ""}${where}`,
      output: "",
      status,
    };
  }
  const queries = action?.type === "search" ? (action.queries ?? []) : [];
  const query = item.query || (action?.type === "search" ? (action.query ?? "") : "");
  return {
    kind: "web_search",
    id: item.id,
    query: query || queries.join(", "),
    status,
  };
}

/**
 * Maps a Codex thread item to the shared item model, or null for items with no
 * display. `done` is false for `item/started`, where some items only show once finished.
 */
export function toItem(item: CodexThreadItem, done = true): Item | null {
  switch (item.type) {
    case "userMessage": {
      const text = item.content
        // The text already names any skill or mention the message selects.
        .filter((part) => part.type !== "skill" && part.type !== "mention")
        .map((part) => (part.type === "text" ? String(part.text) : `[${part.type}]`))
        .join("\n");
      // A native command's prompt shows as the command the user typed.
      return {
        kind: "user_message",
        id: item.id,
        text: text === INIT_PROMPT ? "/init" : text,
        ...(item.clientId ? { inputId: item.clientId } : {}),
      };
    }
    case "agentMessage":
      return { kind: "assistant_message", id: item.id, text: item.text };
    case "plan":
      return { kind: "plan", id: item.id, text: item.text };
    case "reasoning": {
      const text = (item.summary.length > 0 ? item.summary : item.content).join("\n\n");
      return { kind: "reasoning", id: item.id, text };
    }
    case "commandExecution":
      return {
        kind: "command",
        id: item.id,
        command: unwrapShell(item.command),
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode,
        status: itemStatus(item.status),
        actions: commandActions(item.commandActions),
      };
    case "fileChange":
      return {
        kind: "file_change",
        id: item.id,
        changes: fileChanges(item.changes),
        status: itemStatus(item.status),
      };
    case "mcpToolCall":
      return {
        kind: "tool_call",
        id: item.id,
        tool: item.tool,
        server: item.server,
        category: "other",
        summary: compact(item.arguments),
        output: item.error?.message ?? (item.result ? contentText(item.result.content) : ""),
        status: item.error ? "failed" : itemStatus(item.status),
      };
    case "dynamicToolCall":
      return {
        kind: "tool_call",
        id: item.id,
        tool: item.tool,
        server: null,
        category: "other",
        summary: compact(item.arguments),
        output: (item.contentItems ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n"),
        status: itemStatus(item.status),
      };
    case "collabAgentToolCall": {
      const messages = Object.values(item.agentsStates ?? {})
        .map((state) => state?.message?.trim())
        .filter((message): message is string => Boolean(message));
      return {
        kind: "agent",
        id: item.id,
        description: item.prompt ? `${item.tool}: ${compact(item.prompt)}` : item.tool,
        summary: messages.join("\n"),
        status: itemStatus(item.status),
      };
    }
    case "webSearch":
      return webSearchItem(item, done);
    case "imageView":
      return {
        kind: "tool_call",
        id: item.id,
        tool: "View image",
        server: null,
        category: "read",
        summary: item.path,
        output: "",
        status: "completed",
      };
    case "enteredReviewMode":
      if (!done) return null;
      return {
        kind: "notice",
        id: item.id,
        level: "info",
        text: item.review ? `Reviewing ${item.review}` : "Review started",
      };
    case "exitedReviewMode":
      if (!done) return null;
      // The review's findings, written for the user.
      return item.review.trim() === ""
        ? null
        : { kind: "assistant_message", id: item.id, text: item.review };
    case "contextCompaction":
      return done
        ? { kind: "notice", id: item.id, level: "info", text: "Context compacted" }
        : null;
    default:
      return null;
  }
}

function turnStatus(status: CodexTurn["status"]): TurnStatus {
  return status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "weekly" : `${minutes / 10_080}-week`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Describes a turn error, preferring Codex's detailed explanation. */
function errorText(error: CodexTurnError | null): string | null {
  if (!error) return null;
  const details = error.additionalDetails?.trim();
  return details && details !== error.message ? `${error.message}\n${details}` : error.message;
}

/**
 * Translates app-server notifications for one thread. Notifications for other
 * threads, such as Codex's own agents, are dropped: their work appears
 * through the parent's collab tool items.
 */
export class CodexTranslator {
  threadId: string | null = null;
  #notices = 0;
  #limits = new Map<string, RateLimit>();
  #warned = new Set<string>();
  #usage: Omit<Usage, "limits"> | null = null;
  #retries = new Map<string, number>();
  /** The last fatal error per turn, reported once the turn completes. */
  #errors = new Map<string, string>();
  #planned = new Set<string>();
  /**
   * A review's findings arrive both as the exited-review item and as an agent
   * message, in either order; the second copy is suppressed.
   */
  #reviewText: string | null = null;
  #lastAgentText: string | null = null;
  #repeats = new Set<string>();

  notice(level: NoticeLevel, text: string): HarnessEvent {
    return {
      type: "item.completed",
      item: { kind: "notice", id: `codex-notice-${++this.#notices}`, level, text },
    };
  }

  /** Whether the turn produced a proposed plan; asking clears it. */
  takePlan(turnId: string): boolean {
    return this.#planned.delete(turnId);
  }

  #isReviewRepeat(native: CodexThreadItem, text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === "") return false;
    if (native.type === "exitedReviewMode") {
      this.#reviewText = trimmed;
      return trimmed === this.#lastAgentText;
    }
    if (native.type !== "agentMessage") return false;
    if (trimmed === this.#reviewText) return true;
    this.#lastAgentText = trimmed;
    return false;
  }

  get limits(): RateLimit[] {
    return [...this.#limits.values()];
  }

  translate(method: string, params: Record<string, unknown>): HarnessEvent[] {
    const threadId = params["threadId"];
    // Requests from agent threads are answered here too, so their resolutions pass.
    if (
      method !== "serverRequest/resolved" &&
      typeof threadId === "string" &&
      this.threadId !== null &&
      threadId !== this.threadId
    ) {
      return [];
    }
    switch (method) {
      case "turn/started":
        return [{ type: "turn.started", turnId: (params["turn"] as CodexTurn).id }];
      case "turn/completed": {
        const turn = params["turn"] as CodexTurn;
        const error = errorText(turn.error) ?? this.#errors.get(turn.id) ?? null;
        this.#reviewText = null;
        this.#lastAgentText = null;
        this.#errors.delete(turn.id);
        this.#retries.delete(turn.id);
        return [
          {
            type: "turn.ended",
            turnId: turn.id,
            status: turnStatus(turn.status),
            error: turnStatus(turn.status) === "failed" ? this.#withReset(error, turn.error) : null,
          },
        ];
      }
      case "item/started":
      case "item/completed": {
        const native = params["item"] as CodexThreadItem;
        const done = method === "item/completed";
        if (done && native.type === "plan") this.#planned.add(String(params["turnId"]));
        const item = toItem(native, done);
        if (!item || this.#repeats.has(item.id)) return [];
        if (item.kind === "assistant_message" && this.#isReviewRepeat(native, item.text)) {
          this.#repeats.add(item.id);
          return [];
        }
        return [{ type: done ? "item.completed" : "item.started", item }];
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/commandExecution/outputDelta": {
        const itemId = String(params["itemId"]);
        // Only agent messages are held back as repeats of a review.
        if (this.#repeats.has(itemId)) return [];
        return [{ type: "item.delta", itemId, chunk: String(params["delta"]) }];
      }

      case "item/reasoning/summaryPartAdded":
        return Number(params["summaryIndex"]) > 0
          ? [{ type: "item.delta", itemId: String(params["itemId"]), chunk: "\n\n" }]
          : [];
      case "turn/plan/updated": {
        const plan = params["plan"] as { step: string; status: string }[];
        return [
          {
            type: "item.updated",
            item: {
              kind: "todo_list",
              id: `codex-todo-${String(params["turnId"])}`,
              steps: plan.map((step) => ({ text: step.step, status: todoStatus(step.status) })),
            },
          },
        ];
      }
      case "thread/tokenUsage/updated": {
        const usage = params["tokenUsage"] as {
          total: { inputTokens: number; outputTokens: number };
          last: { totalTokens: number };
          modelContextWindow: number | null;
        };
        this.#usage = {
          inputTokens: usage.total.inputTokens,
          outputTokens: usage.total.outputTokens,
          contextTokens: usage.last.totalTokens,
          contextWindow: usage.modelContextWindow,
          costUsd: null,
        };
        return [this.#usageEvent()];
      }
      case "account/rateLimits/updated":
        return this.#rateLimits(params["rateLimits"] as Record<string, unknown>);
      case "error": {
        const error = params["error"] as CodexTurnError;
        const turnId = String(params["turnId"] ?? "");
        if (params["willRetry"] !== true) {
          // The turn's completion reports it, so it is shown once.
          this.#errors.set(turnId, errorText(error) ?? error.message);
          return [];
        }
        const attempt = (this.#retries.get(turnId) ?? 0) + 1;
        this.#retries.set(turnId, attempt);
        return [
          {
            type: "item.updated",
            item: {
              kind: "notice",
              id: `codex-retry-${turnId}`,
              level: "warning",
              text: `Reconnecting (attempt ${attempt}): ${error.message}`,
            },
          },
        ];
      }
      case "serverRequest/resolved":
        return [{ type: "request.resolved", requestId: codexRequestId(params["requestId"]) }];
      case "skills/changed":
        return [{ type: "commands.updated" }];
      case "mcpServer/oauthLogin/completed": {
        const name = String(params["name"]);
        return [
          params["success"] === true
            ? this.notice("info", `Signed in to ${name}`)
            : this.notice(
                "warning",
                `Could not sign in to ${name}${params["error"] ? `: ${String(params["error"])}` : ""}`,
              ),
        ];
      }
      case "model/rerouted":
        return [
          this.notice(
            "info",
            `Model rerouted from ${String(params["fromModel"])} to ${String(params["toModel"])}`,
          ),
        ];
      case "mcpServer/startupStatus/updated":
        return params["status"] === "failed"
          ? [
              this.notice(
                "warning",
                `MCP server ${String(params["name"])} failed to start${params["error"] ? `: ${String(params["error"])}` : ""}`,
              ),
            ]
          : [];
      case "item/autoApprovalReview/completed": {
        const review = params["review"] as { status: string; rationale: string | null };
        if (review.status !== "denied" && review.status !== "timedOut") return [];
        const verdict = review.status === "denied" ? "denied" : "timed out on";
        const rationale = review.rationale ? `: ${review.rationale}` : "";
        // Codex's auto-review is the safety check auto mode describes.
        return [this.notice("warning", `The safety check ${verdict} an action${rationale}`)];
      }
      case "warning":
      case "guardianWarning":
        return [this.notice("warning", String(params["message"]))];
      case "configWarning":
      case "deprecationNotice":
        return [this.notice("warning", String(params["summary"]))];
      default:
        return [];
    }
  }

  #usageEvent(): HarnessEvent {
    const usage = this.#usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: null,
      contextWindow: null,
      costUsd: null,
    };
    return { type: "usage.updated", usage: { ...usage, limits: this.limits } };
  }

  #rateLimits(snapshot: Record<string, unknown>): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    const reached = snapshot["rateLimitReachedType"] != null;
    for (const [key, fallback] of [
      ["primary", "short-term"],
      ["secondary", "weekly"],
    ] as const) {
      const window = snapshot[key] as RateLimitWindow | null | undefined;
      if (!window) continue;
      const label = windowLabel(window.windowDurationMins, fallback);
      const exceeded = window.usedPercent >= 100;
      const limit: RateLimit = {
        label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
        status: exceeded ? "exceeded" : window.usedPercent >= 90 ? "warning" : "ok",
      };
      this.#limits.set(key, limit);
      // One warning per window as it nears its limit; it rearms after a reset.
      if (limit.status === "ok") this.#warned.delete(key);
      else if (!this.#warned.has(key)) {
        this.#warned.add(key);
        events.push(this.notice("warning", limitNotice(limit)));
      }
    }
    if (reached && !this.#warned.has("reached")) {
      this.#warned.add("reached");
      events.push(this.notice("warning", "Usage limit reached"));
    } else if (!reached) this.#warned.delete("reached");
    events.push(this.#usageEvent());
    return events;
  }

  /** Adds when usage resets to a usage-limit failure. */
  #withReset(error: string | null, turnError: CodexTurnError | null): string | null {
    if (!error || turnError?.codexErrorInfo !== "usageLimitExceeded") return error;
    const resets = this.limits
      .filter((limit) => limit.status === "exceeded" && limit.resetsAt !== null)
      .map((limit) => limit.resetsAt ?? 0);
    if (resets.length === 0) return error;
    return `${error}\nResets ${new Date(Math.max(...resets)).toLocaleString()}`;
  }
}

export function codexRequestId(id: unknown): string {
  return `codex-request-${String(id)}`;
}

/** What `mcpServerStatus/list` reports for a server. */
export interface CodexMcpStatus {
  name: string;
  runtimeStatus: string | null;
  authStatus: string;
  pluginId: string | null;
  httpOrigin: string | null;
  tools: Record<string, unknown>;
  toolsError: string | null;
}

/** A server's entry under `mcp_servers` in Codex's config. */
export interface CodexMcpConfig {
  url?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
}

const MCP_STATES: Record<string, McpServerState> = {
  connected: "connected",
  starting: "starting",
  authenticationRequired: "needs-login",
  failed: "failed",
  disabled: "disabled",
  notStarted: "stopped",
  cancelled: "stopped",
};

const MCP_AUTH: Record<string, string> = {
  oAuth: "OAuth",
  bearerToken: "bearer token",
  notLoggedIn: "not signed in",
};

/** Codex's server state, filled in from its config: the command or URL, and the file it came from. */
export function toMcpServer(
  status: CodexMcpStatus,
  config: CodexMcpConfig | undefined,
  file: string | null,
): McpServer {
  const state =
    (status.runtimeStatus === null ? undefined : MCP_STATES[status.runtimeStatus]) ??
    (status.authStatus === "notLoggedIn"
      ? "needs-login"
      : config?.enabled === false
        ? "disabled"
        : "stopped");
  const command = config?.command ? [config.command, ...(config.args ?? [])].join(" ") : null;
  return {
    name: status.name,
    state,
    // Codex's own connector to ChatGPT apps has no config entry.
    source: status.pluginId
      ? `plugin ${status.pluginId}`
      : (file ?? (status.name === "codex_apps" ? "ChatGPT apps" : null)),
    transport: command ? "stdio" : config?.url || status.httpOrigin ? "http" : null,
    target: config?.url ?? command ?? status.httpOrigin,
    auth: MCP_AUTH[status.authStatus] ?? null,
    error: status.toolsError,
    tools: Object.keys(status.tools).toSorted(),
  };
}
