import { truncate } from "../core/wording.ts";
import {
  isRuntimeMode,
  modeRank,
  type HarnessId,
  type Item,
  type RequestResponse,
  type RuntimeMode,
} from "../core/events.ts";
import { MAX_WAIT_SECONDS, RUNTIME_MODE_SCHEMA, required, text } from "../operations/input.ts";
import {
  CALLER_KINDS,
  OperationError,
  type Caller,
  type Operation,
} from "../operations/operation.ts";
import type { HostEvent, LogEntry, Method, Params, Result } from "../protocol.ts";
import type { ThreadManager } from "./manager.ts";
import { threadView } from "./orchestrator.ts";
import type { Scope, ThreadSnapshot } from "./scope.ts";
import { sendText } from "./send.ts";

/** How many events one `thread_events` returns at most. */
const EVENT_LIMIT = 200;
/** How much of a message or output an event carries. */
const TEXT_LIMIT = 2000;

/** What the host's own operations need of it. */
export interface HostAccess {
  readonly manager: ThreadManager;
  readonly scope: Scope;
  /** Runs a client request on behalf of `caller`, as the server would run it. */
  request<M extends Method>(caller: Caller, method: M, params: Params<M>): Promise<Result<M>>;
  /** The folder a caller works in, where threads it starts run by default. */
  cwd(caller: Caller): string;
  /** The harness a thread starts on when none is named, or null when the user chose none. */
  defaultHarness(): HarnessId | null;
  /** The mode a person's new thread starts in. */
  defaultMode(): RuntimeMode;
  /** The newest event's number. */
  seq(): number;
  since(after: number): HostEvent[] | null;
  subscribe(listener: (event: HostEvent) => void): () => void;
}

const PEOPLE_AND_OUTSIDE = ["user", "external"] as const;

const THREAD_ID = { type: "string", description: "A thread's ID." };

/**
 * The host's operations beyond the orchestrator's: starting, forking,
 * moving, and tuning threads, following them by cursor, and the ones only a
 * person may do, such as answering approvals.
 */
