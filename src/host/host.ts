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
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { configDir, stateDir } from "../core/paths.ts";
import { errorMessage, type Thread, type ThreadEvent } from "../core/thread.ts";
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
import type { Store, ThreadRow, ThreadSummaryRow } from "../store/store.ts";
import { handoffText } from "./handoff.ts";
import { ThreadLog } from "./log.ts";
import {
  ThreadManager,
  type ManagedThread,
  type ManagerEvent,
  type RestoredThread,
  type RunRecord,
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
  /** Extension modules it named, which load for the threads it opens. */
  extensions: string[];
}

/** One folder's extensions, with a set of named modules, and the commands they register. */
interface ExtensionSet {
  key: string;
  host: ExtensionHost;
  commands: CommandRegistry;
  ready: Promise<void>;
}

export interface HostOptions {
  version: string;
  /** The folder a client starts in when it says no other, as `--print` does. */
  cwd: string;
  /** Extension modules for clients that name none, as `--print` passes them. */
  extensions?: readonly string[];
  /** Problems with config files, shown to each client once. */
  warnings?: readonly string[];
  idleCloseMs?: number;
  configDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Where threads are kept across restarts. The host brings back the ones not
   * closed, parked, and owns the store from then on; without one, threads end
   * with the host.
   */
  store?: Store | null;
  /** Closed threads last used longer ago than this are deleted when the host starts; pinned ones stay. */
  retainClosedDays?: number | null;
}

