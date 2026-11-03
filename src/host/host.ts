import {
  type CommandContext,
  type CommandDefinition,
  type CommandThread,
  type CommandUI,
  type SessionHandle,
} from "../commands/registry.ts";
import {
  type HarnessId,
  type NoticeLevel,
  type SessionMethod,
  type SessionOptions,
} from "../core/events.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { configDir, stateDir } from "../core/paths.ts";
import { DEFAULT_AGENT_MODE, defaultHarness, defaultMode, loadSettings } from "../core/settings.ts";
import { errorMessage } from "../core/errors.ts";
import { type Thread } from "../core/thread.ts";
import { isThreadIdPrefix, shortThreadId } from "../core/thread-id.ts";
import { formatTokens } from "../core/wording.ts";
import {
  checkHarness,
  drivers,
  findDriver,
  harnessInfo,
  harnessName as label,
} from "../drivers/index.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import { ToolServer } from "../extensions/tool-server.ts";
import { HOSTED_ENV } from "../operations/mcp.ts";
import {
  OperationError,
  operationInfo,
  runOperation,
  type Caller,
  type Operation,
  type OperationInfo,
} from "../operations/operation.ts";
import { agentTools, toolOperation } from "../operations/tools.ts";
import {
  PROTOCOL_VERSION,
  RpcError,
  SESSION_CALLS,
  type SessionCall,
  type CommandInfo,
  type HarnessInfo,
  type HostEvent,
  type LogEntry,
  type Method,
  type Params,
  type Result,
  type ThreadListing,
  type ThreadState,
} from "../protocol.ts";
import type { Store, ThreadRow, ThreadSummaryRow } from "../store/store.ts";
import { handoffText } from "./handoff.ts";
import { ThreadLog, decisions } from "./log.ts";
import {
  ThreadManager,
  type ManagedThread,
  type ManagerEvent,
  type RestoredThread,
  type RunRecord,
  type SwitchResult,
} from "./manager.ts";
import { LivePages } from "./live.ts";
import { Media, pageTools } from "./media.ts";
import { mediaMethods } from "./media-methods.ts";
import { FileIndexes } from "./file-indexes.ts";
import { Clients, type Client, type Handlers } from "./clients.ts";
import { EventFeed } from "./feed.ts";
import { ExtensionSets, type ExtensionSet } from "./extension-sets.ts";
import { hostOperations } from "./operations.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Scope } from "./scope.ts";
import { savePastedImages, sendText } from "./send.ts";
import { StoreWriter } from "./store-writer.ts";
import {
  NO_FLAGS,
  isEmpty,
  rowListing,
  storedState,
  threadListing,
  threadRow,
  threadState,
  type Marks,
} from "./views.ts";

/** The most log entries one `thread.attach` returns. */
const ATTACH_LIMIT = 500;
/** A resumed thread this large, or idle this long, costs more to pick up than it looks. */
const HEAVY_RESUME_TOKENS = 100_000;
const COLD_RESUME_MS = 60 * 60 * 1000;

/** The client agents in 1harness threads make requests as, when an operation needs one. */
const AGENTS_CLIENT = "1harness:agents";

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
function describeSwitch(result: SwitchResult): { level: "info" | "warning"; text: string } {
  const to = label(result.to);
  const lines: string[] = [];
  if (result.resumeError)
    lines.push(
      `Could not resume ${to}'s earlier session (${result.resumeError}); started a new one.`,
    );
  const context = result.resumedContext;
  const size = context?.tokens ? `about ${formatTokens(context.tokens)} tokens of context, ` : "";
  const where = context
    ? `its earlier session (${size}last used ${idleFor(context.idleMs)})`
    : "a new session";
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
      `Its whole earlier context is sent again with that message. /harness ${result.to} fresh starts a new ${to} session with a handoff instead.`,
    );
  return { level: heavy ? "warning" : "info", text: lines.join("\n") };
}

/** Runs one of a thread's session methods, waking the thread first should it be parked. */
async function callSession(
  thread: Thread,
  method: SessionCall | SessionMethod,
  args: unknown[],
): Promise<unknown> {
  const session = await thread.wake();
  const call = session[method] as ((...rest: unknown[]) => Promise<unknown>) | undefined;
  if (!call) throw new RpcError("unsupported", `${label(session.info.harness)} cannot ${method}`);
  return call.apply(session, args);
}

