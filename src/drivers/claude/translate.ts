import { stripVTControlCharacters } from "node:util";
import type {
  McpServerStatus,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RUNTIME_MODES,
  type FileChange,
  type HarnessEvent,
  type InteractionMode,
  type Item,
  type McpServer,
  type McpServerState,
  type RateLimit,
  type RuntimeMode,
  type TodoStep,
  type ToolCategory,
  type Usage,
  type NoticeLevel,
} from "../../core/events.ts";
import { unifiedDiff } from "../../core/diff.ts";
import { limitNotice } from "../../core/wording.ts";
import { truncate } from "../../core/wording.ts";
import { noticeEvent } from "../session-events.ts";
import { record, text } from "../../core/values.ts";
import { mcpTool } from "../../core/tools.ts";
import { agentDescription, contentText, summarizeInput, todoStatus } from "../text.ts";

type ContentBlock = SDKAssistantMessage["message"]["content"][number];
type StreamEvent = SDKPartialAssistantMessage["event"];

const OUTPUT_LIMIT = 65_536;
// Claude's task list tools; their calls update one task list instead of showing as rows.
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
// Tools that only load other tools' definitions.
const HIDDEN_TOOLS = new Set(["ToolSearch"]);
const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

/**
 * The runtime modes Claude Code's settings leave on. Any settings file can
 * turn off full access (`permissions.disableBypassPermissionsMode`) or auto
 * mode (`disableAutoMode`, at the top or under `permissions`).
 */
export function claudeRuntimeModes(settings: readonly unknown[]): RuntimeMode[] {
  const sources = settings.map(record);
  const permissions = sources.map((source) => record(source["permissions"]));
  const bypassOff = permissions.some(
    (entry) => entry["disableBypassPermissionsMode"] === "disable",
  );
  const autoOff =
    sources.some((source) => source["disableAutoMode"] === "disable") ||
    permissions.some((entry) => entry["disableAutoMode"] === "disable");
  return RUNTIME_MODES.filter(
    (mode) => !(mode === "full-access" && bypassOff) && !(mode === "auto" && autoOff),
  );
}

export function permissionModeFor(
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
): PermissionMode {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "supervised":
      return "default";
    case "auto-edit":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
  }
}

export function runtimeModeFor(mode: PermissionMode): RuntimeMode | null {
  switch (mode) {
    case "default":
    case "dontAsk":
      return "supervised";
    case "acceptEdits":
      return "auto-edit";
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "full-access";
    case "plan":
      return null;
  }
}

/** The inputs that best say what a call of one of Claude Code's tools is about, best first. */
export const SUMMARY_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "url",
  "pattern",
  "query",
  "skill",
  "description",
];

/** Maps a Claude tool call to a shared item, or null for tools 1harness renders through requests. */
export function toolItem(id: string, name: string, rawInput: unknown): Item | null {
  const input = record(rawInput);
  switch (name) {
    case "Bash":
    case "PowerShell":
      return {
        kind: "command",
        id,
        command: text(input["command"]),
        output: "",
        exitCode: null,
        status: "running",
      };
    case "Edit":
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"].map(record) : [input];
      const diff = edits
        .map((edit) => unifiedDiff(text(edit["old_string"]), text(edit["new_string"])))
        .filter(Boolean)
        .join("\n");
      return {
        kind: "file_change",
        id,
        changes: [{ path: text(input["file_path"]), kind: "update", diff }],
        status: "running",
      };
    }
    case "Write":
      return {
        kind: "file_change",
        id,
        changes: [
          {
            path: text(input["file_path"]),
            kind: "add",
            diff: unifiedDiff("", text(input["content"])),
          },
        ],
        status: "running",
      };
    case "NotebookEdit":
      return {
        kind: "file_change",
        id,
        changes: [
          {
            path: text(input["notebook_path"]),
            kind: "update",
            diff: unifiedDiff("", text(input["new_source"])),
          } satisfies FileChange,
        ],
        status: "running",
      };
    case "TodoWrite": {
      const todos = Array.isArray(input["todos"]) ? input["todos"].map(record) : [];
      return {
        kind: "todo_list",
        id: "claude-todos",
        steps: todos.map((todo) => ({
          text: text(todo["content"]),
          status: todoStatus(todo["status"]),
        })),
      };
    }
    case "Task":
    case "Agent":
      return {
        kind: "agent",
        id,
        description: agentDescription(input),
        summary: "",
        status: "running",
      };
    case "WebSearch":
      return { kind: "web_search", id, query: text(input["query"]), status: "running" };
    case "AskUserQuestion":
    case "ExitPlanMode":
      return null;
    case "TodoRead":
      return null;
    default: {
      if (TASK_TOOLS.has(name) || HIDDEN_TOOLS.has(name)) return null;
      const mcp = mcpTool(name);
      return {
        kind: "tool_call",
        id,
        tool: mcp?.tool ?? name,
        server: mcp?.server ?? null,
        category: mcp ? "other" : (TOOL_CATEGORIES[name] ?? "other"),
        summary: summarizeInput(input, SUMMARY_KEYS),
        output: "",
        status: "running",
      };
    }
  }
}

