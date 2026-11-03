import {
  fitRuntimeMode,
  isRuntimeMode,
  modeRank,
  type HarnessId,
  type HarnessSession,
  type McpServerConfig,
  type SessionOptions,
} from "../core/events.ts";
import {
  Thread,
  messageText,
  type MessageOrigin,
  type SavedThread,
  type ThreadEvent,
} from "../core/thread.ts";
import { errorMessage } from "../core/errors.ts";
import { oneLine } from "../core/wording.ts";
import { createSession, drivers, findDriver, harnessName as label } from "../drivers/index.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import type { ToolGrant, ToolServer } from "../extensions/tool-server.ts";
import { newThreadId } from "../core/thread-id.ts";
import { combineHandoffs, handoffText, stripHandoff } from "./handoff.ts";

/**
 * `parked` is a thread whose session ended, as an idle one is closed: it keeps
 * its place and its history, and its next message starts a session again.
 */
export type ThreadStatus = "starting" | "idle" | "working" | "waiting" | "parked" | "closed";

/** One turn of a thread, counted from 1, with what started it and how it ended. */
export interface RunRecord {
  index: number;
  turnId: string;
  /** The harness that ran it; a thread can move between harnesses. */
  harness: HarnessId;
  status: "running" | "completed" | "failed" | "interrupted";
  /** What started the run: what the user typed, the task without its brief, or a task's result. */
  input: string;
  /** Who sent that message; null when the harness started the run itself, or it is unknown. */
  origin: MessageOrigin | null;
  /** The last assistant message, which is the run's result. */
  result: string | null;
  /** Files the run changed, in the order it first changed them. */
  files: string[];
  /** Shell commands the run finished, with how each exited. */
  commands: { command: string; exitCode: number | null }[];
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** A live thread with an ID 1harness owns, whatever the harness calls it. */
export interface ManagedThread {
  readonly id: string;
  title: string;
  /**
   * Its title was given, by the user or the agent that started it; until
   * then the harness's name for the session, or its first message, is used.
   */
  named: boolean;
  /** The harness it runs on now; `switchHarness` moves it. */
  harness: HarnessId;
  /** The thread that started this one, for delegated work. */
  readonly parentId: string | null;
  /** The tool call in the parent's thread that started this one, where its harness said which. */
  readonly parentCallId: string | null;
  readonly origin: "user" | "delegated";
  /** The client that opened it, which shows it; null for agents' threads. */
  openedBy: string | null;
  /** The thread it was forked from, whose turns it started with. */
  readonly forkedFrom: string | null;
  /**
   * The handoff of the turns it was forked from, which any harness thread
   * that has seen none of its runs gets first.
   */
  readonly forkContext: string | null;
  readonly thread: Thread;
  readonly createdAt: number;
  status: ThreadStatus;
  runs: RunRecord[];
  /** Why the session ended, when it ended badly. */
  error: string | null;
}

export type ManagerEvent =
  /** A new thread, or with `restored`, one brought back parked after a restart. */
  | { type: "thread.created"; thread: ManagedThread; restored?: boolean }
  /** Status, title, or runs changed. */
  | { type: "thread.updated"; thread: ManagedThread }
  | { type: "thread.event"; threadId: string; event: ThreadEvent }
  /** A session took the thread over: on another harness, or to wake it. */
  | { type: "thread.moved"; thread: ManagedThread; result: SwitchResult; waking: boolean }
  /** Its idle session was closed. */
  | { type: "thread.parked"; thread: ManagedThread }
  /** A closed thread was dropped from memory. */
  | { type: "thread.forgotten"; threadId: string };

export type ManagerListener = (event: ManagerEvent) => void;

export interface CreateThreadOptions {
  harness: HarnessId;
  settings: SessionOptions;
  title?: string;
  /** Whether `title` was given as its name, which no harness's replaces; it is unless said. */
  named?: boolean;
  parentId?: string | null;
  parentCallId?: string | null;
  origin?: "user" | "delegated";
  openedBy?: string | null;
  /** The thread it is forked from, and the handoff of that thread's turns it starts with. */
  fork?: { from: string; handoff: string | null };
}

/**
 * The extensions a thread gets: one set for every thread, or a set chosen by
 * the thread's folder and the client that opened it.
 */
export type Extensions =
  | ExtensionHost
  | ((cwd: string, client: string | null) => Promise<ExtensionHost>);

export interface ManagerOptions {
  version: string;
  extensions: Extensions;
  tools: ToolServer;
  /** Problems with the shared MCP config, reported once each. */
  onWarning?: (text: string) => void;
  /**
   * How long a thread may sit idle before its harness is closed, which frees
   * the process; the next message resumes it. 0 keeps sessions open.
   */
  idleCloseMs?: number;
}

/** A thread as a store kept it, to bring back parked. */
export interface RestoredThread {
  id: string;
  title: string;
  named: boolean;
  harness: HarnessId;
  parentId: string | null;
  parentCallId: string | null;
  origin: "user" | "delegated";
  forkedFrom: string | null;
  forkContext: string | null;
  createdAt: number;
  error: string | null;
  runs: RunRecord[];
  visits: Map<HarnessId, Visit>;
  seenWithoutHandoff: number | null;
  thread: SavedThread;
  /** Its extensions, already loaded; the manager's own when it has one set. */
  extensions?: ExtensionHost;
}

/** What a run that was going when its host stopped says; nobody knows how it ended. */
export const UNKNOWN_OUTCOME = "1harness stopped while this turn ran, so how it ended is unknown";

/** Thirty minutes. */
export const IDLE_CLOSE_MS = 30 * 60 * 1000;

/** How a thread moved to another harness, for clients to describe. */
export interface SwitchResult {
  from: HarnessId;
  to: HarnessId;
  /** The harness picked up its own earlier thread rather than starting one. */
  resumed: boolean;
  /** Why its earlier thread could not be picked up, when a new one started instead. */
  resumeError: string | null;
  /** How many turns the handoff carries to the harness's next message. */
  handedOver: number;
  /**
   * The resumed thread as the thread left it: how much context it held, when
   * known, and how long ago it was last used. A large or long-idle one costs
   * more to pick up than it looks. Null for a new thread.
   */
  resumedContext: { tokens: number | null; idleMs: number } | null;
}

/** Where a thread left a harness, so going back resumes that harness's own thread. */
export interface Visit {
  /** The harness's own thread ID, or null when it never assigned one. */
  native: string | null;
  /** How many of the thread's runs that harness's own thread has seen. */
  runs: number;
  model: string | null;
  effort: string | null;
  /** How much context its thread held when the thread left, when the harness said. */
  contextTokens: number | null;
  leftAt: number;
}

/** A thread that cannot run as narrowly as asked; it is closed rather than started. */
export class ModeError extends Error {
  readonly code:
    | "runtime_mode_unavailable"
    | "plan_mode_unavailable"
    | "runtime_mode_escalation_denied";

