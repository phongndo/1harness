import type {
  ApprovalAction,
  ApprovalOption,
  ApprovalRequest,
  FileChange,
  HarnessEvent,
  Item,
  ItemStatus,
  ModelOption,
  Question,
  QuestionRequest,
  RuntimeMode,
  ToolCategory,
  Usage,
} from "../../core/events.ts";
import { unifiedDiff } from "../../core/diff.ts";
import { ANSWER, askFor, askForChanges } from "../../core/wording.ts";
import { noticeEvent } from "../session-events.ts";
import { record, text } from "../../core/values.ts";
import { agentDescription, contentText, summarizeInput } from "../text.ts";

// OpenCode 2's server API in the parts 1harness reads. Events arrive on
// `/api/event` as `{ type, data }`; tools are named by `session.tool.input.started`
// and run with the input `session.tool.called` carries. Events and messages of
// other types reach the driver as well, typed as these, and are dropped.

type OcEventOf<T extends string, D extends object> = {
  type: T;
  data: D & { sessionID?: string };
};

interface OcStreamPart {
  assistantMessageID: string;
  ordinal?: number;
}

interface OcError {
  type?: string;
  message?: string;
}

export type OcEvent =
  | OcEventOf<"session.text.started" | "session.reasoning.started", OcStreamPart>
  | OcEventOf<"session.text.delta" | "session.reasoning.delta", OcStreamPart & { delta: string }>
  | OcEventOf<"session.text.ended" | "session.reasoning.ended", OcStreamPart & { text: string }>
  | OcEventOf<"session.tool.input.started", { id: string; name: string }>
  | OcEventOf<"session.tool.called", { id: string; input: unknown }>
  | OcEventOf<
      "session.tool.success" | "session.tool.failed",
      { id: string; content?: OcContent[]; metadata?: Record<string, unknown>; error?: OcError }
    >
  | OcEventOf<"session.step.ended", { tokens?: OcTokens }>
  | OcEventOf<"session.usage.updated", { tokens?: OcTokens; cost?: number }>
  | OcEventOf<
      "session.retry.scheduled",
      { assistantMessageID: string; attempt: number; error?: OcError }
    >
  | OcEventOf<"session.compaction.ended", object>
  | OcEventOf<"session.compaction.failed", { error?: OcError }>
  | OcEventOf<"session.created", { parentID?: string | null }>
  | OcEventOf<"session.execution.started" | "session.execution.succeeded", object>
  | OcEventOf<"session.execution.failed", { error?: OcError }>
  | OcEventOf<"session.execution.interrupted", { reason?: string }>
  | OcEventOf<
      "session.inbox.enqueued",
      { inboxID: string; item: { type: string; payload?: { text?: string } } }
    >
  | OcEventOf<"session.inbox.delivered" | "session.inbox.cancelled", { inboxID: string }>
  | OcEventOf<"session.model.selected", { model: OcModelRef }>
  | OcEventOf<"session.agent.selected", { agent: string }>
  | OcEventOf<"permission.asked", OcPermission>
  | OcEventOf<"permission.replied", { requestID: string }>
  | OcEventOf<"form.created", { form: OcForm }>
  | OcEventOf<"form.replied" | "form.cancelled", { id: string }>;

/** A model as a session names it, with the variant that sets its effort. */
export interface OcModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OcTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface OcModel {
  id: string;
  providerID: string;
  name: string;
  type?: string;
  enabled: boolean;
  capabilities: { input: string[] };
  variants: { id: string }[];
  limit: { context: number };
}

export interface OcAgent {
  id: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permissions: OcRule[];
}

export interface OcFormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | string;
  title?: string;
  description?: string;
  hidden?: boolean;
  options?: ({ value: string; label?: string; description?: string } | string)[];
  custom?: boolean;
}

export interface OcForm {
  id: string;
  sessionID: string;
  title: string;
  fields: OcFormField[];
}

export interface OcPermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: { files?: OcFileDiff[]; input?: unknown };
  source?: { type: string; id: string };
  message?: string;
}

