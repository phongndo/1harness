import {
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
  type CommandThread,
  type CommandUI,
  type SessionHandle,
} from "../commands/registry.ts";
import type { HarnessId, SessionOptions, Usage, UserInput } from "../core/events.ts";
import { FileIndex, mentionedImages } from "../core/files.ts";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { configDir, stateDir } from "../core/paths.ts";
import { errorMessage, type Thread, type ThreadEvent } from "../core/thread.ts";
import { isThreadIdPrefix, shortThreadId } from "../core/thread-id.ts";
import { formatTokens } from "../core/wording.ts";
import { drivers, findDriver, harnessName as label } from "../drivers/index.ts";
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
  type LoggedEntry,
  type Method,
  type Params,
  type Result,
  type ThreadListing,
  type ThreadState,
  type UiRequest,
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
import { MAX_HTML_BYTES, Media, runsScripts } from "./media.ts";
import { Orchestrator } from "./orchestrator.ts";

/** How long streamed text waits to be written, so a long reply is not rewritten on every chunk. */
const STREAM_FLUSH_MS = 250;
/** How long after a failed write the store is tried again, in case the disk has recovered. */
const STORE_RETRY_MS = 5_000;
/** How many recent events the host keeps for clients catching up after a gap. */
const RECENT_EVENTS = 20_000;
/** How much of them, as sent: one event can carry a whole item or page. */
const RECENT_BYTES = 32 * 1024 * 1024;
/** How many folders' extensions stay loaded with nothing using them. */
const EXTENSION_SETS = 16;
/** How many folders `files.search` keeps an index of, each with its watchers. */
const FILE_INDEXES = 8;
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
  /**
   * The empty thread it left for one still starting, dropped once that one
   * starts, and kept to go back to should it fail.
   */
  left: string | null;
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
  /** It calls from another machine, so the modules it names are not loaded here. */
  remote: boolean;
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

function idleFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The largest image `files.image` sends as it is, in bytes. */
const IMAGE_BYTES = 8 * 1024 * 1024;
/** The largest image file html2term is given to shrink. */
const IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
/** How wide `html_preview` draws a page when the agent names no width, in CSS pixels. */
const PREVIEW_WIDTH = 800;

/** The page a page tool was given, which must be some HTML and not too much. */
/**
 * A page tool's HTML: given whole as `html`, or as `path`, a file where the
 * thread runs, such as one a script wrote.
 */
