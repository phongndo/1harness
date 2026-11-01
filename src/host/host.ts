import {
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
  type CommandThread,
  type CommandUI,
  type SessionHandle,
} from "../commands/registry.ts";
import type { HarnessId, SessionOptions, UserInput } from "../core/events.ts";
import { FileIndex, mentionedImages } from "../core/files.ts";
import { configDir, stateDir } from "../core/paths.ts";
import { errorMessage, type Thread } from "../core/thread.ts";
import { formatTokens } from "../core/wording.ts";
import { drivers, findDriver } from "../drivers/index.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { ToolServer } from "../extensions/tool-server.ts";
import {
  PROTOCOL_VERSION,
  RpcError,
  SESSION_CALLS,
  type CommandInfo,
  type HarnessInfo,
  type HostEvent,
  type Method,
  type Params,
  type Result,
  type ThreadListing,
  type ThreadState,
  type UiRequest,
} from "../protocol.ts";
import { ThreadLog } from "./log.ts";
import {
  ThreadManager,
  type ManagedThread,
  type ManagerEvent,
  type SwitchResult,
} from "./manager.ts";
import { Orchestrator } from "./orchestrator.ts";

/** How many recent events the host keeps for clients catching up after a gap. */
const RECENT_EVENTS = 20_000;
/** The most log entries one `thread.attach` returns. */
const ATTACH_LIMIT = 500;
/** How much of a run's message and reply a thread's state carries; tools read the rest. */
const RUN_TEXT = 4_000;
/** A resumed thread this large, or idle this long, costs more to pick up than it looks. */
const HEAVY_RESUME_TOKENS = 100_000;
const COLD_RESUME_MS = 60 * 60 * 1000;

type Unnumbered<E> = E extends unknown ? Omit<E, "seq"> : never;
type UiAsk =
  Unnumbered<UiRequest> extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** One client, such as a terminal, and what the host keeps for it. */
interface Client {
  id: string;
  cwd: string;
  /** The thread it shows, whose extensions' UI it gets. */
  showing: string | null;
  connected: boolean;
  /** Picks waiting for its answer. */
  picks: Map<string, (index: number | null) => void>;
  /** Picks it has not answered, sent again when it says hello. */
  pending: Map<string, UiRequest>;
  /** Lists commands keep, by thread and key. */
  lookups: Map<string, unknown[] | Promise<unknown[]>>;
  /** Message IDs by the client's request IDs, so a retried send sends nothing. */
  sent: Map<string, string>;
}