interface OcFileDiff {
  file: string;
  patch: string;
  status: "added" | "modified" | "deleted" | string;
}

type Streamed = Extract<Item, { kind: "assistant_message" | "reasoning" }>;

export interface OcContent {
  type: string;
  text?: string;
  uri?: string;
}

/** A message in `GET /api/session/{id}/message`. */
export type OcMessage =
  | { type: "user"; id: string; text: string }
  | {
      type: "assistant";
      id: string;
      content: (
        | { type: "text"; text: string }
        | { type: "reasoning"; text: string }
        | {
            type: "tool";
            id: string;
            name: string;
            state: {
              status: "streaming" | "running" | "completed" | "error";
              input: unknown;
              content?: OcContent[];
              metadata?: Record<string, unknown>;
              error?: { message: string };
            };
          }
      )[];
    }
  | {
      type: "shell";
      id: string;
      command: string;
      status: string;
      exit?: number | string;
      output?: { output: string };
    };

const CATEGORIES: Record<string, ToolCategory> = {
  read: "read",
  glob: "search",
  grep: "search",
  webfetch: "fetch",
};
/** Tools whose work another item shows: a question is its form. */
const HIDDEN_TOOLS = new Set(["question"]);
/** Actions that only read, which supervised and auto-edit allow without asking. */
const READ_ACTIONS = ["read", "glob", "grep", "question", "subagent", "skill"];

/** The rules each runtime mode adds to a session; the last rule that matches decides. */
const MODE_RULES: Record<RuntimeMode, OcRule[]> = {
  supervised: [
    { action: "*", resource: "*", effect: "ask" },
    ...READ_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
  ],
  "auto-edit": [
    { action: "*", resource: "*", effect: "ask" },
    ...READ_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
    { action: "edit", resource: "*", effect: "allow" },
  ],
  // OpenCode has no safety check to decide, so auto is never offered; were it asked, it asks.
  auto: [{ action: "*", resource: "*", effect: "ask" }],
  "full-access": [{ action: "*", resource: "*", effect: "allow" }],
};

export const RUNTIME_MODES: readonly RuntimeMode[] = ["supervised", "auto-edit", "full-access"];

/**
 * A session's rules for a runtime mode under an agent. The agent's own denials
 * come after the mode's, so what the user's config or the agent forbids stays
 * forbidden, and in plan mode so do the plan agent's rules for edits.
 */
export function sessionRules(
  mode: RuntimeMode,
  agent: OcAgent | undefined,
  plan: boolean,
): OcRule[] {
  const kept = (agent?.permissions ?? []).filter(
    (rule) => rule.effect === "deny" || (plan && rule.action === "edit"),
  );
  return [...MODE_RULES[mode], ...kept];
}

/**
 * A session's rules once 1harness's are replaced: the new ones, then the rules
 * OpenCode added itself, such as grants for another folder. A rule any mode or
 * agent has counts as 1harness's, since 1harness put it there.
 */
export function mergeRules(
  current: readonly OcRule[],
  ours: readonly OcRule[],
  agents: readonly OcAgent[],
): OcRule[] {
  const key = (rule: OcRule) => `${rule.action}\0${rule.resource}\0${rule.effect}`;
  const known = new Set(
    [...Object.values(MODE_RULES).flat(), ...agents.flatMap((agent) => agent.permissions)].map(key),
  );
  return [...ours, ...current.filter((rule) => !known.has(key(rule)))];
}

/** A name as OpenCode puts it in a tool's name: anything but letters, digits, `_` and `-` as `_`. */
function toolNamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** The server and tool an MCP tool's name joins, matching the longest server name. */
function mcpTool(
  name: string,
  servers: readonly string[],
): { server: string; tool: string } | null {
  const server = servers
    .filter((candidate) => name.startsWith(`${toolNamePart(candidate)}_`))
    .toSorted((a, b) => b.length - a.length)[0];
  return server ? { server, tool: name.slice(toolNamePart(server).length + 1) } : null;
}