async function pageInput(input: Record<string, unknown>, cwd: string): Promise<string> {
  const given = input["html"];
  const path = input["path"];
  let html: string;
  if (typeof given === "string" && given.trim() !== "") html = given;
  else if (typeof path === "string" && path.trim() !== "") {
    const file = resolvePath(cwd, path.trim());
    const size = (await stat(file)).size;
    if (size > MAX_HTML_BYTES) throw new Error(`${path} is over ${MAX_HTML_BYTES / 1024} KB`);
    html = await readFile(file, "utf8");
    if (html.trim() === "") throw new Error(`${path} is empty`);
  } else throw new Error("html or path is required");
  if (Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw new Error(`html is over ${MAX_HTML_BYTES / 1024} KB`);
  return html;
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Usage saved before a restart: its context and cost still hold, but its
 * subscription limits are old news, and the harness says them again.
 */
function restoredUsage(usage: Usage | null): Usage | null {
  return usage ? { ...usage, limits: [] } : null;
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
  /** This run of the host, so a client can tell it from the one before a restart. */
  readonly instance = randomUUID();
  readonly manager: ThreadManager;
  readonly orchestrator: Orchestrator;

  readonly tools: ToolServer;
  #options: HostOptions;
  /** Extensions by folder and the modules a client named, each set with its commands. */
  #sets = new Map<string, ExtensionSet>();
  #orchestratorTools: ReadonlyMap<string, { tool: ToolDefinition }> = new Map();
  /** html2term, for images shrunk to their size on screen and pages drawn as pictures. */
  readonly media = new Media();
  /** Pages kept running for clients, through html2term's browser worker. */
  readonly live = new LivePages(
    () => this.media.binary,
    () => this.media.capabilities.browser !== null,
  );
  /** The tools that show the user pages, which every session gets with the orchestrator's. */
  readonly pageTools: ToolDefinition[];
  #listeners = new Set<(event: HostEvent) => void>();
  #recent: HostEvent[] = [];
  /** The size of each recent event, as sent, and of all of them. */
  #recentSizes: number[] = [];
  #recentBytes = 0;
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
  #streamTimer: NodeJS.Timeout | null = null;
  /** Pinned and archived, by thread, as the store keeps them. */
  #flags = new Map<string, { pinned: boolean; archived: boolean }>();
  /** How many of each thread's runs a client has shown. */
  #seenRuns = new Map<string, number>();
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
  /** Admissions a failed write left out, in order. */
  #unadmitted: [ManagedThread, ThreadEvent][] = [];
  #releaseTimer: NodeJS.Immediate | null = null;
  /** Each task as last written. */
  #savedTasks = new Map<string, string>();
  #stopped = false;
  /** Writing the store is failing, which is reported once until a write succeeds. */
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
    });
    this.orchestrator = new Orchestrator(this.manager, options.env);
    this.orchestrator.storedTask = (id) => {
      const row = this.#store?.thread(id);
      return row ? { ...row, runs: this.#store!.runs(id) } : null;
    };
    this.pageTools = this.#pageTools();
    this.#orchestratorTools = new Map(
      [...this.orchestrator.tools, ...this.pageTools].map((tool) => [tool.name, { tool }]),
    );
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
    const { key, folder, flags } = this.#setKey(cwd, modules);
    let set = this.#sets.get(key);
    if (set) {
      // Most recently used last, so the least used go first.
      this.#sets.delete(key);
      this.#sets.set(key, set);
    } else {
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
      this.#trimSets(set);
    }
    return set;
  }

  #setKey(
    cwd: string,
    modules: readonly string[],
  ): { key: string; folder: string; flags: string[] } {
    let folder = resolvePath(cwd);
    try {
      folder = realpathSync(folder);
    } catch {
      // A folder that is gone still names its set.
    }
    const flags = modules.map((path) => resolvePath(cwd, path)).toSorted();
    return { key: [folder, ...flags].join("\0"), folder, flags };
  }

  /**
   * Closes the least recently used sets past `EXTENSION_SETS` that no thread
   * and no connected client uses, as a client that wanders through folders
   * would otherwise keep every folder's extensions loaded.
   */
  #trimSets(newest: ExtensionSet): void {
    if (this.#sets.size <= EXTENSION_SETS) return;
    const used = new Set<ExtensionHost | string>();
    for (const managed of this.manager.list()) {
      const extensions = this.manager.extensionsOf(managed.id);
      if (extensions) used.add(extensions);
    }
    for (const client of this.#clients.values())
      if (client.connected) used.add(this.#setKey(client.cwd, client.extensions).key);
    for (const [key, set] of this.#sets) {
      if (this.#sets.size <= EXTENSION_SETS) break;
      if (set === newest || used.has(key) || used.has(set.host)) continue;
      this.#sets.delete(key);
      void set.ready.then(() => set.host.close()).catch(() => {});
    }
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
      // A thread a client opened and left with nothing in it, without saying goodbye.
      const empty =
        runs.length === 0 &&
        row.origin === "user" &&
        row.forkedFrom === null &&
        row.title === "" &&
        !row.pinned &&
        store.queuedMessages(row.id).length === 0 &&
        store.descendants(row.id).length === 0;
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
          held === 1
            ? "1 queued message was waiting when 1harness stopped. It runs once you send this thread a message; /unqueue takes it back."
            : `${held} queued messages were waiting when 1harness stopped. They run in order once you send this thread a message; /unqueue takes the last one back.`,
        );
      this.#dirty.add(managed.id);
    }
    // Tasks of threads still closed stay in the store, where nothing asks for them.
    this.orchestrator.restoreTasks(store.tasks().filter((task) => this.manager.get(task.parentId)));
    this.#scheduleFlush();
  }

  #restored(row: ThreadRow, runs: RunRecord[]): RestoredThread {
    const store = this.#store!;
    this.#flags.set(row.id, { pinned: row.pinned, archived: row.archived });
    this.#seenRuns.set(row.id, row.seenRuns);
    return {
      id: row.id,
      title: row.title,
      named: row.named ?? false,
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
        usage: restoredUsage(row.usage),
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
      this.#flush();
      this.#reopening.add(id);
      try {
        this.manager.forget(id);
      } finally {
        this.#reopening.delete(id);
      }
    }
    const row = store.thread(id) ?? found;
    const [managed] = this.manager.restore([
      { ...this.#restored({ ...row, state: "parked" }, store.runs(id)), extensions },
    ]);
    if (!managed) return null;
    // Tasks left memory with it; one still in memory has its own, which may be newer.
    if (!existing)
      this.orchestrator.restoreTasks(store.tasks().filter((task) => task.parentId === id));
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

  /** Marks a client as one on a remote listener, from its first request on. */
  markRemote(clientId: string): void {
    this.#client(clientId).remote = true;
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
   * A client left: its picks resolve as dismissed. One that said goodbye is
   * forgotten, and a thread it opened that has nothing in it is dropped; one
   * that only went quiet keeps them, in case it comes back, until it is
   * disconnected again for good.
   */
  async disconnect(clientId: string, options: { discard?: boolean } = {}): Promise<void> {
    const client = this.#clients.get(clientId);
    if (!client) return;
    const discard = options.discard ?? true;
    client.connected = false;
    for (const resolve of client.picks.values()) resolve(null);
    client.picks.clear();
    client.pending.clear();
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
      this.#clients.delete(clientId);
    }
    // Its live pages ran for it alone.
    this.live.closeOwned(clientId);
  }

  /** Whether a client said hello and has not left since, so it can pick up where it was. */
  connected(clientId: string): boolean {
    return this.#clients.get(clientId)?.connected === true;
  }

  /** How many clients are connected: said hello, and have not left. */
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
    if (this.#releaseTimer) clearImmediate(this.#releaseTimer);
    this.live.stop();
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

  /**
   * Writes what changed soon: on the next tick, or for streamed text, which
   * rewrites a growing entry, within `STREAM_FLUSH_MS`.
   */
  #scheduleFlush(streaming = false): void {
    if (!this.#store || this.#stopped) return;
    if (this.#flushTimer) return;
    if (streaming) {
      this.#streamTimer ??= setTimeout(() => {
        this.#streamTimer = null;
        this.#flush();
      }, STREAM_FLUSH_MS);
      return;
    }
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
    if (this.#streamTimer) clearTimeout(this.#streamTimer);
    this.#streamTimer = null;
    try {
      this.#write(store);
    } catch (error) {
      // The threads go on, and what they did stays pending for the next write.
      if (!this.#storeFailed)
        this.#broadcast("error", `Could not save threads: ${errorMessage(error)}`);
      this.#storeFailed = true;
      if (!this.#stopped) {
        this.#streamTimer = setTimeout(() => {
          this.#streamTimer = null;
          this.#flush();
        }, STORE_RETRY_MS);
        // Retrying is no reason to stay up.
        this.#streamTimer.unref();
      }
      return;
    }
    this.#storeFailed = false;
  }

  /** Writes in one transaction, and marks things written only once it commits. */
  #write(store: Store): void {
    const dirty = [...this.#dirty];
    const logs: [ThreadLog, LoggedEntry[]][] = [];
    const tasks: [string, string][] = [];
    const admitted = this.#unadmitted.length;
    store.transaction(() => {
      for (const [managed, event] of this.#unadmitted.slice(0, admitted))
        this.#record(store, managed, event);
      for (const id of dirty) {
        const managed = this.manager.get(id);
        if (!managed) continue;
        store.saveThread(this.#row(managed));
        // Runs change only at the end.
        for (const run of managed.runs.slice(-2)) store.saveRun(id, run);
        for (const [harness, visit] of this.manager.visits(id)) store.saveVisit(id, harness, visit);
        store.saveAllowances(id, managed.thread.allowances);
      }
      for (const [id, log] of this.#logs) {
        const changed = log.unwritten();
        if (changed.length === 0) continue;
        if (this.manager.get(id) || store.thread(id)) store.writeLog(id, changed);
        logs.push([log, changed]);
      }
      // Tasks change seldom; they are written when they do.
      for (const task of this.orchestrator.taskRows()) {
        const key = JSON.stringify(task);
        if (this.#savedTasks.get(task.id) === key) continue;
        store.saveTask(task);
        tasks.push([task.id, key]);
      }
      store.saveSeq(this.#seq);
    });
    this.#unadmitted.splice(0, admitted);
    for (const id of dirty) this.#dirty.delete(id);
    for (const [log, changed] of logs) log.written(changed);
    for (const [id, key] of tasks) this.#savedTasks.set(id, key);
  }

  #row(managed: ManagedThread): ThreadRow {
    const thread = managed.thread;
    const last = managed.runs.at(-1);
    const flags = this.#flags.get(managed.id) ?? { pinned: false, archived: false };
    return {
      id: managed.id,
      title: managed.title,
      named: managed.named,
      cwd: thread.info.cwd,
      harness: managed.harness,
      parentId: managed.parentId,
      parentCallId: managed.parentCallId,
      origin: managed.origin,
      forkedFrom: managed.forkedFrom,
      forkContext: managed.forkContext,
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
      usage: thread.usage,
      createdAt: managed.createdAt,
      updatedAt: last?.endedAt ?? last?.startedAt ?? managed.createdAt,
    };
  }

  /**
   * Admission is written at once, before the harness is sent anything. One that
   * fails waits, with every later one so they stay in order, for the next write.
   */
  #admit(managed: ManagedThread, change: ManagerEvent & { type: "thread.event" }): void {
    const store = this.#store;
    // Only messages are written at once; the rest waits for the next flush.
    if (!store || !change.event.type.startsWith("message.")) return;
    if (this.#unadmitted.length === 0)
      try {
        this.#record(store, managed, change.event);
        return;
      } catch (error) {
        if (!this.#storeFailed)
          this.#broadcast("error", `Could not save threads: ${errorMessage(error)}`);
        this.#storeFailed = true;
      }
    this.#unadmitted.push([managed, change.event]);
    this.#scheduleFlush();
  }

  /** Deletes a thread from the store, with what waits to be saved for it, which would bring it back. */
  #deleteStored(id: string): void {
    this.#unadmitted = this.#unadmitted.filter(([managed]) => managed.id !== id);
    this.#store?.deleteThread(id);
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
    const size = JSON.stringify(numbered).length;
    this.#recent.push(numbered);
    this.#recentSizes.push(size);
    this.#recentBytes += size;
    let drop = 0;
    while (
      this.#recent.length - drop > RECENT_EVENTS ||
      (this.#recentBytes > RECENT_BYTES && this.#recent.length - drop > 1)
    )
      this.#recentBytes -= this.#recentSizes[drop++]!;
    if (drop > 0) {
      this.#recent.splice(0, drop);
      this.#recentSizes.splice(0, drop);
    }
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
        // A thread a client went to has started, so the empty one it left can go;
        // one that failed to start leaves it there to go back to.
        if (event.thread.status !== "starting" && event.thread.status !== "closed")
          for (const client of this.#clients.values())
            if (client.left && client.showing === event.thread.id) {
              const left = client.left;
              client.left = null;
              void this.#discardIfEmpty(left, client);
            }
        this.#dirty.add(event.thread.id);
        this.#scheduleFlush();
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
        this.#admit(managed, event);
        if (change.type !== "item.delta") this.#dirty.add(managed.id);
        this.#scheduleFlush(change.type === "item.delta");
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
        this.#logs.delete(event.threadId);
        this.#answered.delete(event.threadId);
        this.#announced.delete(event.threadId);
        this.#commandsVersion.delete(event.threadId);
        this.#dirty.delete(event.threadId);
        if (this.#discarding.delete(event.threadId)) this.#deleteStored(event.threadId);
        // One being reopened comes straight back, and one stored can be read and
        // reopened; telling clients it went could make one that shows it drop it.
        if (!this.#reopening.has(event.threadId))
          this.#emit({ type: "removed", threadId: event.threadId });
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
    this.#flush();
    // What the store may not have stays in memory.
    if (this.#storeFailed) return;
    for (const id of this.#closedThreads) {
      this.#closedThreads.delete(id);
      const managed = this.manager.get(id);
      if (managed?.status !== "closed") continue;
      const parent = managed.parentId;
      if (parent && this.manager.get(parent) && !this.manager.closing(parent)) continue;
      const ids = [...this.manager.descendants(id).map((child) => child.id), id].toReversed();
      this.orchestrator.forgetTasks(ids);
      for (const gone of ids) {
        this.#savedTasks.delete(gone);
        this.#flags.delete(gone);
        this.#seenRuns.delete(gone);
        this.#reopening.add(gone);
        try {
          this.manager.forget(gone);
        } finally {
          this.#reopening.delete(gone);
        }
      }
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

  /**
   * The tools that put pages in front of the user: `html_render` shows one in
   * the transcript, where each client draws it at its own width, and
   * `html_preview` shows the agent what it will look like.
   */
  #pageTools(): ToolDefinition[] {
    const caller = (thread: Thread): ManagedThread => {
      const managed = this.manager.byThread(thread);
      if (!managed) throw new Error("the calling thread is not managed by 1harness");
      return managed;
    };
    const self =
      "a self-contained HTML document: inline CSS, SVG, and scripts, no network requests";
    const live = this.live.available
      ? "Its scripts run, in Chromium where 1harness runs: animations and canvases play in the transcript, controls take the user's clicks there, and opened whole it takes their keys too."
      : "Scripts do not run where 1harness runs, which has no Chromium: the page is drawn as its HTML and CSS stand.";
    const source = {
      html: { type: "string", description: "The page" },
      path: {
        type: "string",
        description:
          "A file holding the page instead, where the thread runs: one a script wrote, say, building a chart from real data, which keeps the numbers exact and out of your context",
      },
    };
    return [
      {
        name: "html_render",
        description: `Shows HTML to the user in their terminal's transcript, drawn at its width and as tall as the content: a chart, a table, a diagram, a mockup, a small report, a small interactive tool. The page is ${self}, given as html or as a path. ${live} The page's own background is not drawn: the terminal shows through it, so it sits in the transcript as text does; group things with faint translucent fills, such as rgba(127,127,127,0.1), rather than solid ones. It should read well on a dark background (prefers-color-scheme) and at 600 to 900 pixels wide. Call html_preview first to check how it looks.`,
        inputSchema: {
          type: "object",
          properties: {
            ...source,
            title: { type: "string", description: "A few words naming it, shown under it" },
          },
        },
        execute: async (input, context) => {
          const managed = caller(context.thread);
          const html = await pageInput(input, managed.thread.info.cwd);
          const title =
            typeof input["title"] === "string" && input["title"].trim()
              ? input["title"].trim().slice(0, 120)
              : "Page";
          const entry = this.#log(managed.id).html(this.#seq + 1, title, html, Date.now());
          this.#emit({ type: "entry", threadId: managed.id, entry });
          this.#scheduleFlush();
          if (!this.media.binary)
            return "Shown to the user as text: html2term is not installed where 1harness runs, so the page is not drawn.";
          if (runsScripts(html))
            return this.live.available
              ? "Shown live in the transcript: its scripts run, so it moves, and its controls take the user's clicks; opened whole, it takes their keys too."
              : "Shown to the user as text: its scripts need a Chromium where 1harness runs, and there is none.";
          return "Shown to the user in the transcript.";
        },
      },
      {
        name: "html_preview",
        description: `Draws HTML as a PNG and returns it to you, without showing the user, to check a page before html_render: its first frame, for one with scripts. The page is ${self}, given as html or as a path.`,
        inputSchema: {
          type: "object",
          properties: {
            ...source,
            width: {
              type: "number",
              description: `Its width in CSS pixels; ${PREVIEW_WIDTH} by default`,
            },
            dark: {
              type: "boolean",
              description: "Draw it with a dark color scheme; true by default",
            },
          },
        },
        readOnly: true,
        execute: async (input, context) => {
          const html = await pageInput(input, caller(context.thread).thread.info.cwd);
          const width = typeof input["width"] === "number" ? input["width"] : PREVIEW_WIDTH;
          const png = await this.media.html(html, {
            width: Math.min(1600, Math.max(200, width)),
            scale: 1,
            dark: input["dark"] !== false,
          });
          return {
            content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
          };
        },
      },
    ];
  }

  /** A live page's answer, or why it has none, as the client is told. */
  async #page<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new RpcError("render_failed", errorMessage(error));
    }
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
        left: null,
        // Not until it says hello: a request alone is no one staying.
        connected: false,
        picks: new Map(),
        pending: new Map(),
        lookups: new Map(),
        sent: new Map(),
        extensions: [...(this.#options.extensions ?? [])],
        remote: false,
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
      model: managed.thread.info.model,
      effort: managed.thread.info.effort,
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

  /** Threads whose harness was asked for their name, so it is asked once. */
  #titled = new Set<string>();

  /** A stored thread for a listing; one in memory is listed as it is now. */
  #rowListing(row: ThreadSummaryRow): ThreadListing {
    const live = this.manager.get(row.id);
    if (live) return this.#listing(live);
    return {
      id: row.id,
      title: row.title,
      harness: row.harness,
      model: row.info.model,
      effort: row.info.effort,
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
      usage: restoredUsage(row.usage),
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
        // Loading a module runs it here, which no one on another machine may make this host do.
        const named = client.remote ? [] : params.extensions;
        client.extensions = named.map((path) => resolvePath(client.cwd, path));
        client.connected = true;
        const warnings = [...(this.#options.warnings ?? [])];
        if (named.length < params.extensions.length)
          warnings.push("Extensions load only for clients on this machine; yours were left out.");
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
          instance: this.instance,
          seq: this.#seq,
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
      "threads.list": async (_client, { scope, query, limit }) => {
        if (this.#store) {
          this.#flush();
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
      "thread.resume": async (client, { id: typed, harness, settings }) => {
        const id = this.#resolveId(typed);
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
      "thread.attach": async (_client, { threadId: typed, before, limit }) => {
        const threadId = this.#resolveId(typed);
        const managed = this.manager.get(threadId);
        // A stored thread not in memory can be read without being opened.
        const row = managed ? null : this.#store?.thread(threadId);
        if (!managed && !row) throw new RpcError("thread_not_found", `No thread ${threadId}`);
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
            ? await thread.steer(input, undefined, requestId ? { requestId } : {})
            : thread.send(input, undefined, requestId ? { requestId } : {});
        if (requestId) {
          client.sent.set(requestId, message.id);
          // Only recent retries matter.
          if (client.sent.size > 200) client.sent.delete(client.sent.keys().next().value!);
        }
        return { messageId: message.id };
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
          for (const decision of decisions(request, response)) {
            const entry = this.#log(managed.id).decision(this.#seq + 1, decision);
            this.#emit({ type: "entry", threadId: managed.id, entry });
          }
        this.#scheduleFlush();
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
          this.#store!.saveThread({ ...row, title: name, named: true });
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
        // A stored thread is read where it is kept; forking does not reopen it.
        const live = this.manager.get(threadId);
        const row = live ? null : this.#store?.thread(threadId);
        const source = live
          ? {
              id: live.id,
              title: live.title,
              harness: live.harness,
              info: live.thread.info,
              runs: live.runs,
            }
          : row
            ? {
                id: row.id,
                title: row.title,
                harness: row.harness,
                info: row.info,
                runs: this.#store!.runs(row.id),
              }
            : null;
        if (!source) throw new RpcError("thread_not_found", `No thread ${threadId}`);
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
        this.orchestrator.forgetTasks(ids);
        for (const id of ids.toReversed()) {
          this.#savedTasks.delete(id);
          if (this.manager.get(id)) {
            this.#discarding.add(id);
            this.manager.forget(id);
          } else this.#deleteStored(id);
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
      "files.image": async (_client, { path, width, height }) => {
        try {
          const found = await stat(path);
          if (!found.isFile()) return null;
          // Shrunk to the size it shows at, from any format html2term reads.
          if (this.media.binary && found.size <= IMAGE_SOURCE_BYTES) {
            const fitted = await this.media.image(path, width, height);
            if (fitted && fitted.length <= IMAGE_BYTES) return { data: fitted.toString("base64") };
          }
          // Else only a PNG, as the terminal shows it, and not one so large it stalls the feed.
          if (found.size > IMAGE_BYTES) return null;
          const bytes = await readFile(path);
          const png = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
          return png ? { data: bytes.toString("base64") } : null;
        } catch {
          return null;
        }
      },
      "page.open": async (client, { html, width, height, scale, dark }) =>
        this.#page(() =>
          this.live.open(client.id, html, {
            width,
            ...(height ? { height } : {}),
            scale,
            dark,
          }),
        ),
      "page.frame": async (_client, { id }) => this.#page(() => this.live.frame(id)),
      "page.input": async (_client, { id, event }) => this.#page(() => this.live.input(id, event)),
      "page.resize": async (_client, { id, width, height, scale }) =>
        this.#page(() => this.live.resize(id, width, height, scale)),
      "page.close": async (_client, { id }) => {
        await this.live.close(id);
        return null;
      },
      "media.html": async (_client, { html, width, scale, dark, transparent }) => {
        try {
          const png = await this.media.html(html, {
            width,
            scale,
            dark,
            transparent: transparent === true,
          });
          return { data: png.toString("base64") };
        } catch (error) {
          throw new RpcError("render_failed", errorMessage(error));
        }
      },
      "files.search": async (_client, { cwd: asked, query, limit }) => {
        const cwd = resolvePath(expandHome(asked));
        let files = this.#files.get(cwd);
        if (files) {
          // Most recently used last, so the least used close first.
          this.#files.delete(cwd);
          this.#files.set(cwd, files);
        } else {
          for (const [folder, { index }] of this.#files) {
            if (this.#files.size < FILE_INDEXES) break;
            index.close();
            this.#files.delete(folder);
          }
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