/**
 * Rebuilds a file change from the tool's own result: the applied patch with
 * line context, and whether a write created or replaced the file.
 */
function appliedChange(change: FileChange, result: unknown): FileChange {
  const output = record(result);
  const hunks = Array.isArray(output["structuredPatch"])
    ? output["structuredPatch"].map(record)
    : [];
  const kind =
    output["type"] === "create" ? "add" : output["type"] === "update" ? "update" : change.kind;
  if (hunks.length === 0) return { ...change, kind };
  const diff = hunks
    .flatMap((hunk) => [
      `@@ -${String(hunk["oldStart"])},${String(hunk["oldLines"])} +${String(hunk["newStart"])},${String(hunk["newLines"])} @@`,
      ...(Array.isArray(hunk["lines"]) ? hunk["lines"].map(String) : []),
    ])
    .join("\n");
  return { ...change, kind, diff };
}

function complete(item: Item, output: string, failed: boolean, result?: unknown): Item {
  const status = failed ? "failed" : "completed";
  switch (item.kind) {
    case "command":
    case "tool_call":
      return { ...item, output: truncate(output, OUTPUT_LIMIT), status };
    case "file_change":
      return {
        ...item,
        changes:
          result === undefined || failed
            ? item.changes
            : item.changes.map((change) => appliedChange(change, result)),
        status,
      };
    case "web_search":
      return { ...item, status };
    case "agent":
      return { ...item, summary: item.summary || truncate(output.trim(), 400), status };
    default:
      return item;
  }
}

interface StreamedBlock {
  itemId: string;
  type: string;
  claimed: boolean;
}

/**
 * Translates Claude Agent SDK messages for the main conversation. Agent
 * transcripts are summarized by their task items rather than rendered.
 */
export class ClaudeTranslator {
  /** Replay mode renders stored history: user prompts become items and nothing streams. */
  readonly replay: boolean;
  #streamMessageId: string | null = null;
  #streamed = new Map<string, StreamedBlock[]>();
  #tools = new Map<string, Item>();
  #taskTools = new Map<string, string>();
  /**
   * Tasks Claude has started and not reported the end of, by task ID. Only
   * background ones count as running past a turn: Claude always reports their
   * end, since that is what wakes it, where a stopped foreground task may not.
   */
  #work = new Map<string, { description: string; background: boolean }>();
  /** Task list tool calls awaiting results, and the task list they build. */
  #taskCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  #tasks = new Map<string, TodoStep>();
  #ids = 0;
  #contextTokens: number | null = null;
  #contextWindow: number | null = null;
  #usage: Omit<Usage, "limits" | "contextTokens" | "contextWindow"> | null = null;
  #limits = new Map<string, RateLimit>();
  #compaction: string | null = null;
  #retry: string | null = null;
  #sawText = false;
  /** The session's main model, whose context window the meter shows. */
  model: string | null = null;

  constructor(options: { replay?: boolean } = {}) {
    this.replay = options.replay ?? false;
  }