export interface HostOptions {
  version: string;
  /** The folder whose own extensions load once trusted. */
  cwd: string;
  /** Extension modules named on the command line. */
  extensions?: readonly string[];
  /** Problems with config files, shown to each client once. */
  warnings?: readonly string[];
  idleCloseMs?: number;
  configDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** A harness's name as people know it, such as `Claude Code`. */
function label(harness: HarnessId): string {
  return findDriver(harness)?.label ?? harness;
}

function idleFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * What a move to another harness did, in a sentence or two, and how loudly to
 * say it: a warning when the thread it resumed is large or long idle, since its
 * first message pays for all of that context again.
 */
export function describeSwitch(result: SwitchResult): { level: "info" | "warning"; text: string } {
  const to = label(result.to);
  const lines: string[] = [];
  if (result.resumeError)
    lines.push(
      `Could not resume ${to}'s earlier thread (${result.resumeError}); started a new one.`,
    );
  const context = result.resumedContext;
  const size = context?.tokens ? `about ${formatTokens(context.tokens)} tokens of context, ` : "";
  const where = context
    ? `its earlier thread (${size}last used ${idleFor(context.idleMs)})`
    : "a new thread";
  const turns = `${result.handedOver} ${result.handedOver === 1 ? "turn" : "turns"}`;
  lines.push(
    result.handedOver > 0
      ? `Now on ${to}, in ${where}. Your next message brings it up to date on ${context ? `the ${turns} since` : `the ${turns} before`}.`
      : `Now on ${to}, in ${where}.`,
  );
  const heavy =
    context !== null &&
    ((context.tokens ?? 0) >= HEAVY_RESUME_TOKENS || context.idleMs >= COLD_RESUME_MS);
  if (heavy)
    lines.push(
      `Its whole earlier context is sent again with that message. /harness ${result.to} fresh starts a new ${to} thread with a handoff instead.`,
    );
  return { level: heavy ? "warning" : "info", text: lines.join("\n") };
}

function clipText(text: string | null): string | null {
  return text !== null && text.length > RUN_TEXT ? `${text.slice(0, RUN_TEXT)}…` : text;
}

/**
 * A session that wakes its thread before each call, for commands, which may
 * run while the thread is parked.
 */
function sessionHandle(thread: Thread): SessionHandle {
  const handle: Record<string, unknown> = {
    setRuntimeMode: async (mode: unknown) => (await thread.wake()).setRuntimeMode(mode as never),
    setInteractionMode: async (mode: unknown) =>
      (await thread.wake()).setInteractionMode(mode as never),
  };
  for (const method of thread.methods) {
    handle[method] = async (...args: unknown[]) => {
      const session = await thread.wake();
      const call = session[method] as ((...rest: unknown[]) => Promise<unknown>) | undefined;
      if (!call) throw new Error(`${label(session.info.harness)} cannot ${method}`);
      return call.apply(session, args);
    };
  }
  return Object.defineProperties(handle, {
    capabilities: { get: () => thread.capabilities },
    info: { get: () => thread.info },
  }) as unknown as SessionHandle;
}

/**
 * Everything that outlives a client: threads and their harnesses, extensions,
 * the tools served to agents, and the orchestrator. Clients reach it through
 * `call` and the event feed, the same in-process as over the server's socket,
 * so a terminal can leave while its threads keep working.
 */
export class Host {
  readonly version: string;
  readonly manager: ThreadManager;
  readonly orchestrator: Orchestrator;
  readonly extensions: ExtensionHost;
  readonly tools: ToolServer;
  #options: HostOptions;
  #commands = new CommandRegistry();
  #orchestratorTools: ReadonlyMap<string, { tool: ToolDefinition }> = new Map();
  #listeners = new Set<(event: HostEvent) => void>();
  #recent: HostEvent[] = [];
  #seq = 0;
  #logs = new Map<string, ThreadLog>();
  /** The state each thread was last announced with. */
  #announced = new Map<string, string>();
  #commandsVersion = new Map<string, number>();
  #clients = new Map<string, Client>();
  #files = new Map<string, { index: FileIndex; ready: boolean }>();
  #uiCount = 0;
  #started: Promise<void> | null = null;
  #handlers: { [M in Method]: (client: Client, params: Params<M>) => Promise<Result<M>> };

