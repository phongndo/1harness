import type {
  ApprovalAction,
  FileChange,
  HarnessEvent,
  Item,
  ItemStatus,
  NativeCommand,
  ToolCategory,
} from "../../core/events.ts";
import { unifiedDiff } from "../../core/diff.ts";
import { record } from "../../core/values.ts";
import { todoStatus } from "../text.ts";

// The subset of the Agent Client Protocol (v1) this driver reads. Updates of
// other kinds reach the translator as well, typed as these, and are dropped.

export interface AcpContent {
  type: string;
  text?: string;
}

export type AcpToolContent =
  | { type: "content"; content: AcpContent }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  /** fx names the tool itself; the spec leaves it to the title. */
  name?: string;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
}

export type AcpUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContent; messageId?: string }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContent; messageId?: string }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContent; messageId?: string }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | { sessionUpdate: "plan"; entries: { content: string; status: string }[] }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: { name: string; description: string; input?: { hint?: string } | null }[];
    }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "usage_update"; used: number; size: number };

const CATEGORIES: Record<string, ToolCategory> = { read: "read", search: "search", fetch: "fetch" };

function toolStatus(status: string | null | undefined): ItemStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

function contentText(content: readonly AcpToolContent[] | null | undefined): string {
  return (content ?? [])
    .map((part) => (part.type === "content" ? (part.content.text ?? `[${part.content.type}]`) : ""))
    .filter(Boolean)
    .join("\n");
}

function field(input: unknown, ...names: string[]): string | null {
  const fields = record(input);
  for (const name of names) if (typeof fields[name] === "string") return fields[name];
  return null;
}

/** The files an edit touches, with diffs where the agent sent both texts. */
function fileChanges(call: AcpToolCall): FileChange[] {
  const diffs = (call.content ?? []).flatMap((part) =>
    part.type === "diff"
      ? [
          {
            path: part.path,
            kind: part.oldText == null ? ("add" as const) : ("update" as const),
            diff: unifiedDiff(part.oldText ?? "", part.newText),
          },
        ]
      : [],
  );
  if (diffs.length > 0) return diffs;
  const path =
    field(call.rawInput, "path", "file_path", "filePath") ?? call.locations?.[0]?.path ?? null;
  if (!path) return [];
  const before = field(call.rawInput, "old_string", "oldString");
  const after = field(call.rawInput, "new_string", "newString");
  return [
    {
      path,
      kind: call.kind === "delete" ? "delete" : "update",
      diff: before !== null && after !== null ? unifiedDiff(before, after) : "",
    },
  ];
}

/** A tool call as a 1harness item, by the kind the agent gives it. */
export function toolItem(call: AcpToolCall): Item {
  const status = toolStatus(call.status);
  const output = contentText(call.content);
  switch (call.kind) {
    case "execute":
      return {
        kind: "command",
        id: call.toolCallId,
        command: field(call.rawInput, "command", "cmd") ?? call.title ?? "",
        output,
        exitCode: null,
        status,
      };
    case "edit":
    case "delete":
    case "move":
      return { kind: "file_change", id: call.toolCallId, changes: fileChanges(call), status };
    default:
      return {
        kind: "tool_call",
        id: call.toolCallId,
        tool: call.name ?? call.title ?? "tool",
        server: null,
        category: CATEGORIES[call.kind ?? ""] ?? "other",
        summary: call.title ?? field(call.rawInput, "path", "query", "url") ?? "",
        output,
        status,
      };
  }
}

/** What a permission request is for, from its tool call. */
export function approvalAction(call: AcpToolCall): ApprovalAction {
  if (call.kind === "execute") {
    return {
      type: "command",
      command: field(call.rawInput, "command", "cmd") ?? call.title ?? "",
      cwd: field(call.rawInput, "cwd"),
    };
  }
  if (call.kind === "edit" || call.kind === "delete" || call.kind === "move") {
    return { type: "file_change", paths: fileChanges(call).map((change) => change.path) };
  }
  return {
    type: "tool",
    tool: call.name ?? call.title ?? "tool",
    server: null,
    input: call.rawInput,
  };
}

/**
 * Turns `session/update` notifications into 1harness events. Message chunks
 * become one item per message, ended when something else arrives.
 */
export class AcpTranslator {
  #tools = new Map<string, AcpToolCall>();
  /** The message or thought being streamed, and what kind it is. */
  #open: {
    id: string;
    kind: "assistant_message" | "reasoning" | "user_message";
    text: string;
  } | null = null;
  #messages = 0;
  #commands: NativeCommand[] = [];

  get commands(): NativeCommand[] {
    return this.#commands;
  }

  translate(update: AcpUpdate): HarnessEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk": {
        const kind =
          update.sessionUpdate === "agent_message_chunk"
            ? "assistant_message"
            : update.sessionUpdate === "agent_thought_chunk"
              ? "reasoning"
              : "user_message";
        return this.#chunk(kind, update.content.text ?? "", update.messageId);
      }
      case "tool_call":
      case "tool_call_update": {
        const merged = {
          ...this.#tools.get(update.toolCallId),
          ...stripNulls(update),
        } as AcpToolCall;
        this.#tools.set(update.toolCallId, merged);
        const item = toolItem(merged);
        const done = merged.status === "completed" || merged.status === "failed";
        if (done) this.#tools.delete(update.toolCallId);
        const type = done
          ? "item.completed"
          : update.sessionUpdate === "tool_call"
            ? "item.started"
            : "item.updated";
        return [...this.flush(), { type, item }];
      }
      case "plan": {
        const steps = update.entries.map((entry) => ({
          text: entry.content,
          status: todoStatus(entry.status),
        }));
        return [
          ...this.flush(),
          { type: "item.updated", item: { kind: "todo_list", id: "acp-plan", steps } },
        ];
      }
      case "available_commands_update": {
        this.#commands = update.availableCommands.map((command) => ({
          name: command.name,
          aliases: [],
          description: command.description,
          argumentHint: command.input?.hint ?? "",
          kind: "command",
          startsTurn: true,
        }));
        return [{ type: "commands.updated" }];
      }
      default:
        return [];
    }
  }

  /** Ends the streaming message, if one is open. */
  flush(): HarnessEvent[] {
    const open = this.#open;
    this.#open = null;
    if (!open) return [];
    return [{ type: "item.completed", item: { kind: open.kind, id: open.id, text: open.text } }];
  }

  #chunk(
    kind: "assistant_message" | "reasoning" | "user_message",
    chunk: string,
    messageId: string | undefined,
  ): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    const open = this.#open;
    if (!open || open.kind !== kind || (messageId !== undefined && !open.id.endsWith(messageId))) {
      events.push(...this.flush());
      const id = `acp-${kind}-${messageId ?? ++this.#messages}`;
      this.#open = { id, kind, text: "" };
      events.push({ type: "item.started", item: { kind, id, text: "" } });
    }
    const current = this.#open;
    if (current && chunk) {
      current.text += chunk;
      events.push({ type: "item.delta", itemId: current.id, chunk });
    }
    return events;
  }
}

/** Drops null fields, which in an update mean "unchanged". */
function stripNulls<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined),
  ) as Partial<T>;
}