  #noticeUpdate(id: string, level: NoticeLevel, message: string): HarnessEvent {
    return { type: "item.updated", item: { kind: "notice", id, level, text: message } };
  }

  /** Whether assistant text appeared since the last call; asking resets it. */
  takeSawText(): boolean {
    const saw = this.#sawText;
    this.#sawText = false;
    return saw;
  }

  /** Forgets background tasks, which end without word when Claude Code restarts. */
  clearBackgroundWork(): void {
    this.#work.clear();
  }

  /** What each task Claude is still running does, such as a background agent. */
  get backgroundWork(): string[] {
    return [...this.#work.values()]
      .filter((task) => task.background)
      .map((task) => task.description);
  }

  /** Clears the transient retry line once a turn ends. */
  endTurn(): void {
    this.#retry = null;
  }

  /** Completes tool calls still waiting for results, so an ended turn leaves nothing running. */
  settleOpenTools(failed: boolean): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const item of this.#tools.values()) {
      events.push({ type: "item.completed", item: complete(item, "", failed) });
    }
    this.#tools.clear();
    return events;
  }

  translate(message: SDKMessage): HarnessEvent[] {
    switch (message.type) {
      case "stream_event":
        return message.parent_tool_use_id === null ? this.#stream(message.event) : [];
      case "assistant":
        return message.parent_tool_use_id === null ? this.#assistant(message) : [];
      case "user":
        return message.parent_tool_use_id === null ? this.#user(message) : [];
      case "result":
        return this.#result(message);
      case "system":
        return this.#system(message);
      case "rate_limit_event":
        return this.#rateLimit(message.rate_limit_info);
      default:
        return [];
    }
  }

  #stream(event: StreamEvent): HarnessEvent[] {
    switch (event.type) {
      case "message_start": {
        this.#streamMessageId = event.message.id;
        const usage = event.message.usage;
        if (!usage || event.message.model === "<synthetic>") return [];
        this.#contextTokens =
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        return [this.#usageEvent()];
      }
      case "content_block_start": {
        const messageId = this.#streamMessageId;
        const block = event.content_block;
        if (messageId === null || (block.type !== "text" && block.type !== "thinking")) return [];
        const itemId = `${messageId}:${event.index}`;
        const blocks = this.#streamed.get(messageId) ?? [];
        blocks[event.index] = { itemId, type: block.type, claimed: false };
        this.#streamed.set(messageId, blocks);
        const item: Item =
          block.type === "text"
            ? { kind: "assistant_message", id: itemId, text: "" }
            : { kind: "reasoning", id: itemId, text: "" };
        return [{ type: "item.started", item }];
      }
      case "content_block_delta": {
        const messageId = this.#streamMessageId;
        if (messageId === null) return [];
        const block = this.#streamed.get(messageId)?.[event.index];
        if (!block) return [];
        const delta = event.delta;
        if (delta.type === "text_delta")
          return [{ type: "item.delta", itemId: block.itemId, chunk: delta.text }];
        if (delta.type === "thinking_delta") {
          return [{ type: "item.delta", itemId: block.itemId, chunk: delta.thinking }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  // The SDK can deliver one assistant message per content block, so blocks are
  // matched to streamed ones by type and order rather than by index.
  #claim(messageId: string, type: string): string {
    const block = this.#streamed
      .get(messageId)
      ?.find((entry) => entry && !entry.claimed && entry.type === type);
    if (block) {
      block.claimed = true;
      return block.itemId;
    }
    return `${messageId}:claude-${++this.#ids}`;
  }

  #assistant(message: SDKAssistantMessage): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    const { id, usage } = message.message;
    // Synthetic messages, such as interruption notes, report no real usage.
    if (usage && message.message.model !== "<synthetic>") {
      this.#contextTokens =
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        usage.output_tokens;
    }
    if (message.error) {
      events.push(noticeEvent("claude", "error", `API error: ${message.error}`));
    }
    for (const block of message.message.content as ContentBlock[]) {
      switch (block.type) {
        case "text":
          if (block.text.trim() !== "") this.#sawText = true;
          // Completed even when empty, so no started item is left open.
          events.push({
            type: "item.completed",
            item: { kind: "assistant_message", id: this.#claim(id, "text"), text: block.text },
          });
          break;
        case "thinking": {
          const itemId = this.#claim(id, "thinking");
          events.push({
            type: "item.completed",
            item: { kind: "reasoning", id: itemId, text: block.thinking },
          });
          break;
        }
        case "tool_use": {
          if (TASK_TOOLS.has(block.name)) {
            this.#taskCalls.set(block.id, { name: block.name, input: record(block.input) });
            break;
          }
          const item = toolItem(block.id, block.name, block.input);
          if (!item) break;
          if (item.kind === "todo_list") {
            events.push({ type: "item.updated", item });
            break;
          }
          this.#tools.set(block.id, item);
          events.push({ type: "item.started", item });
          break;
        }
        case "server_tool_use": {
          if (block.name !== "web_search") break;
          const item: Item = {
            kind: "web_search",
            id: block.id,
            query: text(record(block.input)["query"]),
            status: "running",
          };
          this.#tools.set(block.id, item);
          events.push({ type: "item.started", item });
          break;
        }
        case "web_search_tool_result": {
          const item = this.#tools.get(block.tool_use_id);
          if (!item) break;
          this.#tools.delete(block.tool_use_id);
          events.push({ type: "item.completed", item: complete(item, "", false) });
          break;
        }
        default:
          break;
      }
    }
    return events;
  }

  #user(message: SDKUserMessage): HarnessEvent[] {
    const content = message.message.content;
    if (typeof content === "string") {
      return this.replay && !message.isSynthetic ? this.#prompt(content) : [];
    }
    const events: HarnessEvent[] = [];
    const prompt: string[] = [];
    for (const part of content) {
      if (part.type === "text") {
        prompt.push(part.text);
        continue;
      }
      if (part.type !== "tool_result") continue;
      const task = this.#taskCalls.get(part.tool_use_id);
      if (task) {
        this.#taskCalls.delete(part.tool_use_id);
        if (part.is_error !== true) events.push(...this.#task(task, message.tool_use_result));
        continue;
      }
      const item = this.#tools.get(part.tool_use_id);
      if (!item) continue;
      this.#tools.delete(part.tool_use_id);
      // The structured result belongs to the message's only tool result.
      const result = content.length === 1 ? message.tool_use_result : undefined;
      events.push({
        type: "item.completed",
        item: complete(item, contentText(part.content), part.is_error === true, result),
      });
    }
    if (this.replay && !message.isSynthetic && prompt.length > 0 && events.length === 0) {
      events.push(...this.#prompt(prompt.join("\n")));
    }
    return events;
  }

  /**
   * A stored prompt. Claude Code stores slash commands and their output in
   * markup, which is shown the way it was typed and printed.
   */
  #prompt(content: string): HarnessEvent[] {
    if (/<local-command-caveat>/.test(content)) return [];
    // Claude Code records an interruption as a placeholder prompt.
    if (/^\[Request interrupted by user[^\]]*\]$/.test(content.trim())) {
      return [noticeEvent("claude", "info", "Interrupted")];
    }
    const output =
      /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(
        content,
      );
    if (output) {
      const body = stripVTControlCharacters(output[1] ?? "").trim();
      return body ? [noticeEvent("claude", "info", body)] : [];
    }
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(content);
    if (command) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim() ?? "";
      const name = (command[1] ?? "").trim();
      content = args ? `${name.startsWith("/") ? name : `/${name}`} ${args}` : name;
    }
    return [
      {
        type: "item.completed",
        item: { kind: "user_message", id: `claude-prompt-${++this.#ids}`, text: content },
      },
    ];
  }

  #result(message: Extract<SDKMessage, { type: "result" }>): HarnessEvent[] {
    // Agents and compaction run on other models; the meter follows the main one.
    const models = Object.entries(message.modelUsage ?? {});
    const main =
      models.find(([model]) => model === this.model) ??
      (models.length === 1 ? models[0] : undefined);
    if (main?.[1].contextWindow) this.#contextWindow = main[1].contextWindow;
    this.#usage = {
      inputTokens:
        message.usage.input_tokens +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      costUsd: message.total_cost_usd,
    };
    return [this.#usageEvent()];
  }

  #usageEvent(): HarnessEvent {
    const usage = this.#usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null };
    return {
      type: "usage.updated",
      usage: {
        ...usage,
        contextTokens: this.#contextTokens,
        contextWindow: this.#contextWindow,
        limits: [...this.#limits.values()],
      },
    };
  }

  #rateLimit(
    info: Extract<SDKMessage, { type: "rate_limit_event" }>["rate_limit_info"],
  ): HarnessEvent[] {
    const key = info.rateLimitType ?? "subscription";
    const label = LIMIT_LABELS[key] ?? key.replaceAll("_", " ");
    const status =
      info.status === "rejected"
        ? "exceeded"
        : info.status === "allowed_warning"
          ? "warning"
          : "ok";
    const previous = this.#limits.get(key);
    const limit: RateLimit = {
      label,
      usedPercent: info.utilization === undefined ? null : info.utilization * 100,
      resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
      status,
    };
    this.#limits.set(key, limit);
    const events: HarnessEvent[] = [];
    if (status !== "ok" && previous?.status !== status) {
      // Claude Code holds the turn until the limit resets rather than failing it.
      const waits = status === "exceeded" ? ". The turn waits for it to reset; esc stops it." : "";
      events.push(noticeEvent("claude", "warning", `${limitNotice(limit)}${waits}`));
    }
    events.push(this.#usageEvent());
    return events;
  }

  /** Applies a task list tool's result and emits the updated list. */
  #task(call: { name: string; input: Record<string, unknown> }, result: unknown): HarnessEvent[] {
    const output = record(result);
    if (call.name === "TaskCreate") {
      const task = record(output["task"]);
      const id = text(task["id"]);
      if (!id) return [];
      this.#tasks.set(id, {
        text: text(call.input["subject"]) || text(task["subject"]),
        status: "pending",
      });
    } else if (call.name === "TaskUpdate") {
      const id = text(call.input["taskId"]);
      const current = this.#tasks.get(id);
      if (!current) return [];
      if (call.input["status"] === "deleted") this.#tasks.delete(id);
      else {
        this.#tasks.set(id, {
          text: text(call.input["subject"]) || current.text,
          status:
            call.input["status"] === undefined ? current.status : todoStatus(call.input["status"]),
        });
      }
    } else if (call.name === "TaskList") {
      const tasks = Array.isArray(output["tasks"]) ? output["tasks"].map(record) : [];
      this.#tasks = new Map(
        tasks.map((task) => [
          text(task["id"]),
          { text: text(task["subject"]), status: todoStatus(task["status"]) },
        ]),
      );
    } else {
      return [];
    }
    return [
      {
        type: "item.updated",
        item: { kind: "todo_list", id: "claude-tasks", steps: [...this.#tasks.values()] },
      },
    ];
  }

  #system(message: Extract<SDKMessage, { type: "system" }>): HarnessEvent[] {
    switch (message.subtype) {
      case "status":
        if (message.compact_result === "failed") {
          const id = this.#compaction ?? `claude-compact-${++this.#ids}`;
          this.#compaction = null;
          return [
            this.#noticeUpdate(
              id,
              "error",
              `Compaction failed: ${message.compact_error ?? "unknown error"}`,
            ),
          ];
        }
        if (message.status === "compacting" && this.#compaction === null) {
          this.#compaction = `claude-compact-${++this.#ids}`;
          return [this.#noticeUpdate(this.#compaction, "info", "Compacting conversation…")];
        }
        return [];
      case "compact_boundary": {
        const { pre_tokens, post_tokens } = message.compact_metadata;
        const after = post_tokens === undefined ? "" : ` to ${post_tokens.toLocaleString()}`;
        const id = this.#compaction ?? `claude-compact-${++this.#ids}`;
        this.#compaction = null;
        return [
          this.#noticeUpdate(
            id,
            "info",
            `Context compacted from ${pre_tokens.toLocaleString()}${after} tokens`,
          ),
        ];
      }
      case "api_retry": {
        // One line per turn, updated with each attempt.
        this.#retry ??= `claude-retry-${++this.#ids}`;
        const status = message.error_status ? ` ${message.error_status}` : "";
        return [
          this.#noticeUpdate(
            this.#retry,
            "warning",
            `API error${status} (${message.error}), retrying ${message.attempt}/${message.max_retries}`,
          ),
        ];
      }
      case "informational": {
        if (message.level === "info") return [];
        const level = message.level === "notice" ? "info" : "warning";
        return [
          noticeEvent("claude", message.prevent_continuation ? "warning" : level, message.content),
        ];
      }
      case "commands_changed":
        return [{ type: "commands.updated" }];
      case "local_command_output":
        return [noticeEvent("claude", "info", message.content)];
      case "notification":
        return [
          noticeEvent(
            "claude",
            message.priority === "high" || message.priority === "immediate" ? "warning" : "info",
            message.text,
          ),
        ];
      case "permission_denied":
        return [
          noticeEvent("claude", "warning", `${message.tool_name} was denied: ${message.message}`),
        ];
      case "task_started": {
        this.#work.set(message.task_id, {
          description: message.description,
          background: message.is_backgrounded === true,
        });
        if (message.tool_use_id === undefined) return [];
        this.#taskTools.set(message.task_id, message.tool_use_id);
        return [];
      }
      case "task_updated": {
        const task = this.#work.get(message.task_id);
        const { status, description, is_backgrounded: background } = message.patch;
        if (status === "completed" || status === "failed" || status === "killed")
          this.#work.delete(message.task_id);
        else if (task)
          this.#work.set(message.task_id, {
            description: description ?? task.description,
            background: background ?? task.background,
          });
        return [];
      }
      case "task_progress": {
        const toolUseId = message.tool_use_id ?? this.#taskTools.get(message.task_id);
        const item = toolUseId === undefined ? undefined : this.#tools.get(toolUseId);
        if (!item || item.kind !== "agent") return [];
        const summary =
          message.summary ?? (message.last_tool_name ? `Using ${message.last_tool_name}` : "");
        const updated: Item = { ...item, summary };
        this.#tools.set(item.id, updated);
        return [{ type: "item.updated", item: updated }];
      }
      case "task_notification": {
        this.#work.delete(message.task_id);
        const toolUseId = message.tool_use_id ?? this.#taskTools.get(message.task_id);
        const item = toolUseId === undefined ? undefined : this.#tools.get(toolUseId);
        if (item?.kind === "agent") return [];
        const status = message.status === "completed" ? "finished" : message.status;
        return [
          noticeEvent(
            "claude",
            message.status === "failed" ? "warning" : "info",
            `Background task ${status}: ${message.summary}`,
          ),
        ];
      }
      default:
        return [];
    }
  }
}