/** `provider/model`, as 1harness names an OpenCode model. */
export function modelName(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`;
}

export function modelOptions(models: readonly OcModel[], fallback: string | null): ModelOption[] {
  return models
    .filter((model) => model.enabled && (model.type ?? "chat") === "chat")
    .map((model) => ({
      id: modelName(model),
      aliases: [model.id],
      label: model.name,
      description: modelName(model),
      efforts: model.variants.map((variant) => variant.id),
      defaultEffort: null,
      isDefault: modelName(model) === fallback,
    }));
}

/** The model a name means: `provider/model`, or a model ID a single provider offers. */
export function findModel(models: readonly OcModel[], name: string): OcModel | undefined {
  const enabled = models.filter((model) => model.enabled);
  const named = enabled.find((model) => modelName(model) === name);
  if (named) return named;
  const [only, ...others] = enabled.filter((model) => model.id === name);
  return others.length === 0 ? only : undefined;
}

const SUMMARY_KEYS = ["path", "url", "pattern", "query", "name", "description"];

/** OpenCode's patch without its header lines, starting at the first hunk. */
function hunks(patch: string): string {
  const start = patch.indexOf("@@");
  return start === -1 ? patch : patch.slice(start);
}

function changesFrom(files: readonly OcFileDiff[] | undefined, cwd: string): FileChange[] {
  return (files ?? []).map((file) => ({
    path: file.file.startsWith("/") ? file.file : `${cwd}/${file.file}`,
    kind: file.status === "added" ? "add" : file.status === "deleted" ? "delete" : "update",
    diff: hunks(file.patch),
  }));
}

/** A tool call as 1harness shows it, or null for one another item shows. */
export function toolItem(
  id: string,
  name: string,
  rawInput: unknown,
  mcpServers: readonly string[] = [],
): Item | null {
  const input = record(rawInput);
  switch (name) {
    case "shell":
      return {
        kind: "command",
        id,
        command: text(input["command"]),
        output: "",
        exitCode: null,
        status: "running",
      };
    case "edit": {
      const diff = unifiedDiff(text(input["oldString"]), text(input["newString"]));
      return {
        kind: "file_change",
        id,
        changes: [{ path: text(input["path"]), kind: "update", diff }],
        status: "running",
      };
    }
    case "write":
      return {
        kind: "file_change",
        id,
        changes: [
          {
            path: text(input["path"]),
            kind: "update",
            diff: unifiedDiff("", text(input["content"])),
          },
        ],
        status: "running",
      };
    case "subagent":
      return {
        kind: "agent",
        id,
        description: agentDescription(input),
        summary: "",
        status: "running",
      };
    case "patch": {
      // The patch names its files; their diffs come with its result.
      const changes = [
        ...text(input["patchText"]).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm),
      ].map(([, kind, path]): FileChange => ({
        path: (path ?? "").trim(),
        kind: kind === "Add" ? "add" : kind === "Delete" ? "delete" : "update",
        diff: "",
      }));
      return { kind: "file_change", id, changes, status: "running" };
    }
    case "websearch":
      return { kind: "web_search", id, query: text(input["query"]), status: "running" };
    default: {
      if (HIDDEN_TOOLS.has(name)) return null;
      // MCP tools go by their server's name and theirs, joined by an underscore.
      const mcp = mcpTool(name, mcpServers);
      return {
        kind: "tool_call",
        id,
        tool: mcp?.tool ?? name,
        server: mcp?.server ?? null,
        category: mcp ? "other" : (CATEGORIES[name] ?? "other"),
        summary: summarizeInput(input, SUMMARY_KEYS),
        output: "",
        status: "running",
      };
    }
  }
}

/** The item as its tool left it: its output, and what it changed. */
function finished(
  item: Item,
  status: ItemStatus,
  content: unknown,
  metadata: Record<string, unknown>,
  error: string,
  cwd: string,
): Item {
  const output = contentText(content) || error;
  switch (item.kind) {
    case "command": {
      const exit = metadata["exit"];
      return {
        ...item,
        output,
        exitCode: typeof exit === "number" ? exit : null,
        status:
          status === "completed" && typeof exit === "number" && exit !== 0 ? "failed" : status,
      };
    }
    case "file_change": {
      const changes = changesFrom(metadata["files"] as OcFileDiff[] | undefined, cwd);
      return { ...item, changes: changes.length > 0 ? changes : item.changes, status };
    }
    case "agent":
      return {
        ...item,
        summary: output.replace(/^<subagent[^>]*>\n?|\n?<\/subagent>$/g, ""),
        status,
      };
    case "tool_call":
      return { ...item, output, status };
    case "web_search":
      return { ...item, status };
    default:
      return item;
  }
}

/** What an approval is for, from the permission and the call that asks it. */
function permissionAction(permission: OcPermission, call: Item | undefined): ApprovalAction {
  if (permission.action === "shell")
    return {
      type: "command",
      command: call?.kind === "command" ? call.command : permission.resources.join(" && "),
      cwd: null,
    };
  if (permission.action === "edit") return { type: "file_change", paths: permission.resources };
  const input = permission.metadata?.input ?? permission.resources;
  if (call?.kind === "tool_call")
    return { type: "tool", tool: call.tool, server: call.server, input };
  return { type: "tool", tool: permission.action, server: null, input };
}

/** What "always" remembers, in the words of the choice. */
function savedSubject(permission: OcPermission, action: ApprovalAction): string {
  const patterns = (permission.save ?? []).filter((pattern) => pattern !== "*");
  if (patterns.length > 0) return patterns.map((pattern) => `\`${pattern}\``).join(", ");
  if (permission.action === "edit") return "edits here";
  const name =
    action.type === "tool" && action.server
      ? `${action.server} · ${action.tool}`
      : permission.action;
  return `${name} here`;
}