export function hostOperations(host: HostAccess): Operation[] {
  const { scope } = host;
  return [
    {
      name: "harness_list",
      description:
        "Lists the harnesses 1harness can run, and whether each is ready, needs signing in, or is missing.",
      inputSchema: {
        type: "object",
        properties: { harness: { type: "string", description: "Check this harness again first." } },
      },
      effect: "read",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const id = text(input, "harness");
        return host.request(caller, "harnesses.list", id ? { id } : {});
      },
    },
    {
      name: "thread_search",
      description:
        "Finds threads whose transcripts mention the words, kept ones included, best matches first, with where.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
      effect: "read",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const limit = typeof input["limit"] === "number" ? input["limit"] : 20;
        const found = await host.request(caller, "threads.search", {
          query: required(input, "query"),
          limit,
        });
        const visible = new Set(scope.visible(caller).map((thread) => thread.id));
        return found
          .filter((hit) => caller.kind !== "agent" || visible.has(hit.thread.id))
          .map(({ thread, snippet }) => ({
            threadId: thread.id,
            title: thread.title,
            harness: thread.harness,
            status: thread.status,
            cwd: thread.cwd,
            updatedAt: thread.updatedAt,
            snippet,
          }));
      },
    },
    {
      name: "thread_open",
      description:
        "Starts a thread on a harness, with a first message if given. The harness, folder, model, and mode default to the user's.",
      inputSchema: {
        type: "object",
        properties: {
          harness: { type: "string", description: "One harness_list says is ready." },
          message: { type: "string", description: "The first message to send it." },
          cwd: { type: "string", description: "The folder it works in." },
          model: { type: "string" },
          effort: { type: "string" },
          runtimeMode: RUNTIME_MODE_SCHEMA,
          plan: { type: "boolean", description: "Start in plan mode." },
          title: { type: "string" },
        },
      },
      effect: "act",
      callers: PEOPLE_AND_OUTSIDE,
      run: async (input, { caller }) => {
        const harness = text(input, "harness") ?? host.defaultHarness();
        if (!harness)
          throw new OperationError("invalid_request", "name a harness; harness_list lists them");
        const ceiling = scope.ceiling(caller);
        const asked = text(input, "runtimeMode");
        if (asked !== undefined && !isRuntimeMode(asked))
          throw new OperationError("invalid_request", `no runtime mode ${asked}`);
        const preferred = host.defaultMode();
        const mode =
          asked ?? (ceiling && modeRank(preferred) > modeRank(ceiling) ? ceiling : preferred);
        const plan = input["plan"] === true;
        scope.allows(caller, mode, plan ? "plan" : "default");
        const title = text(input, "title");
        const state = await host.request(caller, "thread.open", {
          harness,
          settings: {
            cwd: text(input, "cwd") ?? host.cwd(caller),
            model: text(input, "model") ?? null,
            effort: text(input, "effort") ?? null,
            runtimeMode: mode,
            interactionMode: plan ? "plan" : "default",
            resume: null,
          },
          ...(title ? { title } : {}),
        });
        const message = text(input, "message");
        const thread = host.manager.get(state.id)!;
        if (message) await sendText(thread.thread, message, { origin: scope.sender(caller) });
        return threadView(thread);
      },
    },
    {
      name: "thread_fork",
      description:
        "Starts a new thread on the same harness and folder from another's turns, through `turn` or all of them.",
      inputSchema: {
        type: "object",
        properties: { threadId: THREAD_ID, turn: { type: "number" } },
        required: ["threadId"],
      },
      effect: "act",
      callers: PEOPLE_AND_OUTSIDE,
      run: async (input, { caller }) => {
        const source = scope.readable(caller, required(input, "threadId"));
        scope.allows(
          caller,
          source.thread.info.runtimeMode,
          source.thread.info.interactionMode,
          source,
        );
        const turn = input["turn"];
        const state = await host.request(caller, "thread.fork", {
          threadId: source.id,
          ...(typeof turn === "number" ? { turn } : {}),
        });
        return threadView(host.manager.get(state.id)!);
      },
    },
    {
      name: "thread_switch_harness",
      description:
        "Moves a thread to another harness, which is brought up to date on the turns it has not seen with its next message. fresh starts that harness a new session instead of resuming its earlier one.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: THREAD_ID,
          harness: { type: "string" },
          fresh: { type: "boolean" },
        },
        required: ["threadId", "harness"],
      },
      effect: "act",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        return host.request(caller, "thread.switchHarness", {
          threadId: target.id,
          harness: required(input, "harness"),
          fresh: input["fresh"] === true,
        });
      },
    },
    {
      name: "thread_set_model",
      description:
        "Changes a thread's model, its reasoning effort, or both; thread_models lists what its harness offers.",
      inputSchema: {
        type: "object",
        properties: { threadId: THREAD_ID, model: { type: "string" }, effort: { type: "string" } },
        required: ["threadId"],
      },
      effect: "act",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        const model = text(input, "model");
        const effort = text(input, "effort");
        if (!model && !effort)
          throw new OperationError("invalid_request", "name a model, an effort, or both");
        if (model)
          await host.request(caller, "thread.call", {
            threadId: target.id,
            method: "setModel",
            args: [model],
          });
        if (effort)
          await host.request(caller, "thread.call", {
            threadId: target.id,
            method: "setEffort",
            args: [effort],
          });
        return threadView(target);
      },
    },
    {
      name: "thread_models",
      description: "Lists the models a thread's harness offers, with their reasoning efforts.",
      inputSchema: { type: "object", properties: { threadId: THREAD_ID }, required: ["threadId"] },
      effect: "read",
      callers: CALLER_KINDS,
      run: async (input, { caller }) =>
        host.request(caller, "thread.call", {
          threadId: scope.readable(caller, required(input, "threadId")).id,
          method: "listModels",
          args: [],
        }),
    },
    {
      name: "thread_mcp_servers",
      description: "Lists the MCP servers a thread's session uses, and how each stands.",
      inputSchema: { type: "object", properties: { threadId: THREAD_ID }, required: ["threadId"] },
      effect: "read",
      callers: CALLER_KINDS,
      run: async (input, { caller }) =>
        host.request(caller, "thread.call", {
          threadId: scope.readable(caller, required(input, "threadId")).id,
          method: "listMcpServers",
          args: [],
        }),
    },
    {
      name: "thread_compact",
      description: "Has a thread's harness compact its context.",
      inputSchema: { type: "object", properties: { threadId: THREAD_ID }, required: ["threadId"] },
      effect: "act",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        await host.request(caller, "thread.call", {
          threadId: target.id,
          method: "compact",
          args: [],
        });
        return threadView(target);
      },
    },
    {
      name: "thread_close",
      description: "Ends a thread's session, and the threads it started. It can be reopened later.",
      inputSchema: { type: "object", properties: { threadId: THREAD_ID }, required: ["threadId"] },
      effect: "act",
      callers: PEOPLE_AND_OUTSIDE,
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        await host.request(caller, "thread.close", { threadId: target.id });
        return threadView(target);
      },
    },
    {
      name: "thread_events",
      description:
        "What happened in a thread after a cursor: messages, replies, commands, files changed, tools, turns, and what it waits on the user for. Pass the cursor it returns to the next call to pick up where you left off, across restarts of your own; timeoutSeconds waits for something new. Without a cursor it returns the current one. gap means events were missed, as after 1harness restarted: read the thread with thread_read instead.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: THREAD_ID,
          after: { type: "number", description: "The cursor a previous call returned." },
          timeoutSeconds: {
            type: "number",
            description: `How long to wait for something new, at most ${MAX_WAIT_SECONDS}; 0 by default.`,
          },
        },
        required: ["threadId"],
      },
      effect: "read",
      callers: CALLER_KINDS,
      run: async (input, { caller }) => {
        const thread = scope.readable(caller, required(input, "threadId"));
        const after = input["after"];
        if (typeof after !== "number")
          return { cursor: host.seq(), events: [], gap: false, ...threadView(thread) };
        const wait = typeof input["timeoutSeconds"] === "number" ? input["timeoutSeconds"] : 0;
        return threadEvents(host, thread, after, Math.min(wait, MAX_WAIT_SECONDS) * 1000);
      },
    },
    {
      name: "thread_respond",
      description:
        "Answers an approval or question a thread waits on, as thread_list's waitingOn shows them: an approval with optionId, a question with answers by question ID, or decline with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: THREAD_ID,
          requestId: { type: "string" },
          optionId: { type: "string" },
          answers: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
          decline: { type: "string", description: "Turn it down, telling the agent why." },
        },
        required: ["threadId", "requestId"],
      },
      effect: "act",
      callers: ["user"],
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        await host.request(caller, "thread.respond", {
          threadId: target.id,
          requestId: required(input, "requestId"),
          response: responseOf(input),
        });
        return threadView(target);
      },
    },
    {
      name: "thread_set_mode",
      description:
        "Changes what a thread may do without asking, or puts it in or out of plan mode.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: THREAD_ID,
          runtimeMode: RUNTIME_MODE_SCHEMA,
          plan: { type: "boolean" },
        },
        required: ["threadId"],
      },
      effect: "act",
      callers: ["user"],
      run: async (input, { caller }) => {
        const target = scope.actable(caller, required(input, "threadId"));
        const mode = text(input, "runtimeMode");
        if (mode !== undefined && !isRuntimeMode(mode))
          throw new OperationError("invalid_request", `no runtime mode ${mode}`);
        if (mode)
          await host.request(caller, "thread.call", {
            threadId: target.id,
            method: "setRuntimeMode",
            args: [mode],
          });
        if (typeof input["plan"] === "boolean")
          await host.request(caller, "thread.call", {
            threadId: target.id,
            method: "setInteractionMode",
            args: [input["plan"] ? "plan" : "default"],
          });
        return threadView(target);
      },
    },
    {
      name: "thread_forget",
      description:
        "Deletes a thread, and the threads it started, for good. Their worktrees go too, unless they hold work: those stay, and the result names them.",
      inputSchema: { type: "object", properties: { threadId: THREAD_ID }, required: ["threadId"] },
      effect: "act",
      callers: ["user"],
      run: async (input, { caller }) =>
        host.request(caller, "thread.forget", { threadId: required(input, "threadId") }),
    },
  ];
}