/** A session for commands, which may run while the thread is parked. */
function sessionHandle(thread: Thread): SessionHandle {
  const handle: Record<string, unknown> = {};
  for (const method of ["setRuntimeMode", "setInteractionMode", ...thread.methods] as const)
    handle[method] = (...args: unknown[]) => callSession(thread, method, args);
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
  /** This run of the host, so a client can tell it from the one before a restart. */
  readonly instance = randomUUID();
  readonly manager: ThreadManager;
  readonly orchestrator: Orchestrator;
  /** Everything 1harness itself can do, for every surface; extensions add their own. */
  readonly operations: readonly Operation[];
  #scope: Scope;

  readonly tools: ToolServer;
  #options: HostOptions;
  /** Extensions by folder and the modules a client named, each set with its commands. */
  #sets: ExtensionSets;
  #agentTools: ReadonlyMap<string, { tool: ToolDefinition }> = new Map();
  /** html2term, for images shrunk to their size on screen and pages drawn as pictures. */
  readonly media = new Media();
  /** Pages kept running for clients, through html2term's browser worker. */
  readonly live = new LivePages(
    () => this.media.binary,
    () => this.media.capabilities.browser !== null,
  );
  /** The tools that show the user pages, which every session gets with the orchestrator's. */
  readonly pageTools: ToolDefinition[];
  #feed: EventFeed;
  /** The harnesses as clients were last told of them. */
  #harnessesSaid = "";
  #logs = new Map<string, ThreadLog>();
  /** The state each thread was last announced with. */
  #announced = new Map<string, string>();
  #commandsVersion = new Map<string, number>();
  #clients: Clients;
  #files = new FileIndexes();
  #started: Promise<void> | null = null;
  #store: Store | null;
  /** Writes threads to the store as they change; null without a store. */
  #writer: StoreWriter | null;
  /** Each thread's flags and the runs a client has shown, as the store keeps them. */
  #marks = new Map<string, Marks>();
  /** Threads whose harness was asked for their name, so it is asked once. */
  #titled = new Set<string>();
  /** Threads being dropped for good, which the store deletes too. */
  #discarding = new Set<string>();
  /** Each thread's open requests already answered, so a second answer is not recorded. */
  #answered = new Map<string, Set<string>>();
  /**
   * Closed threads being taken out of memory but not out of the store: to
   * come back parked, or to be read and reopened from there.
   */
  #reopening = new Set<string>();
  /** Closed threads to take out of memory once they are stored. */
  #closedThreads = new Set<string>();
  #releaseTimer: NodeJS.Immediate | null = null;
  #stopped = false;
  #handlers: Handlers;

  constructor(options: HostOptions) {
    this.#options = options;
    this.version = options.version;
    // Harnesses inherit it, so a `1harness mcp` in their own config steps aside
    // for the tools their session already gets.
    process.env[HOSTED_ENV] = "1";
    this.#store = options.store ?? null;
    this.#feed = new EventFeed(this.#store?.maxSeq() ?? 0);
    this.#clients = new Clients(this.#feed, {
      cwd: options.cwd,
      extensions: options.extensions ?? [],
    });
    this.#writer = this.#store
      ? new StoreWriter(this.#store, {
          thread: (id) => this.manager.get(id),
          row: (managed) => this.#row(managed),
          visits: (id) => this.manager.visits(id),
          logs: () => this.#logs,
          tasks: () => this.orchestrator.taskRows(),
          seq: () => this.#feed.seq,
          failed: (error) =>
            this.#clients.broadcast("error", `Could not save threads: ${errorMessage(error)}`),
        })
      : null;
    this.#sets = new ExtensionSets({
      configDir: () => options.configDir ?? configDir(),
      stateDir: () => options.stateDir ?? stateDir(),
      ui: (thread) => this.#extensionUi(thread),
      inUse: () => [
        ...this.manager.list().flatMap((managed) => this.manager.extensionsOf(managed.id) ?? []),
        ...this.#clients.connected().map((client) => this.#sets.key(client.cwd, client.extensions)),
      ],
    });
    // Every session gets 1harness's own tools; its folder's extensions add theirs.
    this.tools = new ToolServer(() => this.#agentTools, options.version);
    this.manager = new ThreadManager({
      version: options.version,
      extensions: (cwd, client) => this.#extensionsFor(cwd, client),
      tools: this.tools,
      onWarning: (text) => this.#clients.broadcast("warning", text),
      ...(options.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
    });
    // Reads reach closed threads that have left memory for the store.
    this.#scope = new Scope(this.manager, (id) => {
      const row = this.#stored(id);
      return row && { ...row, status: "closed", thread: { info: row.info, requests: [] } };
    });
    this.orchestrator = new Orchestrator(this.manager, options.env, this.#scope);
    // Through the host, so clients hear of what a delegation's check finds.
    this.orchestrator.checkHarness = async (driver) =>
      (await this.#checkHarnesses(driver.id)).find((harness) => harness.id === driver.id) ??
      harnessInfo(driver, options.env ?? process.env);
    this.orchestrator.storedTask = (id) => this.#stored(id);
    const toolThread = (thread: Thread) =>
      this.#scope.agent({ kind: "agent", thread, callId: null });
    this.pageTools = pageTools({
      media: this.media,
      live: this.live,
      cwd: (thread) => toolThread(thread).thread.info.cwd,
      show: (thread, title, html) => {
        this.#append(toolThread(thread).id, (log, seq) => log.html(seq, title, html, Date.now()));
      },
    });
    this.operations = [
      ...this.orchestrator.operations,
      ...hostOperations({
        manager: this.manager,
        scope: this.#scope,
        request: (caller, method, params) =>
          this.call(caller.kind === "agent" ? AGENTS_CLIENT : caller.clientId, method, params),
        cwd: (caller) =>
          caller.kind === "agent"
            ? this.#scope.agent(caller).thread.info.cwd
            : this.#clients.get(caller.clientId).cwd,
        defaultHarness: () => defaultHarness(this.#settings(), options.stateDir ?? stateDir()),
        defaultMode: () => defaultMode(this.#settings()),
        seq: () => this.seq,
        since: (after) => this.since(after),
        subscribe: (listener) => this.subscribe(listener),
      }),
      ...this.pageTools.map(toolOperation),
    ];
    this.#agentTools = new Map(agentTools(this.operations).map((tool) => [tool.name, { tool }]));
    this.manager.subscribe((event) => this.#managerEvent(event));
    this.#handlers = this.#methods();
  }

  /** Brings back stored threads, with their folders' extensions; calls after the first wait for it. */
  start(): Promise<void> {
    this.#started ??= this.#restore();
    return this.#started;
  }

  /** The modules a client named with `-x`, which load only for the threads it opens. */
  #modules(clientId: string | null): readonly string[] {
    const client = clientId ? this.#clients.find(clientId) : undefined;
    return client?.extensions ?? (clientId === null ? [] : (this.#options.extensions ?? []));
  }

  async #extensionsFor(cwd: string, clientId: string | null): Promise<ExtensionHost> {
    const set = this.#sets.get(cwd, this.#modules(clientId));
    await set.ready;
    return set.host;
  }

  /** The set whose commands a client sees: the thread's when it has one, else its folder's. */
  async #commandSet(client: Client, threadId: string | null): Promise<ExtensionSet> {
    const thread = threadId ? this.manager.extensionsOf(threadId) : undefined;
    const set = thread ? this.#sets.of(thread) : undefined;
    const chosen = set ?? this.#sets.get(client.cwd, client.extensions);
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
      // A thread a client opened and left with nothing in it, without saying goodbye.
      const empty = isEmpty({
        ...row,
        runs: runs.length,
        queued: store.queuedMessages(row.id).length,
        children: store.descendants(row.id).length,
      });
      if (empty) {
        store.deleteThread(row.id);
        continue;
      }
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
        for (const event of [
          {
            type: "turn.ended" as const,
            turnId: run?.turnId ?? "",
            status: "interrupted" as const,
            error: null,
          },
          { type: "session.closed" as const, error: null },
        ]) {
          this.#append(managed.id, (log, seq) => log.apply(event, seq, () => undefined));
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
          held === 1
            ? "1 queued message was waiting when 1harness stopped. It runs once you send this thread a message; /unqueue takes it back."
            : `${held} queued messages were waiting when 1harness stopped. They run in order once you send this thread a message; /unqueue takes the last one back.`,
        );
      this.#writer?.mark(managed.id);
    }
    // Tasks of threads still closed stay in the store, where nothing asks for them.
    this.orchestrator.restoreTasks(store.tasks().filter((task) => this.manager.get(task.parentId)));
    this.#writer?.schedule();
  }

  #restored(row: ThreadRow, runs: RunRecord[]): RestoredThread {
    const store = this.#store!;
    this.#marks.set(row.id, {
      flags: { pinned: row.pinned, archived: row.archived },
      seenRuns: row.seenRuns,
    });
    return {
      id: row.id,
      title: row.title,
      named: row.named,
      harness: row.harness,
      parentId: row.parentId,
      parentCallId: row.parentCallId,
      origin: row.origin,
      forkedFrom: row.forkedFrom,
      forkContext: row.forkContext,
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
        usage: row.usage,
      },
    };
  }

  /**
   * The thread a typed ID names: itself when a thread has it, else the one
   * thread whose ID starts with it. Matching none, it is returned as typed,
   * for a harness's own ID; matching several, the caller is asked for more.
   */
  #resolveId(typed: string): string {
    const id = typed.trim();
    if (this.manager.get(id) || this.#store?.thread(id) || !isThreadIdPrefix(id)) return id;
    const prefix = id.toLowerCase();
    const matches = new Set(
      this.manager
        .list()
        .map((managed) => managed.id)
        .filter((candidate) => candidate.startsWith(prefix)),
    );
    for (const stored of this.#store?.threadIdsStartingWith(prefix) ?? []) matches.add(stored);
    const [only, ...others] = matches;
    if (!only) return id;
    if (others.length === 0) return only;
    throw new RpcError(
      "thread_ambiguous",
      `${id} could be ${[...matches].join(", ")}; type more of it`,
    );
  }

  /** Brings a stored thread back into memory, parked, such as a closed one reopened. */
  async #reopen(id: string): Promise<ManagedThread | null> {
    const store = this.#store;
    const found = store?.thread(id);
    if (!store || !found) return null;
    // Its extensions first: from here on nothing waits, so the thread is never missing
    // for a call that comes meanwhile, and a second reopen finds it back.
    const extensions = await this.#extensionsFor(found.cwd, null);
    const existing = this.manager.get(id);
    if (existing) {
      if (existing.status !== "closed") return existing;
      this.#writer?.flush();
      this.#forgetQuietly(id);
    }
    const row = store.thread(id) ?? found;
    const [managed] = this.manager.restore([
      { ...this.#restored({ ...row, state: "parked" }, store.runs(id)), extensions },
    ]);
    if (!managed) return null;
    // Tasks left memory with it; one still in memory has its own, which may be newer.
    if (!existing)
      this.orchestrator.restoreTasks(store.tasks().filter((task) => task.parentId === id));
    this.#writer?.mark(id);
    this.#writer?.schedule();
    return managed;
  }

  get seq(): number {
    return this.#feed.seq;
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    return this.#feed.subscribe(listener);
  }

  /** The events after `after`, or null when the client must start over from a snapshot. */
  since(after: number): HostEvent[] | null {
    return this.#feed.since(after);
  }

  /** Marks a client as one on a remote listener, from its first request on. */
  markRemote(clientId: string): void {
    this.#clients.get(clientId).remote = true;
  }

  /** Marks a client as an agent 1harness does not run, as the server's `/mcp` serves. */
  markAgent(clientId: string): void {
    this.#clients.get(clientId).agent = true;
  }

  /** Who a client is to the operations it calls. */
  #callerOf(client: Client): Caller {
    if (!client.agent) return { kind: "user", clientId: client.id };
    return {
      kind: "external",
      clientId: client.id,
      ceiling: this.#settings().agentMode ?? DEFAULT_AGENT_MODE,
    };
  }

  #settings() {
    return loadSettings(this.#options.configDir ?? configDir()).settings;
  }

  /** The operations a client may call: 1harness's, and its folder's or thread's extensions'. */
  async #operationsFor(client: Client, threadId: string | null): Promise<Map<string, Operation>> {
    const set = await this.#commandSet(client, threadId);
    const all = new Map(this.operations.map((operation) => [operation.name, operation]));
    // 1harness's own come first; an extension cannot replace one.
    for (const [name, { operation }] of set.host.operations)
      if (!all.has(name)) all.set(name, operation);
    return all;
  }

  /** The operations a client may call, as it lists them. */
  async #operationList(client: Client, threadId: string | null): Promise<OperationInfo[]> {
    const kind = this.#callerOf(client).kind;
    return [...(await this.#operationsFor(client, threadId)).values()]
      .filter((operation) => operation.callers.includes(kind))
      .map(operationInfo);
  }

  async #runOperation(
    client: Client,
    threadId: string | null,
    name: string,
    input: unknown,
  ): Promise<unknown> {
    const operations = await this.#operationsFor(client, threadId);
    try {
      return await runOperation(operations.get(name), name, input, this.#callerOf(client));
    } catch (error) {
      if (error instanceof OperationError) throw new RpcError(error.code, error.message);
      throw error;
    }
  }

  async call<M extends Method>(clientId: string, method: M, params: Params<M>): Promise<Result<M>> {
    const handler = this.#handlers[method] as
      | ((client: Client, params: Params<M>) => Promise<Result<M>>)
      | undefined;
    if (!handler) throw new RpcError("unknown_method", `No method ${method}`);
    await this.start();
    return handler(this.#clients.get(clientId), params);
  }

  /**
   * A client left: its picks resolve as dismissed. One that said goodbye is
   * forgotten, and a thread it opened that has nothing in it is dropped; one
   * that only went quiet keeps them, in case it comes back, until it is
   * disconnected again for good.
   */
  async disconnect(clientId: string, options: { discard?: boolean } = {}): Promise<void> {
    const client = this.#clients.find(clientId);
    if (!client) return;
    const discard = options.discard ?? true;
    this.#clients.leave(client);
    const showing = client.showing;
    const left = client.left;
    if (showing) {
      // What it showed up to the end was seen.
      this.#markSeen(showing);
      if (discard) await this.#discardIfEmpty(showing, client);
    }
    if (left && discard) await this.#discardIfEmpty(left, client);
    if (discard) {
      client.showing = null;
      client.left = null;
      this.#clients.forget(clientId);
    }
    // Its live pages ran for it alone.
    this.live.closeOwned(clientId);
  }

  /** Whether a client said hello and has not left since, so it can pick up where it was. */
  connected(clientId: string): boolean {
    return this.#clients.find(clientId)?.connected === true;
  }

  /** How many clients are connected: said hello, and have not left. */
  get clients(): number {
    return this.#clients.connected().length;
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
    for (const client of this.#clients.all()) await this.disconnect(client.id);
    if (this.#store) await this.manager.parkAll();
    else await this.manager.closeAll();
    this.#stopped = true;
    this.#writer?.stop();
    if (this.#releaseTimer) clearImmediate(this.#releaseTimer);
    this.live.stop();
    this.#files.close();
    await this.tools.close();
    await this.#sets.close();
    this.#writer?.flush();
    this.#store?.close();
  }

  #row(managed: ManagedThread): ThreadRow {
    return threadRow(
      managed,
      this.#marksOf(managed.id),
      this.manager.seenWithoutHandoff(managed.id),
    );
  }

  #marksOf(id: string): Marks {
    return this.#marks.get(id) ?? { flags: NO_FLAGS, seenRuns: 0 };
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
        if (thread.parentId && this.manager.get(thread.parentId))
          this.#append(thread.parentId, (log, seq) => log.agent(seq, thread.id));
        return;
      }
      case "thread.updated":
        this.#announce(event.thread);
        // A thread a client went to has started, so the empty one it left can go;
        // one that failed to start leaves it there to go back to.
        if (event.thread.status !== "starting" && event.thread.status !== "closed")
          for (const client of this.#clients.all())
            if (client.left && client.showing === event.thread.id) {
              const left = client.left;
              client.left = null;
              void this.#discardIfEmpty(left, client);
            }
        this.#writer?.mark(event.thread.id);
        this.#writer?.schedule();
        if (event.thread.status === "closed" && this.#store) {
          this.#closedThreads.add(event.thread.id);
          this.#releaseTimer ??= setImmediate(() => {
            this.#releaseTimer = null;
            this.#releaseClosed();
          });
        }
        return;
      case "thread.event": {
        const managed = this.manager.get(event.threadId);
        if (!managed) return;
        const change = event.event;
        this.#writer?.admit(managed, change);
        if (change.type !== "item.delta") this.#writer?.mark(managed.id);
        this.#writer?.schedule(change.type === "item.delta");
        if (change.type === "commands.updated" || change.type === "session.replaced")
          this.#commandsVersion.set(managed.id, (this.#commandsVersion.get(managed.id) ?? 0) + 1);
        const entry = this.#log(managed.id).apply(change, this.#feed.next, (id) =>
          managed.thread.message(id),
        );
        if (entry) this.#feed.emit({ type: "entry", threadId: managed.id, entry });
        // A harness that fails may have been signed out; asking it lets clients say so.
        if (
          (change.type === "turn.ended" && change.status === "failed") ||
          (change.type === "session.closed" && change.error) ||
          (change.type === "error" && change.unsent)
        )
          void this.#checkHarnesses(managed.harness, true).catch(() => {});
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
            `Could not resume ${label(result.to)}'s own session (${result.resumeError}); started a new one${result.handedOver > 0 ? `, which your message brings up to date on ${result.handedOver} ${result.handedOver === 1 ? "turn" : "turns"}` : ""}.`,
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
        this.#dropThread(event.threadId);
        if (this.#discarding.delete(event.threadId)) this.#writer?.delete(event.threadId);
        // One being reopened comes straight back, and one stored can be read and
        // reopened; telling clients it went could make one that shows it drop it.
        if (!this.#reopening.has(event.threadId))
          this.#feed.emit({ type: "removed", threadId: event.threadId });
        return;
    }
  }

  /**
   * Takes closed threads out of memory once the store has them, as a restart
   * would; clients read and reopen them from there. An agent stays while the
   * thread that started it is open, which may still ask how its task went,
   * and goes with that thread.
   */
  #releaseClosed(): void {
    if (!this.#store || this.#stopped) return;
    this.#writer?.flush();
    // What the store may not have stays in memory.
    if (this.#writer?.failing) return;
    for (const id of this.#closedThreads) {
      this.#closedThreads.delete(id);
      const managed = this.manager.get(id);
      if (managed?.status !== "closed") continue;
      const parent = managed.parentId;
      if (parent && this.manager.get(parent) && !this.manager.closing(parent)) continue;
      const ids = [...this.manager.descendants(id).map((child) => child.id), id].toReversed();
      this.orchestrator.forgetTasks(ids);
      for (const gone of ids) this.#forgetQuietly(gone);
    }
  }

  /** Takes a closed thread out of memory, keeping it in the store, without telling clients it went. */
  #forgetQuietly(id: string): void {
    this.#reopening.add(id);
    try {
      this.manager.forget(id);
    } finally {
      this.#reopening.delete(id);
    }
  }

  /** Lets go of everything the host keeps for a thread that left memory. */
  #dropThread(id: string): void {
    this.#logs.delete(id);
    this.#answered.delete(id);
    this.#announced.delete(id);
    this.#commandsVersion.delete(id);
    this.#marks.delete(id);
    this.#closedThreads.delete(id);
    this.#writer?.forget(id);
  }

  /**
   * IDs of threads the host keeps anything for besides the manager's record,
   * which are only threads in memory once the store has caught up.
   */
  get trackedThreads(): string[] {
    const maps: { keys(): Iterable<string> }[] = [
      this.#logs,
      this.#answered,
      this.#announced,
      this.#commandsVersion,
      this.#marks,
      this.#closedThreads,
    ];
    const kept = maps.flatMap((map) => [...map.keys()]);
    return [...new Set([...kept, ...(this.#writer?.tracked ?? [])])];
  }

  /** Sends a thread's state when it changed since it was last sent. */
  #announce(managed: ManagedThread): void {
    if (!this.manager.get(managed.id)) return;
    const state = this.#state(managed);
    const key = JSON.stringify(state);
    if (this.#announced.get(managed.id) === key) return;
    this.#announced.set(managed.id, key);
    this.#feed.emit({ type: "thread", thread: state });
  }

  #state(managed: ManagedThread): ThreadState {
    return threadState(
      managed,
      this.#marksOf(managed.id),
      this.#commandsVersion.get(managed.id) ?? 0,
    );
  }

  /**
   * Adds a line of the host's own to a thread's transcript, or changes the one
   * with `id`; returns its ID.
   */
  #notice(threadId: string, level: NoticeLevel, text: string, id?: string): string {
    const noticeId = id ?? `notice-${this.#feed.next}`;
    if (!this.manager.get(threadId)) return noticeId;
    this.#append(threadId, (log, seq) =>
      log.item(seq, { kind: "notice", id: noticeId, level, text }, true),
    );
    return noticeId;
  }

  /** Adds to a thread's transcript, which clients hear of and the store saves. */
  #append(threadId: string, add: (log: ThreadLog, seq: number) => LogEntry | null): void {
    const entry = add(this.#log(threadId), this.#feed.next);
    if (!entry) return;
    this.#feed.emit({ type: "entry", threadId, entry });
    this.#writer?.schedule();
  }

  /**
   * The UI extensions' handlers get for a thread: the client showing it, or
   * none. Without a thread, notices go to every client.
   */
  #extensionUi(thread: Thread | null): CommandUI | null {
    if (!thread) return this.#clients.everyone();
    const id = this.manager.byThread(thread)?.id;
    const client = id ? this.#clients.showing(id) : undefined;
    return client ? this.#clients.ui(client) : null;
  }

  // Commands

  /** What is known of each harness now, from the last check. */
  #harnesses(): HarnessInfo[] {
    const env = this.#options.env ?? process.env;
    return drivers().map((driver) => harnessInfo(driver, env));
  }

  /**
   * Asks a harness, or every one, where it stands, and tells every client when
   * that changed. Returns what is known of them all.
   */
  async #checkHarnesses(id?: HarnessId, force = false): Promise<HarnessInfo[]> {
    const env = this.#options.env ?? process.env;
    const asked = drivers().filter((driver) => id === undefined || driver.id === id);
    await Promise.all(asked.map((driver) => checkHarness(driver, env, force)));
    const harnesses = this.#harnesses();
    const said = JSON.stringify(harnesses);
    if (said !== this.#harnessesSaid) {
      this.#harnessesSaid = said;
      this.#feed.emit({ type: "harnesses", harnesses });
    }
    return harnesses;
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
        runtimeMode: info?.runtimeMode ?? defaultMode(this.#settings()),
        interactionMode: info?.interactionMode ?? "default",
        resume: null,
      };
    };
    return {
      ui: this.#clients.ui(client),
      // No thread is on no harness, as a terminal without one says; none is everyone's.
      harness: managed?.harness ?? "",
      thread: managed ? this.#commandThread(managed, client) : null,
      info: managed?.thread.info ?? null,
      session: () => {
        if (!managed || managed.status === "closed")
          throw new Error("No session is running. Use /new to start one.");
        return sessionHandle(managed.thread);
      },
      harnesses: () => this.#harnesses(),
      checkHarnesses: () => this.#checkHarnesses(),
      // Defaults are each client's own, in its settings.
      defaultHarness: null,
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
        const harness = options.harness ?? managed?.harness;
        if (!harness) throw new Error("Name a harness to start the thread on");
        const base = settings();
        const state = options.resume
          ? await this.call(client.id, "thread.resume", {
              id: options.resume,
              harness,
              settings: base,
            })
          : await this.call(client.id, "thread.open", {
              harness,
              settings: {
                ...base,
                ...(options.defaultModel ? { model: null, effort: null } : {}),
                ...(options.model !== undefined
                  ? { model: options.model, effort: options.effort ?? null }
                  : {}),
              },
            });
        this.#clients.ask(client, { method: "show", threadId: state.id });
      },
      switchHarness: async (harness, options) => {
        if (!managed) throw new Error("No thread to move");
        await this.#switch(managed, harness, options?.fresh === true);
      },
      exit: async () => {
        this.#clients.ask(client, { method: "exit" });
      },
      operations: () => this.#operationList(client, threadId),
      runOperation: (name, input) => this.#runOperation(client, threadId, name, input),
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

  /** A thread in memory, else as the store keeps it. */
  #find(
    threadId: string,
  ): { managed: ManagedThread; row?: undefined } | { managed?: undefined; row: ThreadRow } {
    const managed = this.manager.get(threadId);
    if (managed) return { managed };
    const row = this.#store?.thread(threadId);
    if (!row) throw new RpcError("thread_not_found", `No thread ${threadId}`);
    return { row };
  }

  /** A thread only the store keeps, with its runs. */
  #stored(id: string): (ThreadRow & { runs: RunRecord[] }) | null {
    const row = this.#store?.thread(id);
    return row ? { ...row, runs: this.#store!.runs(id) } : null;
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
        : `Moving ${shortThreadId(managed.id)} to ${label(harness)}…`,
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
    const empty =
      managed.thread.idle &&
      isEmpty({
        ...managed,
        pinned: this.#marksOf(threadId).flags.pinned,
        runs: managed.runs.length,
        queued: managed.thread.queue.length,
        children: this.manager.descendants(threadId).length,
      });
    const shown = this.#clients.showing(threadId, client) !== undefined;
    if (!empty || shown) return;
    await this.manager.close(threadId);
    this.#discarding.add(threadId);
    this.manager.forget(threadId);
  }

  #listing(managed: ManagedThread): ThreadListing {
    return threadListing(managed, this.#marksOf(managed.id));
  }

  /**
   * Names threads still named by their first message as their harness has
   * since named them, such as earlier Claude sessions; each is asked once.
   */
  async #harnessTitles(rows: ThreadSummaryRow[]): Promise<void> {
    const store = this.#store;
    if (!store) return;
    await Promise.all(
      rows.map(async (row) => {
        const native = row.info.threadId;
        const driver = findDriver(row.harness);
        if (row.named || !native || !driver?.sessionTitle || this.#titled.has(row.id)) return;
        this.#titled.add(row.id);
        const title = await driver.sessionTitle(row.cwd, native).catch(() => null);
        if (!title || title === row.title) return;
        row.title = title;
        const live = this.manager.get(row.id);
        if (live) this.manager.retitle(row.id, title);
        // A closed thread is no longer saved as it changes, so its name is saved here.
        if (!live || live.status === "closed") {
          const saved = store.thread(row.id);
          if (saved && !saved.named) store.saveThread({ ...saved, title });
        }
      }),
    );
  }

  /** A stored thread for a listing; one in memory is listed as it is now. */
  #rowListing(row: ThreadSummaryRow): ThreadListing {
    const live = this.manager.get(row.id);
    return live ? this.#listing(live) : rowListing(row);
  }

  /** A thread's state from the store alone, for one not in memory. */
  #storedState(row: ThreadRow): ThreadState {
    return storedState(row, this.#store?.runs(row.id) ?? []);
  }

  /** Marks a thread's runs seen, as a client shows it. */
  #markSeen(id: string): void {
    const managed = this.manager.get(id);
    if (!managed) return;
    const running = managed.runs.at(-1)?.status === "running";
    this.#setSeenRuns(id, managed.runs.length - (running ? 1 : 0));
    this.#writer?.mark(id);
    this.#writer?.schedule();
    this.#announce(managed);
  }

  #setSeenRuns(id: string, seenRuns: number): void {
    this.#marks.set(id, { ...this.#marksOf(id), seenRuns });
  }

  #methods(): Handlers {
    return {
      ...this.#clientMethods(),
      ...this.#threadMethods(),
      ...this.#keepingMethods(),
      ...this.#commandMethods(),
      ...mediaMethods(this.media, this.live),
    };
  }

  /** Saying hello and goodbye, which thread a client shows, and its answers to what it was asked. */
  #clientMethods(): Pick<Handlers, "client.hello" | "client.bye" | "client.show" | "ui.reply"> {
    return {
      "client.hello": async (client, params) => {
        client.cwd = expandHome(params.cwd);
        // Loading a module runs it here, which no one on another machine may make this host do.
        const named = client.remote ? [] : params.extensions;
        client.extensions = named.map((path) => resolvePath(client.cwd, path));
        client.connected = true;
        if (params.agent) client.agent = true;
        const warnings = [...(this.#options.warnings ?? [])];
        if (named.length < params.extensions.length)
          warnings.push("Extensions load only for clients on this machine; yours were left out.");
        const set = this.#sets.get(client.cwd, client.extensions);
        await set.ready;
        const waiting = set.host.untrusted.length;
        if (waiting > 0)
          warnings.push(
            `This folder has ${waiting} ${waiting === 1 ? "extension" : "extensions"} of its own; /extensions trust loads them.`,
          );
        return {
          version: this.version,
          protocol: PROTOCOL_VERSION,
          instance: this.instance,
          seq: this.#feed.seq,
          threads: this.manager.list().map((managed) => this.#state(managed)),
          harnesses: this.#harnesses(),
          commands: await this.#commandList(client, null),
          pending: [...client.pending.values()],
          warnings,
          store: this.storePath,
          live: this.live.available,
        };
      },
      "client.bye": async (client) => {
        await this.disconnect(client.id);
        return null;
      },
      "client.show": async (client, { threadId }) => {
        const previous = client.showing;
        client.showing = threadId;
        // A thread left earlier for one still starting: back to it, it stays; on to a
        // third, it goes as an empty one would have.
        const left = client.left;
        client.left = null;
        if (left && left !== threadId && left !== previous)
          await this.#discardIfEmpty(left, client);
        if (previous && previous !== threadId) {
          this.#markSeen(previous);
          // Left for a thread still starting, it waits: that one may fail, and the client go back.
          const starting = threadId ? this.manager.get(threadId)?.status === "starting" : false;
          if (starting) client.left = previous;
          else await this.#discardIfEmpty(previous, client);
        }
        if (threadId) this.#markSeen(threadId);
        return null;
      },
      "ui.reply": async (client, { id, result }) => {
        this.#clients.reply(client, id, result);
        return null;
      },
    };
  }

  /** Starting threads and coming back to them, and what is sent to and asked of each. */
  #threadMethods(): Pick<
    Handlers,
    | "thread.open"
    | "thread.resume"
    | "thread.attach"
    | "thread.send"
    | "thread.respond"
    | "thread.seen"
    | "thread.stop"
    | "thread.close"
    | "thread.unqueue"
    | "thread.switchHarness"
    | "thread.call"
    | "thread.command"
  > {
    return {
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
          // What was known of its harness may be old; a change goes out as an event.
          void this.#checkHarnesses(managed.harness).catch(() => {});
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
      "thread.resume": async (client, { id: typed, harness, settings }) => {
        // As thread.open does, the harness it comes back on is asked where it stands.
        const shown = (managed: ManagedThread) => {
          void this.#checkHarnesses(managed.harness).catch(() => {});
          return this.#state(managed);
        };
        const id = this.#resolveId(typed);
        const own = this.manager.get(id);
        if (own && own.status !== "closed") return shown(own);
        // A stored one, closed or not, comes back parked.
        const reopened = await this.#reopen(id);
        if (reopened) return shown(reopened);
        if (own) throw new RpcError("thread_closed", `${id} is closed`);
        // A native thread a 1harness thread runs, or ran, opens that thread.
        const running = this.manager
          .list()
          .find((managed) => managed.status !== "closed" && managed.thread.info.threadId === id);
        if (running) return shown(running);
        const stored = this.#store?.threadByNative(id);
        const again = stored ? await this.#reopen(stored.id) : null;
        if (again) return shown(again);
        if (!harness)
          throw new RpcError("thread_not_found", `No thread ${id}; name a harness to resume it on`);
        return this.#handlers["thread.open"](client, {
          harness,
          settings: { ...settings, resume: id },
        });
      },
      "thread.attach": async (_client, { threadId: typed, before, limit }) => {
        const threadId = this.#resolveId(typed);
        const { managed, row } = this.#find(threadId);
        // A thread not in memory is read where it is kept, without keeping it here.
        const log = managed ? this.#log(threadId) : new ThreadLog(this.#store!.log(threadId));
        const page = log.page(before, Math.min(limit ?? ATTACH_LIMIT, ATTACH_LIMIT));
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
          thread: managed ? this.#state(managed) : this.#storedState(row),
          entries: page.entries,
          more: page.more,
          cursor: this.#feed.seq,
          children: [...children.values()],
        };
      },
      "thread.send": async (client, { threadId, text, steer, command, images, requestId }) => {
        if (requestId) {
          const sent =
            client.sent.get(requestId) ?? this.#store?.messageByRequest(threadId, requestId);
          if (sent) return { messageId: sent };
        }
        const thread = this.#open(threadId).thread;
        if (images?.length && !thread.capabilities.images)
          throw new Error(`${thread.info.harness} does not take images`);
        const sending = sendText(thread, text, {
          steer,
          command,
          // Written at once, since awaiting would let a retry pass the check above too.
          images: images?.length ? savePastedImages(images) : undefined,
          requestId,
        });
        // Awaiting a plain send would let a retry of it pass the check above first.
        const message = sending instanceof Promise ? await sending : sending;
        if (requestId) {
          client.sent.set(requestId, message.id);
          // Only recent retries matter.
          if (client.sent.size > 200) client.sent.delete(client.sent.keys().next().value!);
        }
        return {
          messageId: message.id,
          seq: this.#feed.seq,
          ahead: thread.turnsBefore(message.id),
        };
      },
      "thread.respond": async (_client, { threadId, requestId, response }) => {
        const managed = this.#open(threadId);
        const request = managed.thread.requests.find((open) => open.id === requestId);
        // Answered once. Only requests still open are remembered, so the set stays small.
        const open = new Set(managed.thread.requests.map((pending) => pending.id));
        const answered = new Set(
          [...(this.#answered.get(managed.id) ?? [])].filter((id) => open.has(id)),
        );
        this.#answered.set(managed.id, answered);
        // A second answer, from another client, goes nowhere: not to the harness, and
        // not into the thread's allowances, which an "always allow" would add to.
        if (answered.has(requestId)) return null;
        const first = request !== undefined;
        if (first) answered.add(requestId);
        try {
          await managed.thread.respond(requestId, response);
        } catch (error) {
          // An answer that did not land leaves the request for another.
          if (first) answered.delete(requestId);
          throw error;
        }
        // The transcript keeps what was asked and the answer, for whoever reads it later.
        if (request && first)
          for (const decision of decisions(request, response))
            this.#append(managed.id, (log, seq) => log.decision(seq, decision));
        this.#writer?.schedule();
        return null;
      },
      "thread.seen": async (_client, { threadId, runs }) => {
        const managed = this.manager.get(threadId);
        if (managed && runs > this.#marksOf(threadId).seenRuns) {
          this.#setSeenRuns(threadId, Math.min(runs, managed.runs.length));
          this.#writer?.mark(threadId);
          this.#writer?.schedule();
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
      "thread.unqueue": async (_client, { threadId }) =>
        this.#open(threadId).thread.unqueue() ?? null,
      "thread.switchHarness": async (_client, { threadId, harness, fresh }) =>
        this.#switch(this.#open(threadId), harness, fresh === true),
      "thread.call": async (_client, { threadId, method, args }) => {
        if (!SESSION_CALLS.includes(method))
          throw new RpcError("invalid_request", `thread.call cannot run ${method}`);
        return (await callSession(this.#open(threadId).thread, method, args)) ?? null;
      },
      "thread.command": async (_client, { threadId, command, args }) => {
        await this.#open(threadId).thread.command(command, args);
        return null;
      },
    };
  }

  /** Finding, naming, flagging, forking, and forgetting threads, kept ones included. */
  #keepingMethods(): Pick<
    Handlers,
    | "threads.list"
    | "threads.search"
    | "thread.rename"
    | "thread.flag"
    | "thread.fork"
    | "thread.forget"
  > {
    return {
      "threads.list": async (_client, { scope, query, limit }) => {
        if (this.#store) {
          this.#writer?.flush();
          const rows = this.#store.listThreads({
            scope,
            ...(query ? { query } : {}),
            limit: limit ?? 200,
          });
          await this.#harnessTitles(rows);
          return rows.map((row) => this.#rowListing(row));
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
      "threads.search": async (_client, { query, limit }) => {
        const store = this.#store;
        if (!store) return [];
        this.#writer?.flush();
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
      "thread.rename": async (_client, { threadId, title }) => {
        const name = title.replace(/\s+/g, " ").trim();
        if (!name) throw new RpcError("invalid_request", "A title cannot be empty");
        const { managed, row } = this.#find(threadId);
        if (managed) this.manager.rename(threadId, name);
        else this.#store!.saveThread({ ...row, title: name, named: true });
        return null;
      },
      "thread.flag": async (_client, { threadId, pinned, archived }) => {
        const { managed, row } = this.#find(threadId);
        const flags = managed ? this.#marksOf(threadId).flags : row;
        const next = {
          pinned: pinned ?? flags.pinned,
          archived: archived ?? flags.archived,
        };
        if (managed) {
          this.#marks.set(threadId, { ...this.#marksOf(threadId), flags: next });
          // An archived thread is done with: it ends, with the threads it started.
          if (next.archived && managed.status !== "closed") await this.manager.close(threadId);
          this.#writer?.mark(threadId);
          this.#announce(managed);
          this.#writer?.flush();
          return this.#listing(managed);
        }
        this.#store!.saveThread({ ...row, ...next });
        return this.#rowListing(this.#store!.summary(threadId)!);
      },
      "thread.fork": async (client, { threadId, turn }) => {
        // A stored thread is read where it is kept; forking does not reopen it.
        const { managed: live, row } = this.#find(threadId);
        const source = live
          ? { ...live, info: live.thread.info }
          : { ...row, runs: this.#store!.runs(row.id) };
        const last = turn ?? source.runs.length;
        if (!Number.isInteger(last) || last < 0 || last > source.runs.length)
          throw new RpcError(
            "invalid_request",
            `${threadId} has turns 1 to ${source.runs.length}; fork after one of them`,
          );
        const info = source.info;
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
          // A name to go by until its harness names it.
          title: `${source.title || source.id} (fork)`,
          named: false,
          origin: "user",
          openedBy: client.id,
          fork: { from: source.id, handoff },
        });
        this.#notice(
          managed.id,
          "info",
          `Forked from ${shortThreadId(source.id)} after turn ${last}. Your first message brings ${label(source.harness)} up to date on ${last} ${last === 1 ? "turn" : "turns"}.`,
        );
        return this.#state(managed);
      },
      "thread.forget": async (_client, { threadId }) => {
        const { managed } = this.#find(threadId);
        const ids = [
          ...new Set([
            threadId,
            ...this.manager.descendants(threadId).map((thread) => thread.id),
            ...(this.#store?.descendants(threadId) ?? []),
          ]),
        ];
        if (managed) await this.manager.close(threadId);
        this.orchestrator.forgetTasks(ids);
        for (const id of ids.toReversed()) {
          if (this.manager.get(id)) {
            this.#discarding.add(id);
            this.manager.forget(id);
          } else this.#writer?.delete(id);
        }
        return { forgotten: ids };
      },
    };
  }

  /** Harnesses, operations, commands, and the files a client completes from. */
  #commandMethods(): Pick<
    Handlers,
    | "harnesses.list"
    | "operations.list"
    | "operations.call"
    | "commands.list"
    | "commands.run"
    | "commands.complete"
    | "files.search"
  > {
    return {
      "harnesses.list": async (_client, { id }) => this.#checkHarnesses(id),
      "operations.list": async (client, { threadId }) =>
        this.#operationList(client, threadId ?? null),
      "operations.call": async (client, { threadId, name, input }) => ({
        result: (await this.#runOperation(client, threadId ?? null, name, input)) ?? null,
      }),
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
      "files.search": async (_client, { cwd, query, limit }) =>
        this.#files.search(resolvePath(expandHome(cwd)), query, limit),
    };
  }
}