/**
 * The approval for a permission OpenCode asks. Rejecting stops the turn, as
 * OpenCode does; a decline with a reason lets the agent go on.
 */
export function permissionRequest(
  permission: OcPermission,
  call: Item | undefined,
  cwd: string,
): ApprovalRequest {
  const action = permissionAction(permission, call);
  const changes = changesFrom(permission.metadata?.files, cwd);
  const options: ApprovalOption[] = [
    { id: "once", label: ANSWER.yes, effect: "allow" },
    {
      id: "always",
      label: ANSWER.always(savedSubject(permission, action)),
      effect: "allow-always",
    },
    { id: "reject", label: ANSWER.noAndExplain, effect: "deny" },
  ];
  const input = permission.metadata?.input;
  const detail =
    action.type === "command"
      ? `$ ${action.command}`
      : changes.length > 0
        ? changes.map((change) => `${change.path}\n${change.diff}`).join("\n")
        : input !== undefined
          ? JSON.stringify(input)
          : permission.resources.filter((resource) => resource !== "*").join("\n");
  return {
    kind: "approval",
    id: permission.id,
    title: changes.length > 0 ? askForChanges(changes) : askFor(action),
    detail: [permission.message ?? "", detail].filter((line) => line.trim() !== "").join("\n"),
    action,
    options,
    defaultOptionId: "once",
  };
}

function optionLabel(option: NonNullable<OcFormField["options"]>[number]): {
  label: string;
  description: string;
} {
  return typeof option === "string"
    ? { label: option, description: "" }
    : { label: option.label ?? option.value, description: option.description ?? "" };
}

/** A form's fields as questions, one per visible field. */
export function formRequest(form: OcForm): QuestionRequest {
  const questions: Question[] = form.fields
    .filter((field) => !field.hidden)
    .map((field) => ({
      id: field.key,
      header: field.title ?? "",
      question: field.description ?? field.title ?? form.title,
      options:
        field.type === "boolean"
          ? [
              { label: ANSWER.yes, description: "" },
              { label: ANSWER.no, description: "" },
            ]
          : (field.options ?? []).map(optionLabel),
      multiSelect: field.type === "multiselect",
      allowOther:
        field.custom === true || (field.type !== "boolean" && (field.options ?? []).length === 0),
      secret: false,
    }));
  return { kind: "question", id: form.id, questions };
}