  constructor(options: HostOptions) {
    this.#options = options;
    this.version = options.version;
    this.extensions = new ExtensionHost({
      cwd: options.cwd,
      configDir: options.configDir ?? configDir(),
      stateDir: options.stateDir ?? stateDir(),
      commands: this.#commands,
      ui: (thread) => this.#extensionUi(thread),
    });
    this.tools = new ToolServer(
      () => new Map([...this.extensions.tools, ...this.#orchestratorTools]),
      options.version,
    );
    this.manager = new ThreadManager({
      version: options.version,
      extensions: this.extensions,
      tools: this.tools,
      onWarning: (text) => this.#broadcast("warning", text),
      ...(options.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
    });
    this.orchestrator = new Orchestrator(this.manager, options.env);
    this.#orchestratorTools = new Map(this.orchestrator.tools.map((tool) => [tool.name, { tool }]));
    this.manager.subscribe((event) => this.#managerEvent(event));
    this.#handlers = this.#methods();
  }

  /** Loads extensions; calls after the first wait for it. */
  start(): Promise<void> {
    this.#started ??= this.extensions.loadAll(this.#options.extensions ?? []);
    return this.#started;
  }

  /** The newest event's number. */
  get seq(): number {
    return this.#seq;
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The events after `after`, or null when some are no longer kept. */
  since(after: number): HostEvent[] | null {
    if (after >= this.#seq) return [];
    const first = this.#recent[0];
    if (!first || first.seq > after + 1) return null;
    return this.#recent.filter((event) => event.seq > after);
  }

  /** Runs one client request. */
  async call<M extends Method>(clientId: string, method: M, params: Params<M>): Promise<Result<M>> {
    const handler = this.#handlers[method] as
      | ((client: Client, params: Params<M>) => Promise<Result<M>>)
      | undefined;
    if (!handler) throw new RpcError("unknown_method", `No method ${method}`);
    await this.start();
    return handler(this.#client(clientId), params);
  }

  /**
   * A client left: its picks resolve as dismissed, and a thread it opened that
   * has nothing in it is dropped.
   */
  async disconnect(clientId: string): Promise<void> {
    const client = this.#clients.get(clientId);
    if (!client) return;
    client.connected = false;
    for (const resolve of client.picks.values()) resolve(null);
    client.picks.clear();
    client.pending.clear();
    const showing = client.showing;
    client.showing = null;
    if (showing) await this.#discardIfEmpty(showing, client);
  }

  /** How many clients are connected. */
  get clients(): number {
    return [...this.#clients.values()].filter((client) => client.connected).length;
  }

  /** Ends every thread and stops what the host started. */
  async shutdown(): Promise<void> {
    for (const client of this.#clients.values()) await this.disconnect(client.id);
    await this.manager.closeAll();
    for (const { index } of this.#files.values()) index.close();
    this.#files.clear();
    await this.tools.close();
    await this.extensions.close();
  }

  // The feed

  #emit(event: Unnumbered<HostEvent>): void {
    const numbered = { ...event, seq: ++this.#seq } as HostEvent;
    this.#recent.push(numbered);
    if (this.#recent.length > RECENT_EVENTS)
      this.#recent.splice(0, this.#recent.length - RECENT_EVENTS);
    for (const listener of this.#listeners) listener(numbered);
  }

  #log(id: string): ThreadLog {
    let log = this.#logs.get(id);
    if (!log) {
      log = new ThreadLog();
      this.#logs.set(id, log);
    }
    return log;
  }

  #managerEvent(event: ManagerEvent): void {
    switch (event.type) {
      case "thread.created": {
        const thread = event.thread;
        this.#log(thread.id);
        this.#announce(thread);
        if (thread.parentId && this.#logs.has(thread.parentId)) {
          const entry = this.#log(thread.parentId).agent(this.#seq + 1, thread.id);
          this.#emit({ type: "entry", threadId: thread.parentId, entry });
        }
        return;
      }
      case "thread.updated":
        this.#announce(event.thread);
        return;
      case "thread.event": {
        const managed = this.manager.get(event.threadId);
        if (!managed) return;
        const change = event.event;
        if (change.type === "commands.updated" || change.type === "session.replaced")
          this.#commandsVersion.set(managed.id, (this.#commandsVersion.get(managed.id) ?? 0) + 1);
        const entry = this.#log(managed.id).apply(change, this.#seq + 1, (id) =>
          managed.thread.message(id),
        );
        if (entry) this.#emit({ type: "entry", threadId: managed.id, entry });
        // Streamed text changes nothing a thread's state shows.
        if (change.type !== "item.delta") this.#announce(managed);
        return;
      }
      case "thread.moved": {
        const { thread, result, waking } = event;
        // A switch says how it went itself; waking says so only when it could not resume.
        if (waking && result.resumeError)
          this.#notice(
            thread.id,
            "warning",
            `Could not resume ${label(result.to)}'s own thread (${result.resumeError}); started a new one${result.handedOver > 0 ? `, which your message brings up to date on ${result.handedOver} ${result.handedOver === 1 ? "turn" : "turns"}` : ""}.`,
          );
        return;
      }
      case "thread.parked":
        this.#notice(
          event.thread.id,
          "info",
          `Closed ${label(event.thread.harness)} after it sat idle; your next message resumes it.`,
        );
        return;
      case "thread.forgotten":
        this.#logs.delete(event.threadId);
        this.#announced.delete(event.threadId);
        this.#commandsVersion.delete(event.threadId);
        this.#emit({ type: "removed", threadId: event.threadId });
        return;
    }
  }

  /** Sends a thread's state when it changed since it was last sent. */
  #announce(managed: ManagedThread): void {
    if (!this.manager.get(managed.id)) return;
    const state = this.#state(managed);
    const key = JSON.stringify(state);
    if (this.#announced.get(managed.id) === key) return;
    this.#announced.set(managed.id, key);
    this.#emit({ type: "thread", thread: state });
  }

  #state(managed: ManagedThread): ThreadState {
    const thread = managed.thread;
    const last = managed.runs.at(-1);
    return {
      id: managed.id,
      title: managed.title,
      harness: managed.harness,
      parentId: managed.parentId,
      parentCallId: managed.parentCallId,
      origin: managed.origin,
      createdAt: managed.createdAt,
      updatedAt: last?.endedAt ?? last?.startedAt ?? managed.createdAt,
      status: managed.status,
      error: managed.error,
      info: { ...thread.info },
      capabilities: thread.capabilities,
      methods: [...thread.methods],
      busy: thread.busy,
      queue: [...thread.queue],
      held: false,
      requests: [...thread.requests],
      usage: thread.usage,
      runCount: managed.runs.length,
      lastRun: last
        ? { ...last, input: clipText(last.input) ?? "", result: clipText(last.result) }
        : null,
      background: thread.session?.backgroundTasks?.() ?? [],
      commandsVersion: this.#commandsVersion.get(managed.id) ?? 0,
      openedBy: managed.openedBy,
      pinned: false,
      archived: false,
    };
  }

  /**
   * Adds a line of the host's own to a thread's transcript, or changes the one
   * with `id`; returns its ID.
   */
  #notice(
    threadId: string,
    level: "info" | "warning" | "error",
    text: string,
    id?: string,
  ): string {
    const log = this.#logs.get(threadId);
    const noticeId = id ?? `notice-${this.#seq + 1}`;
    if (!log) return noticeId;
    const entry = log.item(this.#seq + 1, { kind: "notice", id: noticeId, level, text }, true);
    this.#emit({ type: "entry", threadId, entry });
    return noticeId;
  }

  /** Something every client shows, such as an extension that failed. */
  #broadcast(level: "info" | "warning" | "error", text: string): void {
    this.#emit({ type: "notice", level, text });
  }

  // Clients and their UI

  #client(id: string): Client {
    let client = this.#clients.get(id);
    if (!client) {
      client = {
        id,
        cwd: this.#options.cwd,
        showing: null,
        connected: true,
        picks: new Map(),
        pending: new Map(),
        lookups: new Map(),
        sent: new Map(),
      };
      this.#clients.set(id, client);
    }
    return client;
  }

  /** Sends a client something to show or ask; returns the request's ID. */
  #ask(client: Client, ask: UiAsk): string {
    const request = { ...ask, id: `ui-${++this.#uiCount}` } as UiRequest;
    if (request.method === "pick") client.pending.set(request.id, request);
    this.#emit({ type: "ui", clientId: client.id, request });
    return request.id;
  }

  #clientUi(client: Client): CommandUI {
    return {
      notify: (level, text) => void this.#ask(client, { method: "notify", level, text }),
      report: (report) => void this.#ask(client, { method: "report", report }),
      panel: (title, rows) => void this.#ask(client, { method: "panel", title, rows }),
      pick: (title, entries, options) =>
        new Promise((resolve) => {
          if (!client.connected) {
            resolve(null);
            return;
          }
          const id = this.#ask(client, {
            method: "pick",
            title,
            entries,
            initial: options?.initial ?? 0,
            filter: options?.filter ?? false,
          });
          client.picks.set(id, resolve);
        }),
      progress: (text) => {
        const id = this.#ask(client, { method: "progress", text });
        return (level, outcome) =>
          void this.#ask(client, { method: "settle", progress: id, level, text: outcome });
      },
      setInput: (text) => void this.#ask(client, { method: "setInput", text }),
    };
  }

