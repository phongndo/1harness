import { errorMessage } from "../core/errors.ts";
import {
  RUNTIME_MODES,
  isRuntimeMode,
  type HarnessId,
  type HarnessRequest,
  type Item,
  type ModelOption,
  type RuntimeMode,
} from "../core/events.ts";
import { MODE_DESCRIPTIONS } from "../core/wording.ts";
import { JsonRpcPeer, RpcError } from "../drivers/jsonrpc.ts";
import type { LogEntry, ThreadState } from "../protocol.ts";
import type { ClientEvent, HostClient } from "./client.ts";

export const ACP_HELP = `Usage: 1harness acp [-H <harness>] [--mode <mode>]

Runs 1harness as an Agent Client Protocol agent over stdio, for editors such
as Zed and JetBrains: configure the editor to run \`1harness acp\`. Each editor
session is a 1harness thread, kept in the server, on any harness: switch with
the session's Harness option, and pick its model, effort, and mode there too.
The same threads show in \`1harness\` and \`1harness threads\`.

  -H, --harness <name>   the harness new sessions start on (default: "harness"
                         in settings.json, else the one used last)
      --mode <mode>      supervised, auto-edit, auto, or full-access (default:
                         "mode" in settings.json, else full-access)

Approvals go to the editor; questions are answered in the 1harness terminal.
The harness's own MCP servers and 1harness's mcp.json apply, not the editor's.
`;

const PROTOCOL_VERSION = 1;
const PLAN = "plan";

/** What ACP calls a tool, from what the item does. */
function toolKind(item: Item): string {
  switch (item.kind) {
    case "command":
      return "execute";
    case "file_change":
      return "edit";
    case "web_search":
      return "search";
    case "tool_call":
      return item.category === "other" ? "other" : item.category;
    case "agent":
      return "think";
    default:
      return "other";
  }
}

function toolTitle(item: Item): string {
  switch (item.kind) {
    case "command":
      return item.command;
    case "file_change":
      return item.changes.map((change) => change.path).join(", ");
    case "web_search":
      return `Search: ${item.query}`;
    case "tool_call":
      return item.summary || item.tool;
    case "agent":
      return item.description;
    default:
      return item.kind;
  }
}

function toolOutput(item: Item): string {
  if (item.kind === "command" || item.kind === "tool_call") return item.output;
  if (item.kind === "agent") return item.summary;
  return "";
}

function toolStatus(item: Item): string {
  const status = "status" in item ? item.status : "completed";
  if (status === "running") return "in_progress";
  return status === "completed" ? "completed" : "failed";
}

const TOOL_KINDS = new Set<Item["kind"]>([
  "command",
  "file_change",
  "web_search",
  "tool_call",
  "agent",
]);

/** The ACP kind of an approval choice, from what choosing it does. */
function optionKind(effect: string): string {
  if (effect === "allow") return "allow_once";
  if (effect === "allow-always") return "allow_always";
  return "reject_once";
}

/** A session option the editor shows as a menu. */
function select(
  id: string,
  name: string,
  category: string,
  current: string,
  options: { value: string; name: string; description?: string }[],
) {
  return { id, name, category, type: "select", currentValue: current, options };
}