/** The answer `thread_respond` was given. */
function responseOf(input: Record<string, unknown>): RequestResponse {
  const optionId = text(input, "optionId");
  if (optionId) return { kind: "approval", optionId };
  const decline = text(input, "decline");
  if (decline) return { kind: "decline", reason: decline };
  const answers = input["answers"];
  if (typeof answers === "object" && answers !== null && !Array.isArray(answers))
    return { kind: "question", answers: answers as Record<string, string[]> };
  throw new OperationError("invalid_request", "give optionId, answers, or decline");
}

/**
 * A thread's events after a cursor, waiting up to `waitMs` for the first. The
 * cursor it returns is the last event it looked at, so none is skipped.
 */
async function threadEvents(
  host: HostAccess,
  thread: ThreadSnapshot,
  after: number,
  waitMs: number,
) {
  const backlog = host.since(after);
  if (backlog === null) return { cursor: host.seq(), events: [], gap: true, ...threadView(thread) };
  let through = backlog.at(-1)?.seq ?? after;
  let events = summarize(backlog, thread.id);
  if (events.length === 0 && waitMs > 0) {
    events = await new Promise((resolve) => {
      const seen: HostEvent[] = [];
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve(summarize(seen, thread.id));
      };
      const timer = setTimeout(done, waitMs);
      const unsubscribe = host.subscribe((event) => {
        if (event.seq <= through) return;
        seen.push(event);
        through = event.seq;
        if (summarize([event], thread.id).length > 0) done();
      });
    });
  }
  const shown = events.slice(0, EVENT_LIMIT);
  const last = shown.at(-1);
  return {
    cursor: shown.length < events.length && last ? last.seq : through,
    events: shown,
    gap: false,
    ...threadView(thread),
  };
}