/** The form's answer from the user's: option values for labels, and each field's type. */
export function formAnswer(
  form: OcForm,
  answers: Record<string, string[]>,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const given = answers[field.key];
    if (!given || given.length === 0) continue;
    const values = given.map((label) => {
      const option = (field.options ?? []).find(
        (candidate) => optionLabel(candidate).label === label,
      );
      return option === undefined ? label : typeof option === "string" ? option : option.value;
    });
    if (field.type === "multiselect") answer[field.key] = values;
    else if (field.type === "boolean") answer[field.key] = given[0] === ANSWER.yes;
    else if (field.type === "number" || field.type === "integer")
      answer[field.key] = Number(values[0]);
    else answer[field.key] = values[0] ?? "";
  }
  return answer;
}

/**
 * Turns one session's OpenCode events into 1harness's: messages and reasoning
 * stream by their assistant message and ordinal, and tools by their call ID.
 */
export class OpenCodeTranslator {
  readonly cwd: string;
  mcpServers: readonly string[] = [];
  contextWindow: number | null = null;
  #names = new Map<string, string>();
  #tools = new Map<string, Item>();
  /** Diffs a permission showed for a call, for writes whose result has none. */
  #diffs = new Map<string, OcFileDiff[]>();
  /** Replies and reasoning streaming in. */
  #open = new Map<string, Streamed>();
  #usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: null,
    contextWindow: null,
    costUsd: null,
    limits: [],
  };

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** The tool call item a call ID names, while it runs. */
  tool(id: string): Item | undefined {
    return this.#tools.get(id);
  }

  /**
   * The IDs of the calls of an MCP tool, on any server, from when the model
   * starts writing their input until they finish, so a call is found even if
   * it reaches the tool before its start reaches 1harness.
   */
  running(tool: string): string[] {
    const wanted = toolNamePart(tool);
    return [...this.#names]
      .filter(([, name]) => mcpTool(name, this.mcpServers)?.tool === wanted)
      .map(([id]) => id);
  }

  translate(event: OcEvent): HarnessEvent[] {
    switch (event.type) {
      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "assistant_message" : "reasoning";
        const item: Streamed = { kind, id: streamId(event.data, kind), text: "" };
        this.#open.set(item.id, item);
        return [{ type: "item.started", item }];
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "assistant_message" : "reasoning";
        const id = streamId(event.data, kind);
        const open = this.#open.get(id);
        const chunk = text(event.data.delta);
        if (!open || !chunk) return [];
        this.#open.set(id, { ...open, text: open.text + chunk });
        return [{ type: "item.delta", itemId: id, chunk }];
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "assistant_message" : "reasoning";
        const id = streamId(event.data, kind);
        this.#open.delete(id);
        return [{ type: "item.completed", item: { kind, id, text: text(event.data.text) } }];
      }
      case "session.tool.input.started":
        this.#names.set(event.data.id, event.data.name);
        return [];
      case "session.tool.called": {
        const { id, input } = event.data;
        const item = toolItem(id, this.#names.get(id) ?? "", input, this.mcpServers);
        if (!item) return [];
        this.#tools.set(id, item);
        return [{ type: "item.started", item }];
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const { id, error = {} } = event.data;
        const item = this.#tools.get(id);
        this.#tools.delete(id);
        this.#names.delete(id);
        const diffs = this.#diffs.get(id);
        this.#diffs.delete(id);
        if (!item) return [];
        const failed = event.type === "session.tool.failed";
        const declined =
          error.type === "permission.rejected" ||
          error.message === "The user declined this tool call";
        const metadata = { ...(diffs ? { files: diffs } : {}), ...record(event.data.metadata) };
        const status: ItemStatus = !failed ? "completed" : declined ? "declined" : "failed";
        return [
          {
            type: "item.completed",
            item: finished(
              item,
              status,
              event.data.content,
              metadata,
              text(error.message),
              this.cwd,
            ),
          },
        ];
      }
      case "permission.asked": {
        const permission = event.data;
        if (permission.source?.id && permission.metadata?.files)
          this.#diffs.set(permission.source.id, permission.metadata.files);
        return [];
      }
      case "session.step.ended": {
        const tokens = event.data.tokens;
        if (!tokens) return [];
        this.#usage = {
          ...this.#usage,
          contextTokens: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output,
          contextWindow: this.contextWindow,
        };
        return [{ type: "usage.updated", usage: { ...this.#usage } }];
      }
      case "session.usage.updated": {
        const { tokens, cost } = event.data;
        if (!tokens) return [];
        this.#usage = {
          ...this.#usage,
          inputTokens: tokens.input + tokens.cache.read + tokens.cache.write,
          outputTokens: tokens.output + tokens.reasoning,
          contextWindow: this.contextWindow,
          costUsd: typeof cost === "number" ? cost : this.#usage.costUsd,
        };
        return [{ type: "usage.updated", usage: { ...this.#usage } }];
      }
      case "session.retry.scheduled":
        return [
          {
            type: "item.updated",
            item: {
              kind: "notice",
              id: `opencode-retry-${text(event.data.assistantMessageID)}`,
              level: "warning",
              text: `Retrying (attempt ${String(event.data.attempt)}): ${text(event.data.error?.message)}`,
            },
          },
        ];
      case "session.compaction.ended":
        return [noticeEvent("opencode", "info", "Compacted the conversation")];
      case "session.compaction.failed":
        return [
          noticeEvent("opencode", "error", `Compaction failed: ${text(event.data.error?.message)}`),
        ];
      default:
        return [];
    }
  }

  /**
   * Ends what the turn left open: streams with the text they have, and calls
   * as failed, since a turn that ends first never finished them.
   */
  flush(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const item of this.#open.values()) events.push({ type: "item.completed", item });
    for (const item of this.#tools.values())
      events.push({ type: "item.completed", item: finished(item, "failed", [], {}, "", this.cwd) });
    this.#open.clear();
    this.#tools.clear();
    this.#names.clear();
    this.#diffs.clear();
    return events;
  }

  /** A session's history as completed items, oldest first. */
  history(messages: readonly OcMessage[]): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const message of messages) {
      if (message.type === "user") {
        events.push({
          type: "item.completed",
          item: { kind: "user_message", id: message.id, text: message.text },
        });
      } else if (message.type === "assistant") {
        message.content.forEach((part, index) => {
          if (part.type === "text" && part.text.trim() !== "") {
            events.push({
              type: "item.completed",
              item: {
                kind: "assistant_message",
                id: `${message.id}:text:${index}`,
                text: part.text,
              },
            });
          } else if (part.type === "tool") {
            const item = toolItem(part.id, part.name, part.state.input, this.mcpServers);
            if (!item) return;
            const status: ItemStatus = part.state.status === "completed" ? "completed" : "failed";
            events.push({
              type: "item.completed",
              item: finished(
                item,
                status,
                part.state.content,
                part.state.metadata ?? {},
                part.state.error?.message ?? "",
                this.cwd,
              ),
            });
          }
        });
      } else if (message.type === "shell") {
        const exit = typeof message.exit === "number" ? message.exit : null;
        events.push({
          type: "item.completed",
          item: {
            kind: "command",
            id: message.id,
            command: message.command,
            output: message.output?.output ?? "",
            exitCode: exit,
            status: exit === 0 ? "completed" : "failed",
          },
        });
      }
    }
    return events;
  }
}

function streamId(data: OcStreamPart, kind: "assistant_message" | "reasoning"): string {
  const part = kind === "assistant_message" ? "text" : "reasoning";
  return `${text(data.assistantMessageID)}:${part}:${String(data.ordinal ?? 0)}`;
}