/** Text from ACP content blocks: text as it is, resources by their text or link. */
function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((raw) => {
      const block = raw as {
        type?: string;
        text?: string;
        uri?: string;
        resource?: { uri?: string; text?: string };
      };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "resource_link") return block.uri ? `@${block.uri}` : "";
      if (block.type === "resource" && block.resource?.text)
        return `${block.resource.uri ?? "context"}:\n${block.resource.text}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

interface Defaults {
  harness: HarnessId | null;
  mode: RuntimeMode;
}

/** One prompt, from the message it sent to the end of the turn that message started. */
interface Prompt {
  /** The feed position it was sent at, once the server said; events after it are news. */
  after: number | null;
  /** Turns that end before the prompt's own starts. */
  ahead: number;
  /** The thread's runs before it; a failed run after them that never started a turn is its own. */
  runs: number;
  /** Its turn started. */
  started: boolean;
  resolve: (stopReason: string) => void;
  reject: (error: Error) => void;
}

/** How many of a thread's recent entries are kept, for ones that arrive before the send's answer. */
const BACKLOG = 2000;

/** An editor session: a thread, and what was sent of it. */
interface Session {
  threadId: string;
  prompt: Prompt | null;
  /** Item kinds by ID, so a delta can say whose text it is. */
  kinds: Map<string, Item["kind"]>;
  /** How much of each message was sent as it streamed. */
  streamed: Map<string, number>;
  /** Tool calls told of, so later changes are updates. */
  tools: Set<string>;
  /** Approvals put to the editor. */
  asked: Set<string>;
  title: string;
  /** Recent entries with their feed positions, newest last. */
  backlog: { seq: number; entry: LogEntry }[];
}

/**
 * `1harness acp`: an ACP agent whose sessions are 1harness threads. It is a
 * person's client, through their editor, so it may do whatever they may.
 */
export class AcpAgent {
  #peer: JsonRpcPeer;
  #client: HostClient;
  #defaults: Defaults;
  #version: string;
  #sessions = new Map<string, Session>();

  constructor(peer: JsonRpcPeer, client: HostClient, defaults: Defaults, version: string) {
    this.#peer = peer;
    this.#client = client;
    this.#defaults = defaults;
    this.#version = version;
  }

  /** Answers the editor, and follows the server's events for its sessions. */
  listen(): () => void {
    this.#peer.onRequest(async (method, params) => {
      try {
        return await this.#request(method, (params ?? {}) as Params);
      } catch (error) {
        // What the server refused is the editor's to show, not a fault here.
        if (error instanceof RpcError) throw error;
        throw new RpcError(-32603, errorMessage(error));
      }
    });
    this.#peer.onNotification((method, params) => {
      if (method === "session/cancel") void this.#cancel((params ?? {}) as Params);
    });
    return this.#client.on((event) => this.#event(event));
  }

  async #request(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { list: {} },
          },
          authMethods: [],
          agentInfo: { name: "1harness", title: "1harness", version: this.#version },
        };
      case "authenticate":
        return {};
      case "session/new":
        return this.#newSession(params);
      case "session/load":
        return this.#loadSession(params);
      case "session/list":
        return this.#listSessions(params);
      case "session/prompt":
        return this.#prompt(params);
      case "session/set_mode":
        return this.#setMode(params);
      case "session/set_config_option":
        return this.#setOption(params);
      default:
        throw new RpcError(-32601, `1harness does not handle ${method}`);
    }
  }

  async #newSession(params: Params): Promise<unknown> {
    const harness = this.#defaults.harness;
    if (!harness)
      throw new RpcError(
        -32602,
        "No harness to start: run `1harness acp -H <harness>`, or set one with ctrl+s in 1harness's harness pick",
      );
    const state = await this.#client.call("thread.open", {
      harness,
      settings: {
        cwd: typeof params["cwd"] === "string" ? params["cwd"] : process.cwd(),
        model: null,
        effort: null,
        runtimeMode: this.#defaults.mode,
        interactionMode: "default",
        resume: null,
      },
    });
    this.#track(state);
    return { sessionId: state.id, ...(await this.#controls(state)) };
  }

  async #loadSession(params: Params): Promise<unknown> {
    const id = String(params["sessionId"] ?? "");
    const state = await this.#client.call("thread.resume", {
      id,
      harness: this.#defaults.harness ?? "claude",
      settings: {
        cwd: typeof params["cwd"] === "string" ? params["cwd"] : process.cwd(),
        model: null,
        effort: null,
        runtimeMode: this.#defaults.mode,
        interactionMode: "default",
        resume: null,
      },
    });
    const session = this.#track(state, id);
    // The editor shows the conversation from what it is sent, so it is sent again.
    const page = await this.#client.call("thread.attach", { threadId: state.id });
    for (const { entry } of page.entries) this.#replay(session, id, entry);
    return this.#controls(state);
  }

  async #listSessions(params: Params): Promise<unknown> {
    const cwd = typeof params["cwd"] === "string" ? params["cwd"] : null;
    const threads = await this.#client.call("threads.list", { scope: "recent", limit: 200 });
    return {
      sessions: threads
        .filter((thread) => thread.parentId === null && (!cwd || thread.cwd === cwd))
        .map((thread) => ({
          sessionId: thread.id,
          cwd: thread.cwd,
          title: thread.title,
          updatedAt: new Date(thread.updatedAt).toISOString(),
        })),
    };
  }

  #track(state: ThreadState, sessionId = state.id): Session {
    const session: Session = {
      threadId: state.id,
      prompt: null,
      kinds: new Map(),
      streamed: new Map(),
      tools: new Set(),
      asked: new Set(),
      title: state.title,
      backlog: [],
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  #session(params: Params): { id: string; session: Session } {
    const id = String(params["sessionId"] ?? "");
    const session = this.#sessions.get(id);
    if (!session) throw new RpcError(-32602, `No session ${id}; create or load it first`);
    return { id, session };
  }

  async #prompt(params: Params): Promise<unknown> {
    const { id, session } = this.#session(params);
    if (session.prompt) throw new RpcError(-32600, "This session is already answering a prompt");
    const text = promptText(params["prompt"]);
    if (!text) throw new RpcError(-32602, "The prompt has no text");
    const { runCount: runs } = await this.#fresh(session.threadId);
    const stopReason = await new Promise<string>((resolve, reject) => {
      const prompt: Prompt = { after: null, ahead: 0, runs, started: false, resolve, reject };
      session.prompt = prompt;
      this.#client.call("thread.send", { threadId: session.threadId, text }).then(
        ({ seq, ahead }) => {
          prompt.after = seq ?? this.#lastSeq(session);
          prompt.ahead = ahead ?? 0;
          // What the server sent before it answered is caught up on first.
          for (const logged of session.backlog)
            if (logged.seq > prompt.after && session.prompt === prompt)
              this.#forward(id, session, prompt, logged.entry);
          const state = this.#client.threads.get(session.threadId);
          if (state && session.prompt === prompt) this.#threadChanged(id, session, state);
        },
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    }).finally(() => {
      session.prompt = null;
    });
    return { stopReason };
  }

  async #cancel(params: Params): Promise<void> {
    const session = this.#sessions.get(String(params["sessionId"] ?? ""));
    if (session) await this.#client.call("thread.stop", { threadId: session.threadId });
  }

  async #setMode(params: Params): Promise<unknown> {
    const { session } = this.#session(params);
    const mode = String(params["modeId"] ?? "");
    const call = (method: "setRuntimeMode" | "setInteractionMode", arg: string) =>
      this.#client.call("thread.call", { threadId: session.threadId, method, args: [arg] });
    if (mode === PLAN) await call("setInteractionMode", "plan");
    else if (isRuntimeMode(mode)) {
      await call("setRuntimeMode", mode);
      const state = await this.#fresh(session.threadId);
      if (state.info.interactionMode === "plan") await call("setInteractionMode", "default");
    } else throw new RpcError(-32602, `No mode ${mode}`);
    return {};
  }

  async #setOption(params: Params): Promise<unknown> {
    const { session } = this.#session(params);
    const value = String(params["value"] ?? "");
    const threadId = session.threadId;
    switch (params["configId"]) {
      case "harness":
        await this.#client.call("thread.switchHarness", { threadId, harness: value });
        break;
      case "model":
        await this.#client.call("thread.call", {
          threadId,
          method: "setModel",
          args: [value === "default" ? null : value],
        });
        break;
      case "effort":
        await this.#client.call("thread.call", {
          threadId,
          method: "setEffort",
          args: [value === "default" ? null : value],
        });
        break;
      default:
        throw new RpcError(-32602, `No option ${String(params["configId"])}`);
    }
    return this.#controls(await this.#fresh(threadId));
  }

  /** The thread as it stands after a change, which its events may not have brought yet. */
  async #fresh(threadId: string): Promise<ThreadState> {
    return (await this.#client.call("thread.attach", { threadId, limit: 1 })).thread;
  }

  /** The session's modes and options, as the editor shows them. */
  async #controls(state: ThreadState) {
    const info = state.info;
    const modes = state.capabilities.runtimeModes.length
      ? state.capabilities.runtimeModes
      : RUNTIME_MODES;
    const models: ModelOption[] = state.methods.includes("listModels")
      ? await this.#client
          .call("thread.call", { threadId: state.id, method: "listModels", args: [] })
          .then((listed) => listed as ModelOption[])
          .catch(() => [])
      : [];
    const model = models.find(
      (option) => option.id === info.model || option.aliases.includes(info.model ?? ""),
    );
    const efforts = model?.efforts ?? [];
    return {
      modes: {
        currentModeId: info.interactionMode === "plan" ? PLAN : info.runtimeMode,
        availableModes: [
          ...modes.map((mode) => ({ id: mode, name: mode, description: MODE_DESCRIPTIONS[mode] })),
          ...(state.capabilities.planMode
            ? [{ id: PLAN, name: "plan", description: "plan before changing anything" }]
            : []),
        ],
      },
      configOptions: [
        select(
          "harness",
          "Harness",
          "other",
          state.harness,
          this.#client.harnesses
            .filter((harness) => harness.state !== "missing")
            .map((harness) => ({ value: harness.id, name: harness.label })),
        ),
        ...(models.length > 0
          ? [
              select("model", "Model", "model", model?.id ?? "default", [
                { value: "default", name: "Default" },
                ...models.map((option) => ({
                  value: option.id,
                  name: option.label,
                  description: option.description,
                })),
              ]),
            ]
          : []),
        ...(efforts.length > 0
          ? [
              select("effort", "Effort", "thought_level", info.effort ?? "default", [
                { value: "default", name: "Default" },
                ...efforts.map((effort) => ({ value: effort, name: effort })),
              ]),
            ]
          : []),
      ],
    };
  }

  #event(event: ClientEvent): void {
    if (event.type === "thread") {
      for (const [id, session] of this.#sessions)
        if (session.threadId === event.thread.id) this.#threadChanged(id, session, event.thread);
      return;
    }
    if (event.type === "removed") {
      for (const session of this.#sessions.values())
        if (session.threadId === event.threadId)
          session.prompt?.reject(new Error("The thread was closed"));
      return;
    }
    if (event.type !== "entry") return;
    for (const [id, session] of this.#sessions) {
      if (session.threadId !== event.threadId) continue;
      session.backlog.push({ seq: event.seq, entry: event.entry });
      if (session.backlog.length > BACKLOG)
        session.backlog.splice(0, session.backlog.length - BACKLOG);
      const prompt = session.prompt;
      if (prompt && prompt.after !== null && event.seq > prompt.after)
        this.#forward(id, session, prompt, event.entry);
    }
  }

  #lastSeq(session: Session): number {
    return session.backlog.at(-1)?.seq ?? 0;
  }

  #threadChanged(id: string, session: Session, state: ThreadState): void {
    if (state.title !== session.title) {
      session.title = state.title;
      this.#update(id, { sessionUpdate: "session_info_update", title: state.title });
    }
    // Approvals go to the editor while it waits on its own turn; the terminal has the rest.
    const prompt = session.prompt;
    if (!prompt || prompt.after === null || prompt.ahead > 0) return;
    // A message that could not start its turn ends as a failed run that had no turn.
    const run = state.lastRun;
    if (
      !prompt.started &&
      run &&
      run.index > prompt.runs &&
      run.status === "failed" &&
      run.turnId === ""
    ) {
      prompt.reject(new Error(run.error ?? "The message could not start its turn"));
      return;
    }
    for (const request of state.requests) {
      if (session.asked.has(request.id)) continue;
      session.asked.add(request.id);
      void this.#ask(id, session, request);
    }
  }

  /** Puts an approval to the editor; a question waits for the 1harness terminal. */
  async #ask(id: string, session: Session, request: HarnessRequest): Promise<void> {
    if (request.kind !== "approval") {
      this.#update(id, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `\n\n(1harness waits for an answer to ${request.questions.map((question) => question.question).join("; ")} — answer it in the 1harness terminal)\n\n`,
        },
      });
      return;
    }
    try {
      const answer = await this.#peer.request<{
        outcome: { outcome: string; optionId?: string };
      }>("session/request_permission", {
        sessionId: id,
        toolCall: {
          toolCallId: request.id,
          title: request.title,
          kind:
            request.action.type === "command"
              ? "execute"
              : request.action.type === "file_change"
                ? "edit"
                : "other",
          status: "pending",
          ...(request.detail
            ? { content: [{ type: "content", content: { type: "text", text: request.detail } }] }
            : {}),
        },
        options: request.options.map((option) => ({
          optionId: option.id,
          name: option.label,
          kind: optionKind(option.effect),
        })),
      });
      const optionId = answer.outcome.outcome === "selected" ? answer.outcome.optionId : undefined;
      await this.#client.call("thread.respond", {
        threadId: session.threadId,
        requestId: request.id,
        response: optionId ? { kind: "approval", optionId } : { kind: "cancel" },
      });
    } catch {
      // The editor went away or the request was answered elsewhere; the terminal still has it.
    }
  }

  /** What the thread did after the prompt was sent, passed on once the prompt's turn starts. */
  #forward(id: string, session: Session, prompt: Prompt, entry: LogEntry): void {
    if (entry.type === "turn.ended") {
      if (prompt.ahead > 0) {
        prompt.ahead--;
        const state = this.#client.threads.get(session.threadId);
        if (prompt.ahead === 0 && state) this.#threadChanged(id, session, state);
        return;
      }
      if (entry.status === "failed") prompt.reject(new Error(entry.error ?? "The turn failed"));
      else prompt.resolve(entry.status === "interrupted" ? "cancelled" : "end_turn");
      return;
    }
    if (entry.type === "session.ended") {
      prompt.reject(new Error(entry.error ?? "The session ended"));
      return;
    }
    if (prompt.ahead > 0) return;
    if (entry.type === "turn.started") prompt.started = true;
    if (entry.type === "delta") {
      const kind = session.kinds.get(entry.itemId);
      if (kind !== "assistant_message" && kind !== "reasoning") return;
      session.streamed.set(
        entry.itemId,
        (session.streamed.get(entry.itemId) ?? 0) + entry.chunk.length,
      );
      this.#update(id, {
        sessionUpdate: kind === "assistant_message" ? "agent_message_chunk" : "agent_thought_chunk",
        content: { type: "text", text: entry.chunk },
      });
      return;
    }
    if (entry.type === "item") this.#item(id, session, entry.item, entry.done, false);
  }

  /** An item as the editor sees it; `replay` sends finished ones whole, as `session/load` does. */
  #item(id: string, session: Session, item: Item, done: boolean, replay: boolean): void {
    session.kinds.set(item.id, item.kind);
    if (item.kind === "assistant_message" || item.kind === "reasoning") {
      if (!done) return;
      const sent = session.streamed.get(item.id) ?? 0;
      const rest = item.text.slice(sent);
      session.streamed.set(item.id, item.text.length);
      if (rest)
        this.#update(id, {
          sessionUpdate:
            item.kind === "assistant_message" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { type: "text", text: rest },
        });
      return;
    }
    if (item.kind === "user_message") {
      if (replay)
        this.#update(id, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: item.text },
        });
      return;
    }
    if (item.kind === "todo_list") {
      this.#update(id, {
        sessionUpdate: "plan",
        entries: item.steps.map((step) => ({
          content: step.text,
          priority: "medium",
          status: step.status,
        })),
      });
      return;
    }
    if (item.kind === "notice") {
      if (item.level !== "info")
        this.#update(id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\n\n${item.text}\n\n` },
        });
      return;
    }
    if (!TOOL_KINDS.has(item.kind)) return;
    const output = done ? toolOutput(item) : "";
    const call = {
      toolCallId: item.id,
      title: toolTitle(item),
      kind: toolKind(item),
      status: done ? toolStatus(item) : "in_progress",
      ...(output
        ? { content: [{ type: "content", content: { type: "text", text: output } }] }
        : {}),
      ...(item.kind === "file_change"
        ? { locations: item.changes.map((change) => ({ path: change.path })) }
        : {}),
    };
    const known = session.tools.has(item.id);
    session.tools.add(item.id);
    this.#update(id, { sessionUpdate: known ? "tool_call_update" : "tool_call", ...call });
  }

  #replay(session: Session, id: string, entry: LogEntry): void {
    if (entry.type === "item" && entry.done) this.#item(id, session, entry.item, true, true);
  }

  #update(sessionId: string, update: Record<string, unknown>): void {
    this.#peer.notify("session/update", { sessionId, update });
  }
}

type Params = Record<string, unknown>;

export interface AcpOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  client: HostClient;
  defaults: Defaults;
  version: string;
}

/** Serves ACP until the editor closes stdin, then leaves the server; threads keep their state. */
export async function serveAcp(options: AcpOptions): Promise<void> {
  const peer = new JsonRpcPeer(options.input, (line) => options.output.write(line), {
    name: "ACP client",
    jsonrpc: true,
  });
  peer.onError((error) => process.stderr.write(`1harness acp: ${String(error)}\n`));
  const stop = new AcpAgent(peer, options.client, options.defaults, options.version).listen();
  await new Promise<void>((resolve) => {
    options.input.on("end", resolve);
    options.input.on("close", resolve);
  });
  stop();
  peer.closed(new Error("The editor closed the connection"));
  await options.client.close();
}