type EventView = { seq: number; type: string } & Record<string, unknown>;

/** A thread's events in brief: finished items, turns, answers, and waits on the user. */
function summarize(events: readonly HostEvent[], threadId: string): EventView[] {
  const views: EventView[] = [];
  let waiting = "";
  for (const event of events) {
    if (event.type === "removed" && event.threadId === threadId)
      views.push({ seq: event.seq, type: "removed" });
    if (event.type === "thread" && event.thread.id === threadId) {
      const { status, requests } = event.thread;
      const key = status === "waiting" ? requests.map((request) => request.id).join(",") : "";
      if (status === "waiting" && key !== waiting)
        views.push({
          seq: event.seq,
          type: "waiting",
          requests: requests.map((request) => ({
            requestId: request.id,
            kind: request.kind,
            title: request.kind === "approval" ? request.title : null,
          })),
        });
      waiting = key;
    }
    if (event.type !== "entry" || event.threadId !== threadId) continue;
    const view = entryView(event.entry);
    if (view) views.push({ seq: event.seq, ...view });
  }
  return views;
}

function entryView(entry: LogEntry): ({ type: string } & Record<string, unknown>) | null {
  switch (entry.type) {
    case "turn.started":
      return { type: "turn.started" };
    case "turn.ended":
      return { type: "turn.ended", status: entry.status, error: entry.error };
    case "decision":
      return { type: "decision", title: entry.title, outcome: entry.outcome, answer: entry.answer };
    case "agent":
      return { type: "thread.started", threadId: entry.threadId };
    case "session.ended":
      return { type: "session.ended", error: entry.error };
    case "html":
      return { type: "page", title: entry.title };
    case "item":
      return entry.done ? itemView(entry.item, entry.message?.origin.type ?? "user") : null;
    case "delta":
      return null;
  }
}

function itemView(item: Item, from: string): ({ type: string } & Record<string, unknown>) | null {
  switch (item.kind) {
    case "user_message":
      return { type: "message", from, text: truncate(item.text, TEXT_LIMIT) };
    case "assistant_message":
      return { type: "reply", text: truncate(item.text, TEXT_LIMIT) };
    case "command":
      return {
        type: "command",
        command: truncate(item.command, TEXT_LIMIT),
        exitCode: item.exitCode,
        status: item.status,
      };
    case "file_change":
      return {
        type: "files",
        changes: item.changes.map((change) => ({ kind: change.kind, path: change.path })),
        status: item.status,
      };
    case "tool_call":
      return {
        type: "tool",
        tool: item.tool,
        server: item.server,
        summary: truncate(item.summary, TEXT_LIMIT),
        status: item.status,
      };
    case "web_search":
      return { type: "search", query: item.query, status: item.status };
    case "agent":
      return { type: "agent", description: item.description, status: item.status };
    case "todo_list":
      return { type: "todo", steps: item.steps };
    case "plan":
      return { type: "plan", text: truncate(item.text, TEXT_LIMIT) };
    case "notice":
      return { type: "notice", level: item.level, text: item.text };
    case "reasoning":
      return null;
  }
}