/** A folder a client named, with `~` as the home of the user the host runs as. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? joinPath(homedir(), path.slice(2)) : path;
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

  readonly tools: ToolServer;
  #options: HostOptions;
  /** Extensions by folder and the modules a client named, each set with its commands. */
  #sets = new Map<string, ExtensionSet>();
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
  #store: Store | null;
  /** Threads whose rows changed since the store was last written. */
  #dirty = new Set<string>();
  #flushTimer: NodeJS.Immediate | null = null;
  /** Pinned and archived, by thread, as the store keeps them. */
  #flags = new Map<string, { pinned: boolean; archived: boolean }>();
  /** How many of each thread's runs a client has shown. */
  #seenRuns = new Map<string, number>();
  /** Threads being dropped for good, which the store deletes too. */
  #discarding = new Set<string>();
  #stopped = false;
  /** Writing the store failed, which is reported once. */
  #storeFailed = false;
  #handlers: { [M in Method]: (client: Client, params: Params<M>) => Promise<Result<M>> };

  constructor(options: HostOptions) {
    this.#options = options;
    this.version = options.version;
    this.#store = options.store ?? null;
    const store = this.#store;
    if (store) this.#seq = store.maxSeq();
    // Every session gets the orchestrator's tools; its folder's extensions add theirs.
    this.tools = new ToolServer(() => this.#orchestratorTools, options.version);
    this.manager = new ThreadManager({
      version: options.version,
      extensions: (cwd, client) => this.#extensionsFor(cwd, client),
      tools: this.tools,
      onWarning: (text) => this.#broadcast("warning", text),
      ...(options.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
      ...(store ? { nextId: () => store.nextThreadId() } : {}),
    });
    this.orchestrator = new Orchestrator(this.manager, options.env);
    this.#orchestratorTools = new Map(this.orchestrator.tools.map((tool) => [tool.name, { tool }]));
    this.manager.subscribe((event) => this.#managerEvent(event));
    this.#handlers = this.#methods();
  }

  /** Brings back stored threads, with their folders' extensions; calls after the first wait for it. */
  start(): Promise<void> {
    this.#started ??= this.#restore();
    return this.#started;
  }

  /**
   * The extensions for a folder and the modules a client named: the user's,
   * the folder's own once trusted, and those modules. Loaded once per folder,
   * by its real path, and set of modules.
   */
  #set(cwd: string, modules: readonly string[]): ExtensionSet {
    let folder = resolvePath(cwd);
    try {
      folder = realpathSync(folder);
    } catch {
      // A folder that is gone still names its set.
    }
    const flags = modules.map((path) => resolvePath(cwd, path)).toSorted();
    const key = [folder, ...flags].join("\0");
    let set = this.#sets.get(key);
    if (!set) {
      const commands = new CommandRegistry();
      const host = new ExtensionHost({
        cwd: folder,
        configDir: this.#options.configDir ?? configDir(),
        stateDir: this.#options.stateDir ?? stateDir(),
        commands,
        ui: (thread) => this.#extensionUi(thread),
      });
      set = { key, host, commands, ready: host.loadAll(flags) };
      this.#sets.set(key, set);
    }
    return set;
  }

  /** The modules a client named with `-x`, which load only for the threads it opens. */
  #modules(clientId: string | null): readonly string[] {
    const client = clientId ? this.#clients.get(clientId) : undefined;
    return client?.extensions ?? (clientId === null ? [] : (this.#options.extensions ?? []));
  }

  async #extensionsFor(cwd: string, clientId: string | null): Promise<ExtensionHost> {
    const set = this.#set(cwd, this.#modules(clientId));
    await set.ready;
    return set.host;
  }

  /** The set whose commands a client sees: the thread's when it has one, else its folder's. */
  async #commandSet(client: Client, threadId: string | null): Promise<ExtensionSet> {
    const thread = threadId ? this.manager.extensionsOf(threadId) : undefined;
    const set = thread
      ? [...this.#sets.values()].find((candidate) => candidate.host === thread)
      : undefined;
    const chosen = set ?? this.#set(client.cwd, client.extensions);
    await chosen.ready;
    return chosen;
  }

  /** Where the store is, or null when the host keeps nothing. */
  get storePath(): string | null {
    return this.#store ? (this.#store.path ?? ":memory:") : null;
  }

  /**
   * Brings back every thread that was not closed, parked, with nothing
   * started: a run that was going is marked interrupted, and a queue waits
   * for the user.
   */
  async #restore(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    const days = this.#options.retainClosedDays;
    if (days)
      for (const id of store.closedBefore(Date.now() - days * 86_400_000)) store.deleteThread(id);
    const rows = store.liveThreads();
    const interrupted = new Set<string>();
    const saved: RestoredThread[] = [];
    for (const row of rows) {
      const runs = store.runs(row.id);
      if (runs.some((run) => run.status === "running")) interrupted.add(row.id);
      saved.push({
        ...this.#restored(row, runs),
        extensions: await this.#extensionsFor(row.cwd, null),
      });
    }
    for (const managed of this.manager.restore(saved)) {
      if (interrupted.has(managed.id)) {
        const run = managed.runs.at(-1);
        if (run) store.saveRun(managed.id, run);
        // Its transcript ends the turn and the session, as a client showing it saw neither.
        const log = this.#log(managed.id);
        for (const event of [
          {
            type: "turn.ended" as const,
            turnId: run?.turnId ?? "",
            status: "interrupted" as const,
            error: null,
          },
          { type: "session.closed" as const, error: null },
        ]) {
          const entry = log.apply(event, this.#seq + 1, () => undefined);
          if (entry) this.#emit({ type: "entry", threadId: managed.id, entry });
        }
        this.#notice(
          managed.id,
          "warning",
          `1harness stopped while turn ${run?.index ?? ""} ran, so it may not have finished. Nothing was sent again.`,
        );
      }
      const held = managed.thread.queue.length;
      if (managed.thread.held)
        this.#notice(
          managed.id,
          "info",
          `${held} queued ${held === 1 ? "message was" : "messages were"} waiting when 1harness stopped. They run in order once you send this thread a message; /unqueue takes the last one back.`,
        );
      this.#dirty.add(managed.id);
    }
    this.orchestrator.restoreTasks(store.tasks());
    this.#scheduleFlush();
  }

  #restored(row: ThreadRow, runs: RunRecord[]): RestoredThread {
    const store = this.#store!;
    this.#flags.set(row.id, { pinned: row.pinned, archived: row.archived });
    this.#seenRuns.set(row.id, row.seenRuns);
    return {
      id: row.id,
      title: row.title,
      harness: row.harness,
      parentId: row.parentId,
      parentCallId: row.parentCallId,
      origin: row.origin,
      forkedFrom: row.forkedFrom,
      createdAt: row.createdAt,
      error: row.error,
      runs,
      visits: store.visits(row.id),
      seenWithoutHandoff: row.seenWithoutHandoff,
      thread: {
        info: row.info,
        capabilities: row.capabilities,
        methods: row.methods,
        handoff: row.handoff,
        generation: row.generation,
        allowances: store.allowances(row.id),
        queue: store.queuedMessages(row.id).map(({ message, sent }) => ({ message, input: sent })),
      },
    };
  }

  /** Brings a stored thread back into memory, parked, such as a closed one reopened. */
  async #reopen(id: string): Promise<ManagedThread | null> {
    const store = this.#store;
    const row = store?.thread(id);
    if (!store || !row) return null;
    const existing = this.manager.get(id);
    if (existing) {
      if (existing.status !== "closed") return existing;
      this.#flush();
      this.manager.forget(id);
    }
    const [managed] = this.manager.restore([
      {
        ...this.#restored({ ...row, state: "parked" }, store.runs(id)),
        extensions: await this.#extensionsFor(row.cwd, null),
      },
    ]);
    if (!managed) return null;
    this.#dirty.add(id);
    this.#scheduleFlush();
    return managed;
  }

  /** The newest event's number. */
  get seq(): number {
    return this.#seq;
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The events after `after`, or null when some are no longer kept, or the
   * client has events this host never sent, as after a crash lost the last
   * ones: it starts over from a snapshot.
   */
  since(after: number): HostEvent[] | null {
    if (after === this.#seq) return [];
    if (after > this.#seq) return null;
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
    if (showing) {
      // What it showed up to the end was seen.
      this.#markSeen(showing);
      await this.#discardIfEmpty(showing, client);
    }
  }

  /** How many clients are connected. */
  get clients(): number {
    return [...this.#clients.values()].filter((client) => client.connected).length;
  }

  /**
   * Whether any thread has work going, which stopping would cut off: a turn,
   * a request, a session starting, a queue that is not held, or background
   * work its harness runs.
   */
  get busy(): boolean {
    return this.manager.list().some((managed) => {
      if (managed.status === "closed" || managed.status === "parked") return false;
      const thread = managed.thread;
      return (
        managed.status === "starting" ||
        !thread.idle ||
        (thread.session?.backgroundTasks?.() ?? []).length > 0
      );
    });
  }

  /**
   * Stops what the host started. With a store, every thread parks to be
   * brought back next time, and a running turn is interrupted; without one,
   * threads end.
   */
  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    for (const client of this.#clients.values()) await this.disconnect(client.id);
    if (this.#store) await this.manager.parkAll();
    else await this.manager.closeAll();
    this.#stopped = true;
    for (const { index } of this.#files.values()) index.close();
    this.#files.clear();
    await this.tools.close();
    for (const set of this.#sets.values()) await set.host.close();
    if (this.#store) {
      this.#flush();
      this.#store.close();
    }
  }

  // The store

  #scheduleFlush(): void {
    if (!this.#store || this.#flushTimer || this.#stopped) return;
    this.#flushTimer = setImmediate(() => {
      this.#flushTimer = null;
      this.#flush();
    });
  }

  /** Writes what changed: thread rows, their newest runs, and new or changed log entries. */
  #flush(): void {
    const store = this.#store;
    if (!store) return;
    if (this.#flushTimer) clearImmediate(this.#flushTimer);
    this.#flushTimer = null;
    try {
      this.#write(store);
    } catch (error) {
      // The threads go on; what they did since may not survive a restart.
      if (!this.#storeFailed)
        this.#broadcast("error", `Could not save threads: ${errorMessage(error)}`);
      this.#storeFailed = true;
    }
  }

  #write(store: Store): void {
    store.transaction(() => {
      for (const id of this.#dirty) {
        const managed = this.manager.get(id);
        if (!managed) continue;
        store.saveThread(this.#row(managed));
        // Runs change only at the end.
        for (const run of managed.runs.slice(-2)) store.saveRun(id, run);
        for (const [harness, visit] of this.manager.visits(id)) store.saveVisit(id, harness, visit);
        store.saveAllowances(id, managed.thread.allowances);
      }
      this.#dirty.clear();
      for (const [id, log] of this.#logs) {
        const changed = log.flush();
        if (changed.length > 0 && (this.manager.get(id) || store.thread(id)))
          store.writeLog(id, changed);
      }
      for (const task of this.orchestrator.taskRows()) store.saveTask(task);
      store.saveSeq(this.#seq);
    });
  }

  #row(managed: ManagedThread): ThreadRow {
    const thread = managed.thread;
    const last = managed.runs.at(-1);
    const flags = this.#flags.get(managed.id) ?? { pinned: false, archived: false };
    return {
      id: managed.id,
      title: managed.title,
      cwd: thread.info.cwd,
      harness: managed.harness,
      parentId: managed.parentId,
      parentCallId: managed.parentCallId,
      origin: managed.origin,
      forkedFrom: managed.forkedFrom,
      state: managed.status === "closed" ? "closed" : thread.session ? "open" : "parked",
      info: { ...thread.info },
      capabilities: thread.capabilities,
      methods: [...thread.methods],
      handoff: thread.handoff,
      seenWithoutHandoff: this.manager.seenWithoutHandoff(managed.id),
      generation: thread.generation,
      error: managed.error,
      pinned: flags.pinned,
      archived: flags.archived,
      seenRuns: this.#seenRuns.get(managed.id) ?? 0,
      createdAt: managed.createdAt,
      updatedAt: last?.endedAt ?? last?.startedAt ?? managed.createdAt,
    };
  }

  /** Admission is written at once, before the harness is sent anything. */
  #admit(managed: ManagedThread, change: ManagerEvent & { type: "thread.event" }): void {
    const store = this.#store;
    if (!store || this.#storeFailed) return;
    try {
      this.#record(store, managed, change.event);
    } catch (error) {
      this.#broadcast("error", `Could not save threads: ${errorMessage(error)}`);
      this.#storeFailed = true;
    }
  }

  #record(store: Store, managed: ManagedThread, event: ThreadEvent): void {
    if (event.type === "message.recorded") {
      // A thread's row exists before its first message does.
      store.saveThread(this.#row(managed));
      store.recordMessage(managed.id, event.message, event.input, "queued");
    } else if (event.type === "message.dispatched")
      store.setMessageState(event.messageId, "dispatched");
    else if (event.type === "message.dropped") store.setMessageState(event.messageId, "dropped");
  }

  // The feed

  #emit(event: Unnumbered<HostEvent>): void {
    const numbered = { ...event, seq: ++this.#seq } as HostEvent;
    this.#recent.push(numbered);
    if (this.#recent.length > RECENT_EVENTS)
      this.#recent.splice(0, this.#recent.length - RECENT_EVENTS);
    for (const listener of this.#listeners) listener(numbered);
  }

  /** A thread's log, read from the store the first time it is needed. */
  #log(id: string): ThreadLog {
    let log = this.#logs.get(id);
    if (!log) {
      log = new ThreadLog(this.#store?.log(id) ?? []);
      this.#logs.set(id, log);
    }
    return log;
  }

  #managerEvent(event: ManagerEvent): void {
    switch (event.type) {
      case "thread.created": {
        const thread = event.thread;
        this.#announce(thread);
        if (event.restored) return;
        this.#store?.saveThread(this.#row(thread));
        if (thread.parentId && this.manager.get(thread.parentId)) {
          const entry = this.#log(thread.parentId).agent(this.#seq + 1, thread.id);
          this.#emit({ type: "entry", threadId: thread.parentId, entry });
          this.#scheduleFlush();
        }
        return;
      }
      case "thread.updated":
        this.#announce(event.thread);
        this.#dirty.add(event.thread.id);
        this.#scheduleFlush();
        return;
      case "thread.event": {
        const managed = this.manager.get(event.threadId);
        if (!managed) return;
        const change = event.event;
        this.#admit(managed, event);
        if (change.type !== "item.delta") this.#dirty.add(managed.id);
        this.#scheduleFlush();
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
        this.#dirty.delete(event.threadId);
        if (this.#discarding.delete(event.threadId)) this.#store?.deleteThread(event.threadId);
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
      held: thread.held,
      requests: [...thread.requests],
      usage: thread.usage,
      runCount: managed.runs.length,
      lastRun: last
        ? { ...last, input: clipText(last.input) ?? "", result: clipText(last.result) }
        : null,
      background: thread.session?.backgroundTasks?.() ?? [],
      commandsVersion: this.#commandsVersion.get(managed.id) ?? 0,
      openedBy: managed.openedBy,
      seenRuns: this.#seenRuns.get(managed.id) ?? 0,
      pinned: this.#flags.get(managed.id)?.pinned ?? false,
      archived: this.#flags.get(managed.id)?.archived ?? false,
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
    const noticeId = id ?? `notice-${this.#seq + 1}`;
    if (!this.manager.get(threadId)) return noticeId;
    const entry = this.#log(threadId).item(
      this.#seq + 1,
      { kind: "notice", id: noticeId, level, text },
      true,
    );
    this.#emit({ type: "entry", threadId, entry });
    this.#scheduleFlush();
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
        extensions: [...(this.#options.extensions ?? [])],
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
            tabs: options?.tabs ?? false,
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
      threads: (scope) => this.call(client.id, "threads.list", { scope }),
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

  async #commandList(client: Client, threadId: string | null): Promise<CommandInfo[]> {
    const context = this.#commandContext(client, threadId);
    const set = await this.#commandSet(client, threadId);
    return set.commands.list().map((command) => this.#commandInfo(command, context));
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
    // A fork has the turns it came from, though it has run none of its own.
    const empty =
      managed.origin === "user" &&
      managed.forkedFrom === null &&
      managed.runs.length === 0 &&
      thread.queue.length === 0 &&
      thread.idle &&
      this.manager.descendants(threadId).length === 0;
    const shown = [...this.#clients.values()].some(
      (other) => other !== client && other.connected && other.showing === threadId,
    );
    if (!empty || shown) return;
    await this.manager.close(threadId);
    this.#discarding.add(threadId);
    this.manager.forget(threadId);
  }

  #listing(managed: ManagedThread): ThreadListing {
    const last = managed.runs.at(-1);
    const flags = this.#flags.get(managed.id);
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
      pinned: flags?.pinned ?? false,
      archived: flags?.archived ?? false,
      unseen: this.#unseen(managed.id, managed.runs.length, last?.status ?? null),
      native: managed.thread.info.threadId,
    };
  }

  /** A stored thread for a listing; one in memory is listed as it is now. */
  #rowListing(row: ThreadSummaryRow): ThreadListing {
    const live = this.manager.get(row.id);
    if (live) return this.#listing(live);
    return {
      id: row.id,
      title: row.title,
      harness: row.harness,
      cwd: row.cwd,
      status: row.state === "closed" ? "closed" : "parked",
      parentId: row.parentId,
      runCount: row.runCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pinned: row.pinned,
      archived: row.archived,
      unseen: this.#unseen(row.id, row.runCount, row.lastRunStatus, row.seenRuns),
      native: row.info.threadId,
    };
  }

  /** Whether a thread finished runs no client has shown. */
  #unseen(
    id: string,
    runs: number,
    last: RunRecord["status"] | null,
    stored = this.#seenRuns.get(id) ?? 0,
  ): boolean {
    const seen = this.#seenRuns.get(id) ?? stored;
    const finished = last === "running" ? runs - 1 : runs;
    return finished > seen;
  }

  /** A thread's state from the store alone, for one not in memory, such as a closed agent. */
  #storedState(row: ThreadRow): ThreadState {
    const runs = this.#store?.runs(row.id) ?? [];
    const last = runs.at(-1);
    return {
      id: row.id,
      title: row.title,
      harness: row.harness,
      parentId: row.parentId,
      parentCallId: row.parentCallId,
      origin: row.origin,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.state === "closed" ? "closed" : "parked",
      error: row.error,
      info: row.info,
      capabilities: row.capabilities,
      methods: row.methods,
      busy: false,
      queue: [],
      held: false,
      requests: [],
      usage: null,
      runCount: runs.length,
      lastRun: last
        ? { ...last, input: clipText(last.input) ?? "", result: clipText(last.result) }
        : null,
      background: [],
      commandsVersion: 0,
      openedBy: null,
      seenRuns: row.seenRuns,
      pinned: row.pinned,
      archived: row.archived,
    };
  }

  /** Marks a thread's runs seen, as a client shows it. */
  #markSeen(id: string): void {
    const managed = this.manager.get(id);
    if (!managed) return;
    const running = managed.runs.at(-1)?.status === "running";
    this.#seenRuns.set(id, managed.runs.length - (running ? 1 : 0));
    this.#dirty.add(id);
    this.#scheduleFlush();
    this.#announce(managed);
  }

  #methods(): { [M in Method]: (client: Client, params: Params<M>) => Promise<Result<M>> } {
    return {
      "client.hello": async (client, params) => {
        client.cwd = expandHome(params.cwd);
        client.extensions = params.extensions.map((path) => resolvePath(client.cwd, path));
        client.connected = true;
        const warnings = [...(this.#options.warnings ?? [])];
        const set = this.#set(client.cwd, client.extensions);
        await set.ready;
        const waiting = set.host.untrusted.length;
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
          commands: await this.#commandList(client, null),
          pending: [...client.pending.values()],
          warnings,
          store: this.storePath,
        };
      },
      "client.bye": async (client) => {
        await this.disconnect(client.id);
        return null;
      },
      "client.show": async (client, { threadId }) => {
        const previous = client.showing;
        client.showing = threadId;
        if (previous && previous !== threadId) {
          this.#markSeen(previous);
          await this.#discardIfEmpty(previous, client);
        }
        if (threadId) this.#markSeen(threadId);
        return null;
      },
      "threads.list": async (_client, { scope, query, limit }) => {
        if (this.#store) {
          this.#flush();
          return this.#store
            .listThreads({ scope, ...(query ? { query } : {}), limit: limit ?? 200 })
            .map((row) => this.#rowListing(row));
        }
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
      "thread.open": async (client, { harness, settings: asked, title }) => {
        // A client on another machine names folders as they are here.
        const settings = { ...asked, cwd: expandHome(asked.cwd) };
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
          if (failed) {
            this.#discarding.add(failed.id);
            this.manager.forget(failed.id);
          }
          throw error;
        } finally {
          unsubscribe();
        }
      },
      "thread.resume": async (client, { id, harness, settings }) => {
        const own = this.manager.get(id);
        if (own && own.status !== "closed") return this.#state(own);
        // A stored one, closed or not, comes back parked.
        const reopened = await this.#reopen(id);
        if (reopened) return this.#state(reopened);
        if (own) throw new RpcError("thread_closed", `${id} is closed`);
        // A native thread a 1harness thread runs, or ran, opens that thread.
        const running = this.manager
          .list()
          .find((managed) => managed.status !== "closed" && managed.thread.info.threadId === id);
        if (running) return this.#state(running);
        const stored = this.#store?.threadByNative(id);
        const again = stored ? await this.#reopen(stored.id) : null;
        if (again) return this.#state(again);
        return this.#handlers["thread.open"](client, {
          harness,
          settings: { ...settings, resume: id },
        });
      },
      "thread.attach": async (_client, { threadId, before, limit }) => {
        const managed = this.manager.get(threadId);
        // A stored thread not in memory can be read without being opened.
        const row = managed ? null : this.#store?.thread(threadId);
        if (!managed && !row) throw new RpcError("thread_not_found", `No thread ${threadId}`);
        const page = this.#log(threadId).page(
          before,
          Math.min(limit ?? ATTACH_LIMIT, ATTACH_LIMIT),
        );
        const children = new Map(
          this.manager
            .list()
            .filter((other) => other.parentId === threadId)
            .map((other) => [other.id, this.#state(other)]),
        );
        // Agents that ended before a restart are in the store only.
        for (const logged of page.entries) {
          if (logged.entry.type !== "agent" || children.has(logged.entry.threadId)) continue;
          const child = this.#store?.thread(logged.entry.threadId);
          if (child) children.set(child.id, this.#storedState(child));
        }
        return {
          thread: managed ? this.#state(managed) : this.#storedState(row!),
          entries: page.entries,
          more: page.more,
          cursor: this.#seq,
          children: [...children.values()],
        };
      },
      "thread.send": async (client, { threadId, text, steer, command, requestId }) => {
        if (requestId) {
          const sent =
            client.sent.get(requestId) ?? this.#store?.messageByRequest(threadId, requestId);
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
          ? thread.send(input, undefined, { command: true, ...(requestId ? { requestId } : {}) })
          : steer
            ? await thread.steer(input)
            : thread.send(input, undefined, requestId ? { requestId } : {});
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
      "thread.seen": async (_client, { threadId, runs }) => {
        const managed = this.manager.get(threadId);
        if (managed && runs > (this.#seenRuns.get(threadId) ?? 0)) {
          this.#seenRuns.set(threadId, Math.min(runs, managed.runs.length));
          this.#dirty.add(threadId);
          this.#scheduleFlush();
          this.#announce(managed);
        }
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
      "thread.rename": async (_client, { threadId, title }) => {
        const name = title.replace(/\s+/g, " ").trim();
        if (!name) throw new RpcError("invalid_request", "A title cannot be empty");
        const managed = this.manager.get(threadId);
        if (managed) this.manager.rename(threadId, name);
        else {
          const row = this.#store?.thread(threadId);
          if (!row) throw new RpcError("thread_not_found", `No thread ${threadId}`);
          this.#store!.saveThread({ ...row, title: name });
        }
        return null;
      },
      "thread.flag": async (_client, { threadId, pinned, archived }) => {
        const managed = this.manager.get(threadId);
        const row = managed ? null : this.#store?.thread(threadId);
        if (!managed && !row) throw new RpcError("thread_not_found", `No thread ${threadId}`);
        const flags = this.#flags.get(threadId) ?? {
          pinned: row?.pinned ?? false,
          archived: row?.archived ?? false,
        };
        const next = {
          pinned: pinned ?? flags.pinned,
          archived: archived ?? flags.archived,
        };
        this.#flags.set(threadId, next);
        // An archived thread is done with: it ends, with the threads it started.
        if (managed && next.archived && managed.status !== "closed")
          await this.manager.close(threadId);
        if (managed) {
          this.#dirty.add(threadId);
          this.#announce(managed);
          this.#flush();
          return this.#listing(managed);
        }
        this.#store!.saveThread({ ...row!, ...next });
        return this.#rowListing(this.#store!.summary(threadId)!);
      },
      "thread.fork": async (client, { threadId, turn }) => {
        const source = this.manager.get(threadId) ?? (await this.#reopen(threadId));
        if (!source) throw new RpcError("thread_not_found", `No thread ${threadId}`);
        const last = turn ?? source.runs.length;
        if (!Number.isInteger(last) || last < 0 || last > source.runs.length)
          throw new RpcError(
            "invalid_request",
            `${threadId} has turns 1 to ${source.runs.length}; fork after one of them`,
          );
        const info = source.thread.info;
        const handoff = handoffText({
          threadId: source.id,
          to: source.harness,
          runs: source.runs.slice(0, last),
          resumed: false,
          forked: true,
          label,
        });
        const managed = await this.manager.create({
          harness: source.harness,
          settings: {
            cwd: info.cwd,
            model: info.model,
            effort: info.effort,
            runtimeMode: info.runtimeMode,
            interactionMode: info.interactionMode,
            resume: null,
          },
          title: `${source.title || source.id} (fork)`,
          origin: "user",
          openedBy: client.id,
          fork: { from: source.id, handoff },
        });
        this.#notice(
          managed.id,
          "info",
          `Forked from ${source.id} after turn ${last}. Your first message brings ${label(source.harness)} up to date on ${last} ${last === 1 ? "turn" : "turns"}.`,
        );
        return this.#state(managed);
      },
      "thread.forget": async (_client, { threadId }) => {
        const managed = this.manager.get(threadId);
        if (!managed && !this.#store?.thread(threadId))
          throw new RpcError("thread_not_found", `No thread ${threadId}`);
        const ids = [
          ...new Set([
            threadId,
            ...this.manager.descendants(threadId).map((thread) => thread.id),
            ...(this.#store?.descendants(threadId) ?? []),
          ]),
        ];
        if (managed) await this.manager.close(threadId);
        for (const id of ids.toReversed()) {
          if (this.manager.get(id)) {
            this.#discarding.add(id);
            this.manager.forget(id);
          } else this.#store?.deleteThread(id);
          this.#flags.delete(id);
          this.#seenRuns.delete(id);
        }
        return { forgotten: ids };
      },
      "threads.search": async (_client, { query, limit }) => {
        const store = this.#store;
        if (!store) return [];
        this.#flush();
        const seen = new Set<string>();
        const found: { thread: ThreadListing; snippet: string }[] = [];
        for (const hit of store.search(query, (limit ?? 30) * 4)) {
          if (seen.has(hit.threadId)) continue;
          seen.add(hit.threadId);
          const row = store.summary(hit.threadId);
          if (row) found.push({ thread: this.#rowListing(row), snippet: hit.snippet });
          if (found.length >= (limit ?? 30)) break;
        }
        return found;
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
        const command = (await this.#commandSet(client, threadId)).commands.find(name);
        if (!command) throw new RpcError("command_not_found", `No command /${name}`);
        const context = this.#commandContext(client, threadId);
        if (!this.#commandInfo(command, context).available)
          throw new RpcError("unavailable", `/${command.name} is not available here`);
        await command.run(context, args);
        return null;
      },
      "commands.complete": async (client, { threadId, name, args }) => {
        const command = (await this.#commandSet(client, threadId)).commands.find(name);
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