/** Claude Code's tools that read, search, or fetch, grouped as exploration. */
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: "read",
  NotebookRead: "read",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebFetch: "fetch",
};

const MCP_STATES: Record<McpServerStatus["status"], McpServerState> = {
  connected: "connected",
  pending: "starting",
  "needs-auth": "needs-login",
  failed: "failed",
  disabled: "disabled",
};

// Claude Code's own name for its claude.ai connectors.
const MCP_SOURCES: Record<string, string> = { claudeai: "claude.ai" };

export function toMcpServer(status: McpServerStatus): McpServer {
  const config = status.config;
  const source = status.source ?? status.scope ?? null;
  return {
    name: status.name,
    state: MCP_STATES[status.status],
    source: source === null ? null : (MCP_SOURCES[source] ?? source),
    transport:
      config === undefined
        ? null
        : "url" in config
          ? config.type === "sse"
            ? "sse"
            : "http"
          : "command" in config
            ? "stdio"
            : null,
    target:
      config === undefined
        ? null
        : "url" in config
          ? config.url
          : "command" in config
            ? [config.command, ...(config.args ?? [])].join(" ")
            : null,
    auth: null,
    error: status.error ?? null,
    tools: (status.tools ?? []).map((tool) => tool.name).toSorted(),
  };
}
