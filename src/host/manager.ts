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
  errorMessage,
  messageText,
  type MessageOrigin,
  type ThreadEvent,
} from "../core/thread.ts";
import { createSession, drivers, findDriver } from "../drivers/index.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import type { ToolServer } from "../extensions/tool-server.ts";
import { handoffText } from "./handoff.ts";

export type ThreadStatus = "starting" | "idle" | "working" | "waiting" | "closed";

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
  /** The harness it runs on now; `switchHarness` moves it. */
  harness: HarnessId;
  /** The thread that started this one, for delegated work. */
  readonly parentId: string | null;
  /** The tool call in the parent's thread that started this one, where its harness said which. */
  readonly parentCallId: string | null;
  readonly origin: "user" | "delegated";
  readonly thread: Thread;
  readonly createdAt: number;
  status: ThreadStatus;
  runs: RunRecord[];
  /** Why the session ended, when it ended badly. */
  error: string | null;
}

export type ManagerEvent =
  | { type: "thread.created"; thread: ManagedThread }
  /** Status, title, or runs changed. */
  | { type: "thread.updated"; thread: ManagedThread }
  | { type: "thread.event"; threadId: string; event: ThreadEvent };

export type ManagerListener = (event: ManagerEvent) => void;

export interface CreateThreadOptions {
  harness: HarnessId;
  settings: SessionOptions;
  title?: string;
  parentId?: string | null;
  parentCallId?: string | null;
  origin?: "user" | "delegated";
}