  constructor(code: ModeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const TITLE_LENGTH = 48;

/** A one-line title from the start of a message. */
export function titleFrom(text: string): string {
  return oneLine(text, TITLE_LENGTH);
}

/**
 * Owns every live thread: many at once, on any harness, each with an app ID,
 * a parent where one thread started another, a status, and its runs. Clients
 * and the orchestrator tools reach threads only through it, so a thread keeps
 * running while no client shows it.
 */
export class ThreadManager {
  #options: ManagerOptions;
  #threads = new Map<string, ManagedThread>();
  #byThread = new Map<Thread, ManagedThread>();
  #listeners = new Set<ManagerListener>();
  #cleanups = new Map<string, () => void>();
  /** The MCP servers each thread's sessions get, the tool server's grant among them. */
  #servers = new Map<string, Record<string, McpServerConfig>>();
  /** Harnesses each thread ran on before, by harness. */
  #visits = new Map<string, Map<HarnessId, Visit>>();
  /** Threads moving to another harness, and the harness they are moving to. */
  #switching = new Map<string, HarnessId>();
  /**
   * For a thread whose harness has a handoff it has not been sent yet, how many
   * runs its own thread had seen without it. Leaving before the handoff goes
   * out must not count the turns the handoff would have told it.
   */
  #seenWithoutHandoff = new Map<string, number>();
  /** Threads being closed, children first, so work no longer goes to them. */
  #closing = new Set<string>();
  #warned = new Set<string>();
  /** Each thread's grant to the tool server, which its sessions use. */
  #grants = new Map<string, ToolGrant>();
  /** Each thread's extensions. */
  #extensions = new Map<string, ExtensionHost>();
  /** What each thread looked like when last announced. */
  #keys = new Map<string, string>();
  /** Idle threads whose sessions close when the timer fires. */
  #idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ManagerOptions) {
    this.#options = options;
  }

  subscribe(listener: ManagerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(id: string): ManagedThread | undefined {
    return this.#threads.get(id);
  }

  /** The managed thread behind a `Thread`, such as the one a tool call came from. */
  byThread(thread: Thread): ManagedThread | undefined {
    return this.#byThread.get(thread);
  }

  /** Every thread, oldest first, closed ones included. */
  list(): ManagedThread[] {
    return [...this.#threads.values()];
  }

  /** Threads this one started, and the ones they started. */
  descendants(id: string): ManagedThread[] {
    const children = this.list().filter((thread) => thread.parentId === id);
    return children.flatMap((child) => [child, ...this.descendants(child.id)]);
  }

  /** The thread is being closed, though it may not have finished closing. */
  closing(id: string): boolean {
    return this.#closing.has(id) || this.#threads.get(id)?.status === "closed";
  }

  /** How many delegations deep a thread is; a user's thread is 0. */
  depth(id: string): number {
    const parent = this.#threads.get(id)?.parentId;
    return parent ? 1 + this.depth(parent) : 0;
  }

  /**
   * Starts a session and its thread. The thread is listed as `starting` at
   * once, so clients can show it while the harness comes up.
   */
  async create(options: CreateThreadOptions): Promise<ManagedThread> {
    // An agent's thread gets the extensions of the thread that started it.
    const parent = options.parentId ? this.#extensions.get(options.parentId) : undefined;
    const extensions =
      parent ?? (await this.#extensionsFor(options.settings.cwd, options.openedBy ?? null));
    const id = newThreadId();
    const servers = await this.#connectServers(id, extensions);
    let created: Thread | null = null;
    const toolPolicy = extensions.toolPolicy(() => created);
    let thread: Thread;
    try {
      thread = new Thread(
        createSession(
          options.harness,
          { ...options.settings, ...sessionExtras(servers, toolPolicy) },
          this.#env(),
        ),
      );
    } catch (error) {
      this.#disconnectServers(id);
      throw error;
    }
    created = thread;
    this.#grants.get(id)?.bind(thread);
    const managed: ManagedThread = {
      id,
      title: options.title ?? "",
      named: options.named ?? Boolean(options.title),
      harness: options.harness,
      parentId: options.parentId ?? null,
      parentCallId: options.parentCallId ?? null,
      origin: options.origin ?? "user",
      openedBy: options.openedBy ?? null,
      forkedFrom: options.fork?.from ?? null,
      forkContext: options.fork?.handoff ?? null,
      thread,
      createdAt: Date.now(),
      status: "starting",
      runs: [],
      error: null,
    };
    // Its harness's own thread has seen none of the turns the fork's handoff carries.
    if (options.fork?.handoff) {
      thread.setHandoff(options.fork.handoff);
      this.#seenWithoutHandoff.set(managed.id, 0);
    }
    this.#adopt(managed, extensions);
    this.#emit({ type: "thread.created", thread: managed });
    try {
      await thread.start();
      if (!thread.session) throw new Error(`${label(managed.harness)} ended as it started`);
      await holdModes(thread.session, managed.harness, options.settings);
    } catch (error) {
      managed.error = errorMessage(error);
      await this.close(managed.id);
      throw error;
    }
    this.#refresh(managed);
    return managed;
  }

  async #extensionsFor(cwd: string, client: string | null): Promise<ExtensionHost> {
    const extensions = this.#options.extensions;
    return typeof extensions === "function" ? extensions(cwd, client) : extensions;
  }

  /** The extensions a thread runs with. */
  extensionsOf(id: string): ExtensionHost | undefined {
    return this.#extensions.get(id);
  }

  /**
   * Connects a thread's MCP servers, which its sessions get, the tool server's
   * grant among them; the caller binds the grant to the thread. Problems with
   * the shared config are reported once.
   */
  async #connectServers(
    id: string,
    extensions: ExtensionHost,
  ): Promise<Record<string, McpServerConfig>> {
    const mcp = await extensions.sessionServers(this.#options.tools);
    for (const warning of mcp.warnings) {
      if (this.#warned.has(warning)) continue;
      this.#warned.add(warning);
      this.#options.onWarning?.(`MCP config: ${warning}`);
    }
    this.#servers.set(id, mcp.servers);
    if (mcp.grant) this.#grants.set(id, mcp.grant);
    return mcp.servers;
  }

  #disconnectServers(id: string): void {
    this.#grants.get(id)?.revoke();
    this.#grants.delete(id);
    this.#servers.delete(id);
  }

  /** Connects a thread to the manager and the extensions, and lists it. */
  #adopt(managed: ManagedThread, extensions: ExtensionHost): void {
    const thread = managed.thread;
    this.#extensions.set(managed.id, extensions);
    this.#threads.set(managed.id, managed);
    this.#byThread.set(thread, managed);
    const unsubscribe = thread.subscribe((event) => this.#apply(managed, event));
    thread.setWaker(async () => {
      await this.wake(managed.id);
    });
    const detach = extensions.attach(thread);
    this.#cleanups.set(managed.id, () => {
      unsubscribe();
      detach();
      this.#disconnectServers(managed.id);
      this.#visits.delete(managed.id);
      this.#seenWithoutHandoff.delete(managed.id);
    });
  }

  /**
   * Brings back threads a store kept, parked: their next message starts a
   * session. A run that was going when the host stopped is marked
   * interrupted, its outcome unknown; it is never sent again.
   */
  restore(saved: readonly RestoredThread[]): ManagedThread[] {
    const restored: ManagedThread[] = [];
    for (const entry of saved) {
      if (this.#threads.has(entry.id)) continue;
      const { visits, seenWithoutHandoff, extensions: loaded, thread: kept, ...fields } = entry;
      const runs = fields.runs.map((run) =>
        run.status === "running"
          ? {
              ...run,
              status: "interrupted" as const,
              error: UNKNOWN_OUTCOME,
              endedAt: run.endedAt ?? Date.now(),
            }
          : run,
      );
      const managed: ManagedThread = {
        ...fields,
        openedBy: null,
        thread: new Thread(null, kept),
        status: "parked",
        runs,
      };
      const extensions =
        loaded ??
        (typeof this.#options.extensions === "function" ? undefined : this.#options.extensions);
      if (!extensions) throw new Error(`No extensions loaded for ${entry.id}`);
      this.#adopt(managed, extensions);
      if (visits.size > 0) this.#visits.set(entry.id, new Map(visits));
      if (seenWithoutHandoff !== null) this.#seenWithoutHandoff.set(entry.id, seenWithoutHandoff);
      restored.push(managed);
      this.#emit({ type: "thread.created", thread: managed, restored: true });
      this.#refresh(managed);
    }
    return restored;
  }

  /** The harnesses a thread ran on before, for a store to keep. */
  visits(id: string): ReadonlyMap<HarnessId, Visit> {
    return this.#visits.get(id) ?? new Map();
  }

  /** How many runs its harness's own thread saw without its pending handoff. */
  seenWithoutHandoff(id: string): number | null {
    return this.#seenWithoutHandoff.get(id) ?? null;
  }

  /**
   * Closes every session but keeps the threads, as when the host stops: each
   * parks, and a turn still running is interrupted.
   */
  async parkAll(): Promise<void> {
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    await Promise.all(
      this.list()
        .filter((managed) => managed.status !== "closed" && managed.thread.session)
        .map((managed) => managed.thread.park(true).catch(() => {})),
    );
  }

  /**
   * Moves a thread onto another harness, keeping its ID, runs, queue, and the
   * threads it started. Going back to a harness the thread ran on before
   * resumes that harness's own thread, and a new one starts when that fails,
   * there is none, or `fresh` asks for one; `fresh` also restarts the current
   * harness. The harness's next message carries a handoff of the turns it has
   * not seen. The thread keeps its permission and plan modes; a harness that
   * cannot run that narrowly is refused, and the thread stays where it was, as
   * it does when the harness cannot start. Work the old harness runs in the
   * background would stop with it, so the thread does not move while it runs.
   */
  async switchHarness(
    id: string,
    harness: HarnessId,
    options: { fresh?: boolean } = {},
  ): Promise<SwitchResult> {
    const managed = this.#threads.get(id);
    if (!managed || this.closing(id)) throw new Error(`No open thread ${id}`);
    const from = managed.harness;
    const fresh = options.fresh === true;
    if (harness === from && !fresh) throw new Error(`${id} already runs on ${harness}`);
    if (!findDriver(harness))
      throw new Error(
        `No harness named ${harness}; try ${drivers()
          .map((driver) => driver.id)
          .join(", ")}`,
      );
    const earlier = harness === from ? undefined : this.#visits.get(id)?.get(harness);
    return this.#move(managed, harness, earlier && !fresh ? earlier : undefined);
  }

  /**
   * Starts a session for a parked thread, on the harness it ran on: resuming
   * that harness's own thread where it can, with a handoff of anything it has
   * not seen, and a new thread with a handoff of every turn otherwise, as for
   * an agent that cannot resume.
   */
  async wake(id: string): Promise<SwitchResult | null> {
    const managed = this.#threads.get(id);
    if (!managed || this.closing(id)) throw new Error(`No open thread ${id}`);
    const thread = managed.thread;
    if (!thread.parked) return null;
    if (this.#switching.has(id)) throw new Error(`${id} is already starting`);
    const own = this.#visit(managed, Date.now());
    return this.#move(managed, managed.harness, own.native ? own : undefined, true);
  }

  /**
   * Closes an idle thread's session, keeping the thread; its next message
   * resumes it. Work the harness runs in the background would stop with it, so
   * a thread with any is left open.
   */
  async park(id: string): Promise<boolean> {
    const managed = this.#threads.get(id);
    if (!managed || this.closing(id) || this.#switching.has(id)) return false;
    const thread = managed.thread;
    if (!thread.session || !thread.idle) return false;
    if ((thread.session.backgroundTasks?.() ?? []).length > 0) return false;
    await thread.park();
    this.#emit({ type: "thread.parked", thread: managed });
    return true;
  }

  /** Names a thread for what it is doing, as its harness named it, unless it was given a name. */
  retitle(id: string, title: string): void {
    const managed = this.#threads.get(id);
    if (!managed || managed.named || managed.title === title) return;
    managed.title = title;
    this.#refresh(managed);
  }

  /** Renames a thread. */
  rename(id: string, title: string): void {
    const managed = this.#threads.get(id);
    if (!managed) throw new Error(`No thread ${id}`);
    managed.title = title;
    managed.named = true;
    this.#refresh(managed);
  }

  /** Drops a closed thread from memory, such as one with nothing in it. */
  forget(id: string): void {
    const managed = this.#threads.get(id);
    if (!managed || managed.status !== "closed") return;
    this.#threads.delete(id);
    this.#byThread.delete(managed.thread);
    this.#keys.delete(id);
    this.#extensions.delete(id);
    this.#emit({ type: "thread.forgotten", threadId: id });
  }

  /** How many of the thread's runs its harness's own thread has seen. */
  #seen(managed: ManagedThread): number {
    return managed.thread.handoff === null
      ? managed.runs.length
      : (this.#seenWithoutHandoff.get(managed.id) ?? managed.runs.length);
  }

  /** Where the thread is on its harness now, as it would leave it. */
  #visit(managed: ManagedThread, at: number): Visit {
    const thread = managed.thread;
    return {
      native: thread.info.threadId,
      runs: this.#seen(managed),
      model: thread.info.model,
      effort: thread.info.effort,
      contextTokens: thread.usage?.contextTokens ?? null,
      leftAt: at,
    };
  }

  /**
   * Moves a thread onto a session of `harness`: resuming `earlier`, that
   * harness's own thread, where given, and a new thread when that fails or
   * there is none. `waking` starts a parked thread on its own harness.
   */
  async #move(
    managed: ManagedThread,
    harness: HarnessId,
    earlier: Visit | undefined,
    waking = false,
  ): Promise<SwitchResult> {
    const id = managed.id;
    const from = managed.harness;
    if (this.#switching.has(id)) throw new Error(`${id} is already moving to another harness`);
    // Its first session is still starting; moving now would race that start.
    if (managed.status === "starting") throw new Error(`${id} is still starting`);
    const thread = managed.thread;
    if (thread.busy || thread.requests.length > 0)
      throw new Error(`${id} is working; wait for the turn to end or stop it first`);
    const background = thread.session?.backgroundTasks?.() ?? [];
    if (background.length > 0)
      throw new Error(
        `${id} still runs background work on ${from}, which moving would stop: ${background.join("; ")}. Wait for it to finish first`,
      );

    const info = thread.info;
    const same = harness === from;
    const now = Date.now();
    const leaving = this.#visit(managed, now);
    // As narrow as the thread runs now, which may be narrower than it was asked to.
    const settings: SessionOptions = {
      cwd: info.cwd,
      model: same ? info.model : (earlier?.model ?? null),
      effort: same ? info.effort : (earlier?.effort ?? null),
      runtimeMode: info.runtimeMode,
      interactionMode: info.interactionMode,
      resume: null,
    };
    const extensions = this.#extensions.get(id)!;
    const toolPolicy = extensions.toolPolicy(() => thread);
    const plans = [
      ...(earlier?.native ? [{ resume: earlier.native, seen: earlier.runs }] : []),
      { resume: null, seen: 0 },
    ].map((plan) => {
      const unseen = managed.runs.slice(plan.seen);
      const handoff = combineHandoffs(
        // A harness thread that saw none of a fork's runs never got the turns it was forked from.
        plan.seen === 0 ? managed.forkContext : null,
        handoffText({
          threadId: id,
          to: harness,
          runs: unseen,
          resumed: plan.resume !== null,
          label,
        }),
      );
      return { ...plan, unseen, handoff, asked: { ...settings, resume: plan.resume } };
    });

    this.#switching.set(id, harness);
    this.#refresh(managed);
    try {
      // A thread brought back after a restart connects its servers on first use.
      let servers = this.#servers.get(id);
      if (!servers) {
        servers = await this.#connectServers(id, extensions);
        this.#grants.get(id)?.bind(thread);
      }
      const extras = sessionExtras(servers, toolPolicy);
      // One switch tries every plan, so nothing sent meanwhile reaches the old harness.
      const { attempt, failures } = await thread.replaceSession(
        plans.map((plan) => ({
          create: () => createSession(harness, { ...plan.asked, ...extras }, this.#env()),
          handoff: plan.handoff,
          prepare: async (next) => {
            // An agent that cannot resume may start a new thread instead, and say nothing.
            if (plan.resume !== null && next.info.threadId !== plan.resume)
              throw new Error(`${label(harness)} started a new session instead of resuming it`);
            await holdModes(next, harness, plan.asked);
          },
          // A narrower mode is no more available in a new thread than in a resumed one.
          fallThrough: (error) => !(error instanceof ModeError),
        })),
      );
      const plan = plans[attempt]!;
      if (!waking) {
        const visits = this.#visits.get(id) ?? new Map<HarnessId, Visit>();
        visits.set(from, leaving);
        this.#visits.set(id, visits);
      }
      if (plan.handoff) this.#seenWithoutHandoff.set(id, plan.seen);
      else this.#seenWithoutHandoff.delete(id);
      const resumed = plan.resume !== null && earlier !== undefined;
      const result: SwitchResult = {
        from,
        to: harness,
        resumed,
        resumeError: attempt > 0 && failures[0] !== undefined ? errorMessage(failures[0]) : null,
        handedOver: plan.handoff ? plan.unseen.filter((run) => run.status !== "running").length : 0,
        resumedContext:
          resumed && !waking
            ? { tokens: earlier.contextTokens, idleMs: now - earlier.leftAt }
            : null,
      };
      this.#emit({ type: "thread.moved", thread: managed, result, waking });
      return result;
    } finally {
      this.#switching.delete(id);
      this.#refresh(managed);
    }
  }

  #env() {
    return { version: this.#options.version };
  }

  /**
   * Waits until a thread has nothing left to do: no run, nothing queued, and
   * no open request. Resolves early when `timeoutMs` passes.
   */
  wait(id: string, timeoutMs: number): Promise<{ thread: ManagedThread; timedOut: boolean }> {
    const managed = this.#threads.get(id);
    if (!managed) return Promise.reject(new Error(`No thread ${id}`));
    // The thread knows the moment a message is sent, before the harness reports a turn.
    // A parked one has nothing running, and wakes only when sent something.
    const settled = () =>
      managed.status === "closed" ||
      managed.status === "parked" ||
      managed.thread.closed ||
      managed.thread.idle;
    return new Promise((resolve) => {
      if (settled()) {
        resolve({ thread: managed, timedOut: false });
        return;
      }
      const done = (timedOut: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve({ thread: managed, timedOut });
      };
      const timer = setTimeout(() => done(true), timeoutMs);
      // Any event of the thread's can settle it, such as a message that failed to start.
      const unsubscribe = this.subscribe((event) => {
        const mine =
          event.type === "thread.event" || event.type === "thread.forgotten"
            ? event.threadId === managed.id
            : event.thread === managed;
        if (mine && settled()) done(false);
      });
    });
  }

  /** Closes a thread and every thread it started. */
  async close(id: string): Promise<void> {
    const managed = this.#threads.get(id);
    if (!managed) return;
    await this.#closeEach([...this.descendants(id).toReversed(), managed]);
  }

  async closeAll(): Promise<void> {
    await this.#closeEach(this.list().toReversed());
  }

  /** Closes threads in order, all of them marked as closing first. */
  async #closeEach(threads: ManagedThread[]): Promise<void> {
    const open = threads.filter((managed) => !this.closing(managed.id));
    for (const managed of open) this.#closing.add(managed.id);
    for (const managed of open) {
      // Listeners still see the session close, so views and extensions wind down.
      await managed.thread.close().catch(() => {});
      this.#release(managed.id);
      this.#closing.delete(managed.id);
      if (managed.status === "closed") continue;
      // A harness that ends without saying so.
      this.#endRun(managed, null);
      managed.status = "closed";
      this.#emit({ type: "thread.updated", thread: managed });
    }
  }

  /** Disconnects a closed thread from the manager, extensions, and tool server. */
  #release(id: string): void {
    this.#cleanups.get(id)?.();
    this.#cleanups.delete(id);
    const timer = this.#idleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#idleTimers.delete(id);
  }

  /** Ends a run the session closed under: interrupted, or failed with the session's error. */
  #endRun(managed: ManagedThread, error: string | null): void {
    const run = managed.runs.at(-1);
    if (run?.status !== "running") return;
    run.status = error ? "failed" : "interrupted";
    run.error = error;
    run.endedAt = Date.now();
  }

  #apply(managed: ManagedThread, event: ThreadEvent): void {
    const run = managed.runs.at(-1);
    switch (event.type) {
      case "turn.started":
        managed.runs.push(newRun(managed, { turnId: event.turnId }));
        break;
      case "turn.ended":
        if (run && run.status === "running") {
          run.status = event.status;
          run.error = event.error;
          run.endedAt = Date.now();
        }
        break;
      case "item.started":
      case "item.completed": {
        const item = event.item;
        if (item.kind === "user_message" && run?.status === "running" && run.input === "") {
          const message = item.inputId ? managed.thread.message(item.inputId) : undefined;
          run.input = message ? messageText(message) : stripHandoff(item.text);
          run.origin = message?.origin ?? null;
          if (!managed.title) managed.title = titleFrom(run.input);
        }
        if (item.kind === "assistant_message" && event.type === "item.completed" && run) {
          if (item.text.trim()) run.result = item.text;
        }
        if (item.kind === "command" && event.type === "item.completed" && run)
          run.commands.push({ command: item.command, exitCode: item.exitCode });
        if (item.kind === "file_change" && item.status === "completed" && run) {
          for (const change of item.changes) {
            const path = change.movePath ?? change.path;
            if (!run.files.includes(path)) run.files.push(path);
          }
        }
        break;
      }
      case "session.updated":
        // The harness's name for what the thread is doing, unless one was given.
        if (!managed.named && event.info.title && event.info.title !== managed.title)
          managed.title = event.info.title;
        break;
      case "session.replaced":
        // The session that took over may come from code other than switchHarness.
        managed.harness = this.#switching.get(managed.id) ?? managed.thread.info.harness;
        managed.error = null;
        // The new session runs the thread now, though the old one may still be closing.
        this.#switching.delete(managed.id);
        break;
      case "error":
        // A message that could not start its turn is a run that failed at once.
        if (event.unsent) {
          const failed = newRun(managed, {
            status: "failed",
            input: messageText(event.unsent),
            origin: event.unsent.origin,
            error: event.message,
          });
          failed.endedAt = failed.startedAt;
          managed.runs.push(failed);
          if (!managed.title) managed.title = titleFrom(failed.input);
        }
        break;
      case "session.closed":
        managed.error = event.error;
        this.#endRun(managed, event.error);
        // A thread whose session ended on its own parks; only closing it ends it.
        // Later listeners, such as extensions', still have to see this event.
        if (managed.thread.closed) queueMicrotask(() => this.#release(managed.id));
        break;
    }
    this.#emit({ type: "thread.event", threadId: managed.id, event });
    this.#refresh(managed);
  }

  /** Recomputes the status, announcing a change in what listeners track. */
  #refresh(managed: ManagedThread): void {
    if (managed.status === "closed") return;
    const thread = managed.thread;
    managed.status = thread.closed
      ? "closed"
      : this.#switching.has(managed.id)
        ? "starting"
        : thread.parked
          ? "parked"
          : thread.requests.length > 0
            ? "waiting"
            : thread.idle
              ? "idle"
              : "working";
    this.#idle(managed);
    const run = managed.runs.at(-1);
    const key = [
      managed.status,
      managed.title,
      managed.named,
      managed.runs.length,
      run?.status,
      run?.result,
      managed.error,
    ].join("\0");
    if (this.#keys.get(managed.id) === key) return;
    this.#keys.set(managed.id, key);
    this.#emit({ type: "thread.updated", thread: managed });
  }

  /** Starts the idle timer for a thread that went idle, and stops it for one that did not. */
  #idle(managed: ManagedThread): void {
    const ms = this.#options.idleCloseMs ?? IDLE_CLOSE_MS;
    const timer = this.#idleTimers.get(managed.id);
    if (managed.status !== "idle" || ms <= 0) {
      if (timer) clearTimeout(timer);
      this.#idleTimers.delete(managed.id);
      return;
    }
    if (timer) return;
    const next = setTimeout(() => {
      this.#idleTimers.delete(managed.id);
      void this.park(managed.id)
        .catch((error: unknown) => {
          this.#options.onWarning?.(
            `Could not close the idle ${label(managed.harness)} session of ${managed.id}: ${errorMessage(error)}`,
          );
          return false;
        })
        .then((parked) => {
          // Background work, or a session that would not close, keeps it open; it is tried again later.
          if (!parked && managed.status === "idle") this.#idle(managed);
        });
    }, ms);
    next.unref();
    this.#idleTimers.set(managed.id, next);
  }