  /**
   * The UI extensions' handlers get for a thread: the client showing it, or
   * none. Without a thread, notices go to every client.
   */
  #extensionUi(thread: Thread | null): CommandUI | null {
    if (thread) {
      const managed = this.manager.byThread(thread);
      const client = [...this.#clients.values()].find(
        (candidate) => candidate.connected && candidate.showing === managed?.id,
      );
      return client ? this.#clientUi(client) : null;
    }
    return {
      notify: (level, text) => this.#broadcast(level, text),
      report: (report) => this.#broadcast("info", report.title),
      panel: (title) => this.#broadcast("info", title),
      pick: async () => null,
      progress: (text) => {
        this.#broadcast("info", text);
        return (level, outcome) => this.#broadcast(level, outcome);
      },
      setInput: () => {},
    };
  }

  // Commands

  #harnesses(): HarnessInfo[] {
    const env = this.#options.env ?? process.env;
    return drivers().map((driver) => ({
      id: driver.id,
      label: driver.label,
      unavailable: driver.unavailable(env),
    }));
  }

  #commandThread(managed: ManagedThread, client: Client): CommandThread {
    return {
      id: managed.id,
      get closed() {
        return managed.status === "closed";
      },
      get busy() {
        return managed.thread.busy;
      },
      get parked() {
        return managed.thread.parked;
      },
      send: async (text) => {
        await this.call(client.id, "thread.send", { threadId: managed.id, text });
      },
      unqueue: async () => managed.thread.unqueue(),
    };
  }

  /** The context a host command runs with: the client that ran it, and its thread. */
  #commandContext(client: Client, threadId: string | null): CommandContext {
    const managed = threadId ? this.manager.get(threadId) : undefined;
    const prefix = `${threadId ?? ""}\0`;
    const fetch = <T>(key: string, load: () => Promise<T[]>): Promise<T[]> => {
      const cached = client.lookups.get(prefix + key);
      if (cached !== undefined) return Promise.resolve(cached as T[] | Promise<T[]>);
      const loading = load().then(
        (items) => {
          if (client.lookups.get(prefix + key) === loading) client.lookups.set(prefix + key, items);
          return items;
        },
        (error: unknown) => {
          if (client.lookups.get(prefix + key) === loading) client.lookups.delete(prefix + key);
          throw error;
        },
      );
      client.lookups.set(prefix + key, loading);
      return loading;
    };
    const settings = (): SessionOptions => {
      const info = managed?.thread.info;
      return {
        cwd: info?.cwd ?? client.cwd,
        model: info?.model ?? null,
        effort: info?.effort ?? null,
        runtimeMode: info?.runtimeMode ?? "supervised",
        interactionMode: info?.interactionMode ?? "default",
        resume: null,
      };
    };
    return {
      ui: this.#clientUi(client),
      harness: managed?.harness ?? "claude",
      thread: managed ? this.#commandThread(managed, client) : null,
      info: managed?.thread.info ?? null,
      session: () => {
        if (!managed || managed.status === "closed")
          throw new Error("No session is running. Use /new to start one.");
        return sessionHandle(managed.thread);
      },
      harnesses: () => this.#harnesses(),
      lookup: <T>(key: string, load: () => Promise<T[]>): T[] => {
        const cached = client.lookups.get(prefix + key);
        if (Array.isArray(cached)) return cached as T[];
        if (cached === undefined) void fetch(key, load).catch(() => {});
        return [];
      },
      fetch,
      forget: (key) => {
        client.lookups.delete(prefix + key);
      },
      openThread: async (options = {}) => {
        const harness = options.harness ?? managed?.harness ?? "claude";
        const base = settings();
        const state = options.resume
          ? await this.call(client.id, "thread.resume", {
              id: options.resume,
              harness,
              settings: base,
            })
          : await this.call(client.id, "thread.open", {
              harness,
              settings: options.defaultModel ? { ...base, model: null, effort: null } : base,
            });
        this.#ask(client, { method: "show", threadId: state.id });
      },
      switchHarness: async (harness, options) => {
        if (!managed) throw new Error("No thread to move");
        await this.#switch(managed, harness, options?.fresh === true);
      },
      exit: async () => {
        this.#ask(client, { method: "exit" });
      },
    };
  }

  #commandInfo(command: CommandDefinition, context: CommandContext): CommandInfo {
    let available = true;
    try {
      available = command.available?.(context) ?? true;
    } catch {
      available = false;
    }
    return {
      name: command.name,
      aliases: [...(command.aliases ?? [])],
      usage: command.usage ?? null,
      description: command.description,
      group: command.group,
      available,
      completes: command.complete !== undefined,
    };
  }

  #commandList(client: Client, threadId: string | null): CommandInfo[] {
    const context = this.#commandContext(client, threadId);
    return this.#commands.list().map((command) => this.#commandInfo(command, context));
  }

  // Threads

  #managed(threadId: string): ManagedThread {
    const managed = this.manager.get(threadId);
    if (!managed) throw new RpcError("thread_not_found", `No thread ${threadId}`);
    return managed;
  }

  #open(threadId: string): ManagedThread {
    const managed = this.#managed(threadId);
    if (managed.status === "closed") throw new RpcError("thread_closed", `${threadId} is closed`);
    return managed;
  }

  /** Moves a thread to another harness, saying in its transcript how that went. */
  async #switch(managed: ManagedThread, harness: HarnessId, fresh: boolean): Promise<SwitchResult> {
    const id = this.#notice(
      managed.id,
      "info",
      harness === managed.harness
        ? `Starting ${label(harness)} over…`
        : `Moving ${managed.id} to ${label(harness)}…`,
    );
    try {
      const result = await this.manager.switchHarness(managed.id, harness, { fresh });
      const { level, text } = describeSwitch(result);
      this.#notice(managed.id, level, text, id);
      return result;
    } catch (error) {
      this.#notice(
        managed.id,
        "error",
        `Could not move to ${label(harness)}: ${errorMessage(error)}`,
        id,
      );
      throw error;
    }
  }

  /** Closes and drops a thread a client opened and left with nothing in it. */
  async #discardIfEmpty(threadId: string, client: Client): Promise<void> {
    const managed = this.manager.get(threadId);
    if (!managed || managed.status === "closed" || managed.openedBy !== client.id) return;
    const thread = managed.thread;
    const empty =
      managed.origin === "user" &&
      managed.runs.length === 0 &&
      thread.queue.length === 0 &&
      thread.idle &&
      this.manager.descendants(threadId).length === 0;
    const shown = [...this.#clients.values()].some(
      (other) => other !== client && other.connected && other.showing === threadId,
    );
    if (!empty || shown) return;
    await this.manager.close(threadId);
    this.manager.forget(threadId);
  }

  #listing(managed: ManagedThread): ThreadListing {
    const last = managed.runs.at(-1);
    return {
      id: managed.id,
      title: managed.title,
      harness: managed.harness,
      cwd: managed.thread.info.cwd,
      status: managed.status,
      parentId: managed.parentId,
      runCount: managed.runs.length,
      createdAt: managed.createdAt,
      updatedAt: last?.endedAt ?? last?.startedAt ?? managed.createdAt,
      pinned: false,
      archived: false,
      unseen: false,
      native: managed.thread.info.threadId,
    };
  }

  #methods(): { [M in Method]: (client: Client, params: Params<M>) => Promise<Result<M>> } {
    return {
      "client.hello": async (client, params) => {
        client.cwd = params.cwd;
        client.connected = true;
        const warnings = [...(this.#options.warnings ?? [])];
        const waiting = this.extensions.untrusted.length;
        if (waiting > 0)
          warnings.push(
            `This folder has ${waiting} ${waiting === 1 ? "extension" : "extensions"} of its own; /extensions trust loads them.`,
          );
        return {
          version: this.version,
          protocol: PROTOCOL_VERSION,
          seq: this.#seq,
          threads: this.manager.list().map((managed) => this.#state(managed)),
          harnesses: this.#harnesses(),
          commands: this.#commandList(client, null),
          pending: [...client.pending.values()],
          warnings,
          store: null,
        };
      },
      "client.show": async (client, { threadId }) => {
        const previous = client.showing;
        client.showing = threadId;
        if (previous && previous !== threadId) await this.#discardIfEmpty(previous, client);
        return null;
      },
      "threads.list": async (_client, { scope, query, limit }) => {
        const all = this.manager.list().filter((managed) => {
          if (scope === "archived") return false;
          if (scope === "open") return managed.status !== "closed";
          return true;
        });
        const needle = query?.toLowerCase();
        return all
          .filter((managed) => !needle || managed.title.toLowerCase().includes(needle))
          .map((managed) => this.#listing(managed))
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit ?? 200);
      },
      "thread.open": async (client, { harness, settings, title }) => {
        let created: ManagedThread | null = null;
        const unsubscribe = this.manager.subscribe((event) => {
          if (event.type === "thread.created" && event.thread.openedBy === client.id)
            created ??= event.thread;
        });
        try {
          const managed = await this.manager.create({
            harness,
            settings,
            ...(title ? { title } : {}),
            origin: "user",
            openedBy: client.id,
          });
          return this.#state(managed);
        } catch (error) {
          // One that could not start leaves nothing to show.
          const failed = created as ManagedThread | null;
          if (failed) this.manager.forget(failed.id);
          throw error;
        } finally {
          unsubscribe();
        }
      },
      "thread.resume": async (client, { id, harness, settings }) => {
        const own = this.manager.get(id);
        if (own) {
          if (own.status === "closed") throw new RpcError("thread_closed", `${id} is closed`);
          return this.#state(own);
        }
        // A native thread a 1harness thread already runs opens that thread.
        const running = this.manager
          .list()
          .find((managed) => managed.status !== "closed" && managed.thread.info.threadId === id);
        if (running) return this.#state(running);
        return this.#handlers["thread.open"](client, {
          harness,
          settings: { ...settings, resume: id },
        });
      },
      "thread.attach": async (_client, { threadId, before, limit }) => {
        const managed = this.#managed(threadId);
        const page = this.#log(threadId).page(
          before,
          Math.min(limit ?? ATTACH_LIMIT, ATTACH_LIMIT),
        );
        return {
          thread: this.#state(managed),
          entries: page.entries,
          more: page.more,
          cursor: this.#seq,
          children: this.manager
            .list()
            .filter((other) => other.parentId === threadId)
            .map((other) => this.#state(other)),
        };
      },
      "thread.send": async (client, { threadId, text, steer, command, requestId }) => {
        if (requestId) {
          const sent = client.sent.get(requestId);
          if (sent) return { messageId: sent };
        }
        const managed = this.#open(threadId);
        const thread = managed.thread;
        const input: UserInput = { text };
        if (thread.capabilities.images && !command) {
          const images = mentionedImages(text, thread.info.cwd);
          if (images.length > 0) input.images = images;
        }
        const message = command
          ? thread.send(input, undefined, { command: true })
          : steer
            ? await thread.steer(input)
            : thread.send(input);
        if (requestId) {
          client.sent.set(requestId, message.id);
          // Only recent retries matter.
          if (client.sent.size > 200) client.sent.delete(client.sent.keys().next().value!);
        }
        return { messageId: message.id };
      },
      "thread.respond": async (_client, { threadId, requestId, response }) => {
        await this.#open(threadId).thread.respond(requestId, response);
        return null;
      },
      "thread.stop": async (_client, { threadId }) => {
        await this.orchestrator.stop(this.#managed(threadId).id);
        return null;
      },
      "thread.close": async (_client, { threadId }) => {
        await this.manager.close(this.#managed(threadId).id);
        return null;
      },
      "thread.unqueue": async (_client, { threadId }) =>
        this.#open(threadId).thread.unqueue() ?? null,
      "thread.switchHarness": async (_client, { threadId, harness, fresh }) =>
        this.#switch(this.#open(threadId), harness, fresh === true),
      "thread.call": async (_client, { threadId, method, args }) => {
        if (!SESSION_CALLS.includes(method))
          throw new RpcError("invalid_request", `thread.call cannot run ${method}`);
        const session = await this.#open(threadId).thread.wake();
        const call = session[method] as ((...rest: unknown[]) => Promise<unknown>) | undefined;
        if (!call)
          throw new RpcError("unsupported", `${label(session.info.harness)} cannot ${method}`);
        return (await call.apply(session, args)) ?? null;
      },
      "thread.command": async (_client, { threadId, command, args }) => {
        await this.#open(threadId).thread.command(command, args);
        return null;
      },
      "harnesses.list": async () => this.#harnesses(),
      "commands.list": async (client, { threadId }) => this.#commandList(client, threadId),
      "commands.run": async (client, { threadId, name, args }) => {
        const command = this.#commands.find(name);
        if (!command) throw new RpcError("command_not_found", `No command /${name}`);
        const context = this.#commandContext(client, threadId);
        if (!this.#commandInfo(command, context).available)
          throw new RpcError("unavailable", `/${command.name} is not available here`);
        await command.run(context, args);
        return null;
      },
      "commands.complete": async (client, { threadId, name, args }) => {
        const command = this.#commands.find(name);
        return command?.complete?.(this.#commandContext(client, threadId), args) ?? null;
      },
      "files.search": async (_client, { cwd, query, limit }) => {
        let files = this.#files.get(cwd);
        if (!files) {
          const entry = { index: new FileIndex(cwd), ready: false };
          files = entry;
          this.#files.set(cwd, entry);
          entry.index.load().then(
            () => {
              entry.ready = true;
            },
            () => {
              entry.ready = true;
            },
          );
        }
        return { matches: files.index.search(query, limit), loading: !files.ready };
      },
      "ui.reply": async (client, { id, result }) => {
        const resolve = client.picks.get(id);
        client.picks.delete(id);
        client.pending.delete(id);
        resolve?.(result);
        this.#emit({ type: "ui.done", clientId: client.id, id });
        return null;
      },
    };
  }
}