export interface ManagerOptions {
  version: string;
  extensions: ExtensionHost;
  tools: ToolServer;
  /** Problems with the shared MCP config, reported once each. */
  onWarning?: (text: string) => void;
}

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
interface Visit {
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
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
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
  #counter = 0;
  /** What each thread looked like when last announced. */
  #keys = new Map<string, string>();

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
    const extensions = this.#options.extensions;
    const mcp = await extensions.sessionServers(this.#options.tools);
    for (const warning of mcp.warnings) {
      if (this.#warned.has(warning)) continue;
      this.#warned.add(warning);
      this.#options.onWarning?.(`MCP config: ${warning}`);
    }
    let created: Thread | null = null;
    const toolPolicy = extensions.toolPolicy(() => created);
    const settings = {
      ...options.settings,
      ...(Object.keys(mcp.servers).length > 0 ? { mcpServers: mcp.servers } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
    };
    let thread: Thread;
    try {
      thread = new Thread(
        createSession(options.harness, settings, { version: this.#options.version }),
      );
    } catch (error) {
      mcp.grant?.revoke();
      throw error;
    }
    created = thread;
    mcp.grant?.bind(thread);
    const managed: ManagedThread = {
      id: `t${++this.#counter}`,
      title: options.title ?? "",
      harness: options.harness,
      parentId: options.parentId ?? null,
      parentCallId: options.parentCallId ?? null,
      origin: options.origin ?? "user",
      thread,
      createdAt: Date.now(),
      status: "starting",
      runs: [],
      error: null,
    };
    this.#threads.set(managed.id, managed);
    this.#byThread.set(thread, managed);
    this.#servers.set(managed.id, mcp.servers);
    const unsubscribe = thread.subscribe((event) => this.#apply(managed, event));
    const detach = extensions.attach(thread);
    this.#cleanups.set(managed.id, () => {
      unsubscribe();
      detach();
      mcp.grant?.revoke();
      this.#servers.delete(managed.id);
      this.#visits.delete(managed.id);
      this.#seenWithoutHandoff.delete(managed.id);
    });
    this.#emit({ type: "thread.created", thread: managed });
    try {
      await thread.start();
      await holdModes(thread.session, managed.harness, options.settings);
    } catch (error) {
      managed.error = errorMessage(error);
      await this.close(managed.id);
      throw error;
    }
    this.#refresh(managed);
    return managed;
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
    options: { model?: string | null; effort?: string | null; fresh?: boolean } = {},
  ): Promise<SwitchResult> {
    const managed = this.#threads.get(id);
    if (!managed || this.closing(id)) throw new Error(`No open thread ${id}`);
    const from = managed.harness;
    const fresh = options.fresh === true;
    if (harness === from && !fresh) throw new Error(`${id} already runs on ${harness}`);
    if (this.#switching.has(id)) throw new Error(`${id} is already moving to another harness`);
    const thread = managed.thread;
    if (thread.busy || thread.requests.length > 0)
      throw new Error(`${id} is working; wait for the turn to end or stop it first`);
    const background = thread.session.backgroundTasks?.() ?? [];
    if (background.length > 0)
      throw new Error(
        `${id} still runs background work on ${from}, which moving would stop: ${background.join("; ")}. Wait for it to finish first`,
      );
    if (!findDriver(harness))
      throw new Error(
        `No harness named ${harness}; try ${drivers()
          .map((driver) => driver.id)
          .join(", ")}`,
      );

    const info = thread.session.info;
    const visits = this.#visits.get(id) ?? new Map<HarnessId, Visit>();
    const earlier = harness === from ? undefined : visits.get(harness);
    const now = Date.now();
    const leaving: Visit = {
      native: info.threadId,
      runs:
        thread.handoff === null
          ? managed.runs.length
          : (this.#seenWithoutHandoff.get(id) ?? managed.runs.length),
      model: info.model,
      effort: info.effort,
      contextTokens: thread.usage?.contextTokens ?? null,
      leftAt: now,
    };
    // As narrow as the thread runs now, which may be narrower than it was asked to.
    const settings: SessionOptions = {
      cwd: info.cwd,
      model: options.model ?? (harness === from ? info.model : (earlier?.model ?? null)),
      effort: options.effort ?? (harness === from ? info.effort : (earlier?.effort ?? null)),
      runtimeMode: info.runtimeMode,
      interactionMode: info.interactionMode,
      resume: null,
    };
    const servers = this.#servers.get(id) ?? {};
    const toolPolicy = this.#options.extensions.toolPolicy(() => thread);
    const extras = {
      ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
    };
    const attempts = [
      ...(earlier?.native && !fresh ? [{ resume: earlier.native, seen: earlier.runs }] : []),
      { resume: null, seen: 0 },
    ];

    this.#switching.set(id, harness);
    this.#refresh(managed);
    let resumeError: string | null = null;
    try {
      for (const attempt of attempts) {
        const asked = { ...settings, resume: attempt.resume };
        const unseen = managed.runs.slice(attempt.seen);
        const handoff = handoffText({
          threadId: id,
          to: harness,
          runs: unseen,
          resumed: attempt.resume !== null,
          label: (other) => findDriver(other)?.label ?? other,
        });
        try {
          const next = createSession(harness, { ...asked, ...extras }, this.#env());
          await thread.replaceSession(next, {
            handoff,
            prepare: () => holdModes(next, harness, asked),
          });
          visits.set(from, leaving);
          this.#visits.set(id, visits);
          if (handoff) this.#seenWithoutHandoff.set(id, attempt.seen);
          else this.#seenWithoutHandoff.delete(id);
          const resumed = attempt.resume !== null && earlier !== undefined;
          return {
            from,
            to: harness,
            resumed,
            resumeError,
            handedOver: handoff ? unseen.filter((run) => run.status !== "running").length : 0,
            resumedContext: resumed
              ? { tokens: earlier.contextTokens, idleMs: now - earlier.leftAt }
              : null,
          };
        } catch (error) {
          // Only a failed resume is worth another try, with a new thread.
          if (attempt.resume === null || error instanceof ModeError || thread.closed) throw error;
          resumeError = errorMessage(error);
        }
      }
      throw new Error(`Could not start ${harness}`);
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
    const settled = () =>
      managed.status === "closed" || managed.thread.closed || managed.thread.idle;
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
          event.type === "thread.event" ? event.threadId === managed.id : event.thread === managed;
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
        managed.runs.push({
          index: managed.runs.length + 1,
          turnId: event.turnId,
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
        });
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
          run.input = message ? messageText(message) : item.text;
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
      case "session.replaced":
        managed.harness = this.#switching.get(managed.id) ?? managed.harness;
        break;
      case "error":
        // A message that could not start its turn is a run that failed at once.
        if (event.unsent) {
          const now = Date.now();
          const input = messageText(event.unsent);
          managed.runs.push({
            index: managed.runs.length + 1,
            turnId: "",
            harness: managed.harness,
            status: "failed",
            input,
            origin: event.unsent.origin,
            result: null,
            files: [],
            commands: [],
            error: event.message,
            startedAt: now,
            endedAt: now,
          });
          if (!managed.title) managed.title = titleFrom(input);
        }
        break;
      case "session.closed":
        managed.error = event.error;
        this.#endRun(managed, event.error);
        // Later listeners, such as extensions', still have to see this event.
        queueMicrotask(() => this.#release(managed.id));
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
        : thread.requests.length > 0
          ? "waiting"
          : thread.idle
            ? "idle"
            : "working";
    const run = managed.runs.at(-1);
    const key = [
      managed.status,
      managed.title,
      managed.runs.length,
      run?.status,
      run?.result,
      managed.error,
    ].join("\0");
    if (this.#keys.get(managed.id) === key) return;
    this.#keys.set(managed.id, key);
    this.#emit({ type: "thread.updated", thread: managed });
  }

  #emit(event: ManagerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
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