  #emit(event: ManagerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

/** A thread's next run, started now, with nothing in it yet but what `fields` says. */
function newRun(managed: ManagedThread, fields: Partial<RunRecord>): RunRecord {
  return {
    index: managed.runs.length + 1,
    turnId: "",
    harness: managed.harness,
    status: "running",
    input: "",
    origin: null,
    result: null,
    files: [],
    commands: [],
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    ...fields,
  };
}

/** What every session of a thread is started with besides its own settings. */
function sessionExtras(
  servers: Record<string, McpServerConfig>,
  toolPolicy: SessionOptions["toolPolicy"] | null | undefined,
): Partial<SessionOptions> {
  return {
    ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
  };
}

/**
 * Makes a started thread run no freer than its settings ask, whatever its
 * harness: a harness without the mode runs the broadest one it has below it,
 * and one that cannot go that narrow, or into plan mode, is refused. A harness
 * that lists no modes keeps its own and asks through its own approvals.
 */
async function holdModes(
  session: HarnessSession,
  harness: HarnessId,
  settings: SessionOptions,
): Promise<void> {
  const asked = settings.runtimeMode;
  const offered = session.capabilities.runtimeModes;
  // Drivers load without type checks, so one that lists other modes fails here, not later.
  const unknown = offered.filter((mode) => !isRuntimeMode(mode));
  if (unknown.length > 0)
    throw new Error(`The ${harness} driver lists unknown modes: ${unknown.join(", ")}`);
  if (offered.length > 0) {
    const target = fitRuntimeMode(asked, offered);
    if (!target)
      throw new ModeError(
        "runtime_mode_unavailable",
        `${harness} has no mode as narrow as ${asked}`,
      );
    if (modeRank(session.info.runtimeMode) > modeRank(target)) await session.setRuntimeMode(target);
  }
  const plan = settings.interactionMode === "plan";
  if (plan && session.info.interactionMode !== "plan") {
    if (!session.capabilities.planMode)
      throw new ModeError("plan_mode_unavailable", `${harness} has no plan mode`);
    await session.setInteractionMode("plan");
  }
  const { runtimeMode, interactionMode } = session.info;
  if (modeRank(runtimeMode) > modeRank(asked) || (plan && interactionMode !== "plan"))
    throw new ModeError(
      "runtime_mode_escalation_denied",
      `${harness} would run ${runtimeMode}${interactionMode === "plan" ? " in plan mode" : ""}, more than asked`,
    );
}
