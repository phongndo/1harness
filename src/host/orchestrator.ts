import { isRuntimeMode, modeRank } from "../core/events.ts";
import {
  checkHarness,
  drivers,
  findDriver,
  harnessInfo,
  type DriverDefinition,
} from "../drivers/index.ts";
import type { ToolContext, ToolDefinition } from "../extensions/api.ts";
import type { TaskRow } from "../store/store.ts";
import type { HarnessInfo } from "../protocol.ts";
import {
  ModeError,
  titleFrom,
  type ManagedThread,
  type RunRecord,
  type ThreadManager,
} from "./manager.ts";

const ROLES = ["implementation", "research", "review", "design", "test", "general"];
/** How many delegations deep work may go below a user's thread. */
export const MAX_DEPTH = 3;
/** How many threads may work at once, so delegation cannot run away. */
export const MAX_RUNNING_THREADS = 8;
/** How many threads may have a harness running, idle ones included; parked ones have none. */
export const MAX_OPEN_THREADS = 16;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3000;
const RESULT_LIMIT = 8000;
/** About how much one thread_read returns, so reading history cannot flood a context. */
const READ_LIMIT = 40_000;
/** How many of a run's commands thread_read shows, the latest ones. */
const COMMAND_COUNT = 20;

/** A refusal an agent can act on: a stable code and a sentence. */
export class OrchestrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** How a task stands: its run's status, or why it has none. */
type TaskStatus = RunRecord["status"] | "starting" | "cancelled";

/** A piece of work one thread gave another: the child thread's first run. */
interface Task {
  /** The child thread's ID, since each child has one task. */
  id: string;
  parentId: string;
  requestId: string | null;
  /** The parent has seen the outcome, through a wait or a status read. */
  seen: boolean;
  /** The outcome was sent to the parent as a message. */
  delivered: boolean;
  /** The last of the child's runs the parent was told of, by its index. */
  reported: number;
  /** A wait for the outcome is open, so it is not also delivered. */
  waiting: number;
}

function clip(value: string | null): string | null {
  if (value === null || value.length <= RESULT_LIMIT) return value;
  return `${value.slice(0, RESULT_LIMIT)}\n… (${value.length - RESULT_LIMIT} more characters; read the thread for all of it)`;
}

function seconds(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_WAIT_SECONDS, number)) * 1000;
}

/** A run number from the input, counted from 1, or undefined when not given. */
function runNumber(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new OrchestrationError("invalid_request", `${name} must be a run number, from 1`);
  return value;
}

function text(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new OrchestrationError("invalid_request", `${name} must be a string`);
  return value.trim() || undefined;
}

function runView(run: RunRecord) {
  const origin = run.origin;
  return {
    run: run.index,
    // A thread can move between harnesses, so each run says which one ran it.
    harness: run.harness,
    status: run.status,
    // Such as "user", or "report from t3" for a run a task's result started.
    startedBy: origin && (origin.type === "user" ? "user" : `${origin.type} from ${origin.from}`),
    input: clip(run.input),
    result: clip(run.result),
    filesChanged: run.files,
    // What ran and how it exited, never the output, which can be huge.
    commands: run.commands.slice(-COMMAND_COUNT).map(({ command, exitCode }) => ({
      command: command.length > 300 ? `${command.slice(0, 300)}…` : command,
      exitCode,
    })),
    error: run.error,
  };
}

/**
 * Lets agents orchestrate other agents through 1harness: start a task on any
 * harness, wait for or poll its result, cancel it, and list, read, message,
 * wait on, or interrupt threads. The tools are served on the `1harness` MCP
 * server every session has, and they call the same thread manager clients use.
 */
export class Orchestrator {
  #manager: ThreadManager;
  #env: NodeJS.ProcessEnv;
  #tasks = new Map<string, Task>();
  /** Tasks by caller and request ID, set before the task starts so retries find it. */
  #byRequest = new Map<string, Promise<Task>>();
  /** Tasks being started in each tree, counted against its limits before their threads exist. */
  #reserved = new Map<string, number>();
  /** Asks a harness where it stands before work goes to it; the host tells its clients too. */
  checkHarness: (driver: DriverDefinition) => Promise<HarnessInfo> = (driver) =>
    checkHarness(driver, this.#env);
  /** A finished task's thread once it has left memory for the store. */
  storedTask: (id: string) => Pick<ManagedThread, "harness" | "title" | "runs" | "error"> | null =
    () => null;

  constructor(manager: ThreadManager, env: NodeJS.ProcessEnv = process.env) {
    this.#manager = manager;
    this.#env = env;
    manager.subscribe((event) => {
      if (event.type === "thread.updated") this.#deliver(event.thread);
    });
  }

  get tools(): ToolDefinition[] {
    return [
      {
        name: "orchestrator_capabilities",
        description:
          "Lists the harnesses you can hand work to, your own harness and modes, and the limits on delegation. Call it before delegate_task to choose a harness.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        execute: (_input, context) => this.#json(this.#capabilities(this.#caller(context))),
      },
      {
        name: "delegate_task",
        description:
          "Hands a task to another agent in a new thread, on any available harness (see orchestrator_capabilities). The agent sees only the task text, not your conversation, so include the context it needs. By default this waits for the result; with wait set to false it returns a taskId at once, and the result is sent to you as a message when the task finishes. A task's ID is its thread's ID, which the thread tools take too.",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "What the other agent should do, with the context it needs.",
            },
            harness: {
              type: "string",
              description:
                "The harness to run it, one orchestrator_capabilities lists. Yours by default.",
            },
            model: {
              type: "string",
              description: "A model the harness offers. The harness's default otherwise.",
            },
            effort: {
              type: "string",
              description: "A reasoning effort the model offers, such as low or high.",
            },
            title: { type: "string", description: "A short name for the task." },
            role: { type: "string", enum: ROLES },
            wait: {
              type: "boolean",
              description: "Wait for the result (the default), or return at once.",
            },
            timeoutSeconds: {
              type: "number",
              description: `How long to wait, at most ${MAX_WAIT_SECONDS}. A timeout leaves the task running.`,
            },
            requestId: {
              type: "string",
              description:
                "Your own ID for this task. Retrying with the same ID returns the same task instead of starting another.",
            },
            runtimeMode: {
              type: "string",
              enum: ["inherit", "supervised", "auto-edit", "auto", "full-access"],
              description:
                "Omit unless the user asks for a supervised child. Narrow modes pause for human approval, not read-only. Above yours is rejected.",
            },
            plan: { type: "boolean", description: "Run the task in plan mode." },
          },
          required: ["task"],
        },
        execute: async (input, context) =>
          this.#json(await this.#delegate(this.#caller(context), input, context.callId ?? null)),
      },
      {
        name: "task_status",
        description:
          "Reports a task you delegated: its status, and its result once finished. Can wait for it.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            wait: { type: "boolean", description: "Wait for the task to finish first." },
            timeoutSeconds: { type: "number" },
          },
          required: ["taskId"],
        },
        readOnly: true,
        execute: async (input, context) => {
          const task = this.#task(this.#caller(context), input);
          if (input["wait"] === true)
            await this.#waitTask(task, seconds(input["timeoutSeconds"], DEFAULT_WAIT_SECONDS));
          return this.#json(this.#taskView(task, false));
        },
      },
      {
        name: "task_cancel",
        description:
          "Stops a task you delegated, and any work it delegated in turn. On a finished task it closes the task's thread, which frees room under the thread limit.",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
        },
        execute: async (input, context) => {
          const task = this.#task(this.#caller(context), input);
          // The caller knows the outcome, so it is not also delivered when the thread closes.
          task.seen = true;
          const child = this.#manager.get(task.id);
          if (child && child.status !== "closed") {
            await child.thread.interrupt().catch(() => {});
            await this.#manager.close(child.id);
          }
          return this.#json(this.#taskView(task, false));
        },
      },
      {
        name: "thread_list",
        description:
          "Lists the threads in your tree: the user's thread at its root and every thread started under it, with their harness, status, and which thread started them.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        execute: (_input, context) => {
          const caller = this.#caller(context);
          return this.#json({
            you: caller.id,
            threads: this.#tree(caller).map((thread) => this.#threadView(thread)),
          });
        },
      },
      {
        name: "thread_read",
        description:
          "Reads a thread's runs: what each was asked and answered, the commands it ran, and the files it changed. Reads the latest runs, or a range with fromRun and toRun. Runs come back oldest first; a long read keeps the newest runs that fit, and moreRuns names the older runs in the range that were left out.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            runs: {
              type: "number",
              description: "How many of the latest runs to read; 5 by default.",
            },
            fromRun: { type: "number", description: "The first run to read, counted from 1." },
            toRun: { type: "number", description: "The last run to read." },
          },
          required: ["threadId"],
        },
        readOnly: true,
        execute: (input, context) => {
          const thread = this.#thread(this.#caller(context), input, true);
          const from = runNumber(input, "fromRun");
          const to = runNumber(input, "toRun");
          const count = typeof input["runs"] === "number" ? Math.max(1, input["runs"]) : 5;
          const chosen =
            from === undefined && to === undefined
              ? thread.runs.slice(-count)
              : thread.runs.filter(
                  (run) => run.index >= (from ?? 1) && run.index <= (to ?? Infinity),
                );
          // Newest first until the limit, so a long range comes back in pages.
          const views: ReturnType<typeof runView>[] = [];
          let used = 0;
          for (const run of chosen.toReversed()) {
            const view = runView(run);
            // Measured as it is sent, indented.
            const size = JSON.stringify(view, null, 2).length;
            if (views.length > 0 && used + size > READ_LIMIT) break;
            views.unshift(view);
            used += size;
          }
          const left = chosen.slice(0, chosen.length - views.length);
          const [first, last] = [left[0], left.at(-1)];
          return this.#json({
            ...this.#threadView(thread),
            runs: views,
            ...(first && last ? { moreRuns: { fromRun: first.index, toRun: last.index } } : {}),
          });
        },
      },
      {
        name: "thread_send",
        description:
          "Sends a message to another thread, such as a follow-up for a task's thread. It queues as the thread's next turn, or joins the running turn with steer.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            message: { type: "string" },
            steer: {
              type: "boolean",
              description: "Add the message to the running turn instead of queueing it.",
            },
          },
          required: ["threadId", "message"],
        },
        execute: async (input, context) => {
          const caller = this.#caller(context);
          const target = this.#target(caller, input);
          const message = text(input, "message");
          if (!message) throw new OrchestrationError("invalid_request", "message is empty");
          const origin = { type: "message", from: caller.id } as const;
          if (input["steer"] === true) await target.thread.steer({ text: message }, origin);
          else target.thread.send({ text: message }, origin);
          return this.#json({
            threadId: target.id,
            status: target.status,
            queued: target.thread.queue.length,
          });
        },
      },
      {
        name: "thread_wait",
        description: "Waits until a thread has finished its work, then returns its latest run.",
        inputSchema: {
          type: "object",
          properties: { threadId: { type: "string" }, timeoutSeconds: { type: "number" } },
          required: ["threadId"],
        },
        readOnly: true,
        execute: async (input, context) => {
          const caller = this.#caller(context);
          const thread = this.#thread(caller, input);
          if (thread.id === caller.id)
            throw new OrchestrationError("invalid_request", "a thread cannot wait on itself");
          const { timedOut } = await this.#manager.wait(
            thread.id,
            seconds(input["timeoutSeconds"], DEFAULT_WAIT_SECONDS),
          );
          const run = thread.runs.at(-1);
          return this.#json({
            ...this.#threadView(thread),
            latest: run ? runView(run) : null,
            waitTimedOut: timedOut,
          });
        },
      },
      {
        name: "thread_interrupt",
        description: "Interrupts another thread's running turn.",
        inputSchema: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"],
        },
        execute: async (input, context) => {
          const target = this.#target(this.#caller(context), input);
          await target.thread.interrupt();
          return this.#json({ threadId: target.id, status: target.status });
        },
      },
    ];
  }

  /** Every task, for a store to keep. */
  taskRows(): TaskRow[] {
    return [...this.#tasks.values()].map(({ id, parentId, requestId, seen, delivered }) => ({
      id,
      parentId,
      requestId,
      seen,
      delivered,
    }));
  }

  /** Forgets the tasks of threads that are gone for good, and the ones they gave. */
  forgetTasks(threadIds: Iterable<string>): void {
    const gone = new Set(threadIds);
    for (const [id, task] of this.#tasks)
      if (gone.has(id) || gone.has(task.parentId)) this.#tasks.delete(id);
    for (const key of this.#byRequest.keys())
      if (gone.has(key.split("\0")[0] ?? "")) this.#byRequest.delete(key);
  }

  /**
   * Brings back tasks a store kept. A task whose outcome its parent never got
   * is not sent now: nothing starts by itself after a restart, so the parent
   * finds out with task_status when it runs again.
   */
  restoreTasks(rows: readonly TaskRow[]): void {
    for (const row of rows) {
      // After a restart a task reports nothing more, its later runs included.
      const task: Task = {
        ...row,
        delivered: row.delivered || !row.seen,
        reported: Number.POSITIVE_INFINITY,
        waiting: 0,
      };
      this.#tasks.set(task.id, task);
      if (task.requestId)
        this.#byRequest.set(`${task.parentId}\0${task.requestId}`, Promise.resolve(task));
    }
  }

  /**
   * Stops a thread and every thread under it, as the user does with esc: each
   * running turn is interrupted and the agents' queued messages are dropped.
   * Reports to the stopped threads are not delivered, and the ones already
   * queued are dropped, so none starts again; the user's own queued messages
   * stay. The thread's own parent, which goes on, is told it was interrupted.
   */
  async stop(id: string): Promise<void> {
    const thread = this.#manager.get(id);
    if (!thread) return;
    const below = this.#manager.descendants(id);
    const stopped = new Set([id, ...below.map((child) => child.id)]);
    for (const task of this.#tasks.values()) if (stopped.has(task.parentId)) task.seen = true;
    const stopping = below.map(async (child) => {
      if (this.#manager.closing(child.id)) return;
      // One still starting has not been sent its task, so it is closed instead.
      if (child.status === "starting") return this.#manager.close(child.id);
      child.thread.clearQueue();
      await child.thread.interrupt();
    });
    thread.thread.clearQueue((message) => message.origin.type !== "user");
    // Agents are stopped as far as they can be; the thread's own failure is the caller's to report.
    await Promise.all([...stopping.map((done) => done.catch(() => {})), thread.thread.interrupt()]);
  }

  /** The user's thread at the root of a thread's tree. */
  #root(thread: ManagedThread): ManagedThread {
    const parent = thread.parentId ? this.#manager.get(thread.parentId) : undefined;
    return parent ? this.#root(parent) : thread;
  }

  /**
   * The threads an agent may see and act on: its tree, from the user's thread
   * at its root down. Other trees, such as another terminal's, are not its own.
   */
  #tree(caller: ManagedThread): ManagedThread[] {
    const root = this.#root(caller);
    return [root, ...this.#manager.descendants(root.id)];
  }

  /**
   * Threads in the caller's tree with a harness running, and the ones among
   * them with work, counting tasks it is still starting. A parked thread holds
   * no harness, so it is not counted.
   */
  #counts(caller: ManagedThread): { open: number; running: number } {
    const reserved = this.#reserved.get(this.#root(caller).id) ?? 0;
    const open = this.#tree(caller).filter(
      (thread) => !this.#manager.closing(thread.id) && thread.status !== "parked",
    );
    const running = open.filter((thread) => thread.status === "starting" || !thread.thread.idle);
    return { open: open.length + reserved, running: running.length + reserved };
  }

  #capabilities(caller: ManagedThread) {
    const info = caller.thread.info;
    const counts = this.#counts(caller);
    return {
      you: {
        threadId: caller.id,
        harness: caller.harness,
        model: info.model,
        runtimeMode: info.runtimeMode,
        plan: info.interactionMode === "plan",
      },
      harnesses: drivers().map((driver) => {
        const reason = harnessInfo(driver, this.#env).unavailable;
        return {
          id: driver.id,
          label: driver.label,
          available: reason === null,
          ...(reason ? { reason } : {}),
        };
      }),
      limits: {
        depth: this.#manager.depth(caller.id),
        maxDepth: MAX_DEPTH,
        runningThreads: counts.running,
        maxRunningThreads: MAX_RUNNING_THREADS,
        openThreads: counts.open,
        maxOpenThreads: MAX_OPEN_THREADS,
        maxWaitSeconds: MAX_WAIT_SECONDS,
      },
    };
  }

  /** `callId` is the caller's tool call, where its harness said which. */
  async #delegate(caller: ManagedThread, input: Record<string, unknown>, callId: string | null) {
    const requestId = text(input, "requestId") ?? null;
    const wait = input["wait"] !== false;
    const timeout = seconds(input["timeoutSeconds"], DEFAULT_WAIT_SECONDS);
    const key = requestId ? `${caller.id}\0${requestId}` : null;
    let starting = key ? this.#byRequest.get(key) : undefined;
    if (!starting) {
      starting = this.#start(caller, input, requestId, callId);
      if (key) {
        this.#byRequest.set(key, starting);
        // A task that failed to start can be tried again with the same ID.
        starting.catch(() => this.#byRequest.delete(key));
      }
    }
    const task = await starting;
    if (wait) await this.#waitTask(task, timeout);
    return this.#taskView(task, wait && !this.#finished(task));
  }

  /** Checks a delegation, starts its thread, and sends it the task. */
  async #start(
    caller: ManagedThread,
    input: Record<string, unknown>,
    requestId: string | null,
    callId: string | null,
  ): Promise<Task> {
    const brief = text(input, "task");
    if (!brief) throw new OrchestrationError("invalid_request", "task is empty");
    if (this.#manager.depth(caller.id) + 1 > MAX_DEPTH)
      throw new OrchestrationError(
        "depth_limit",
        `work can be delegated at most ${MAX_DEPTH} levels deep`,
      );

    const harness = text(input, "harness") ?? caller.harness;
    const driver = findDriver(harness);
    if (!driver) throw new OrchestrationError("harness_unavailable", `no harness named ${harness}`);
    const { unavailable: reason } = await this.checkHarness(driver);
    if (reason) throw new OrchestrationError("harness_unavailable", reason);

    const info = caller.thread.info;
    const asked = text(input, "runtimeMode");
    const mode = asked === undefined || asked === "inherit" ? info.runtimeMode : asked;
    if (!isRuntimeMode(mode))
      throw new OrchestrationError("invalid_request", `no runtime mode ${mode}`);
    if (modeRank(mode) > modeRank(info.runtimeMode))
      throw new OrchestrationError(
        "runtime_mode_escalation_denied",
        `a ${info.runtimeMode} thread cannot start ${mode} work`,
      );
    const callerPlans = info.interactionMode === "plan";
    if (callerPlans && input["plan"] === false)
      throw new OrchestrationError(
        "interaction_mode_escalation_denied",
        "a thread in plan mode can only start planning work",
      );
    const plan = input["plan"] === true || callerPlans;
    const role = text(input, "role");
    if (role && !ROLES.includes(role))
      throw new OrchestrationError("invalid_request", `no role ${role}`);
    const sameHarness = harness === caller.harness;

    const counts = this.#counts(caller);
    if (counts.running >= MAX_RUNNING_THREADS)
      throw new OrchestrationError(
        "thread_limit",
        `${counts.running} threads are working; wait for some to finish or cancel them first`,
      );
    if (counts.open >= MAX_OPEN_THREADS)
      throw new OrchestrationError(
        "thread_limit",
        `${counts.open} threads are open; close finished tasks with task_cancel first`,
      );
    // Held until the task is sent, when its thread counts as working.
    const root = this.#root(caller).id;
    this.#reserved.set(root, (this.#reserved.get(root) ?? 0) + 1);
    try {
      let child: ManagedThread;
      try {
        child = await this.#manager.create({
          harness,
          settings: {
            cwd: info.cwd,
            model: text(input, "model") ?? (sameHarness ? info.model : null),
            effort: text(input, "effort") ?? (sameHarness ? info.effort : null),
            runtimeMode: mode,
            interactionMode: plan ? "plan" : "default",
            resume: null,
          },
          title: titleFrom(text(input, "title") ?? brief),
          parentId: caller.id,
          parentCallId: callId,
          origin: "delegated",
        });
      } catch (error) {
        // A harness that cannot run the task as narrowly as asked is refused, with why.
        if (error instanceof ModeError) throw new OrchestrationError(error.code, error.message);
        throw error;
      }
      const task: Task = {
        id: child.id,
        parentId: caller.id,
        requestId,
        seen: false,
        delivered: false,
        reported: 1,
        waiting: 0,
      };
      this.#tasks.set(task.id, task);
      child.thread.send(
        { text: this.#brief(brief, role) },
        { type: "task", from: caller.id, task: brief },
      );
      return task;
    } finally {
      const left = (this.#reserved.get(root) ?? 1) - 1;
      if (left > 0) this.#reserved.set(root, left);
      else this.#reserved.delete(root);
    }
  }

  #brief(task: string, role: string | undefined): string {
    const lead = role
      ? `You are doing ${role} work for another agent.`
      : "You are doing a task for another agent.";
    return `${lead} When you finish, reply with your result: your final message goes back to that agent, which sees nothing else of this conversation.\n\n${task}`;
  }

  /** The task's run has ended, or its thread has gone. */
  #finished(task: Task): boolean {
    const child = this.#manager.get(task.id);
    if (!child || child.status === "closed") return true;
    const run = child.runs[0];
    // A thread with nothing to do and no run had its task dropped by an extension.
    return run ? run.status !== "running" : child.thread.idle;
  }

  #storedChild(id: string) {
    const stored = this.storedTask(id);
    return stored && { ...stored, status: "closed" as const };
  }

  /** Waits for the task to finish, or to need the user, or for the timeout. */
  #waitTask(task: Task, timeoutMs: number): Promise<void> {
    const child = this.#manager.get(task.id);
    if (!child || this.#finished(task) || child.status === "waiting") return Promise.resolve();
    task.waiting++;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        task.waiting--;
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = this.#manager.subscribe((event) => {
        if (event.type !== "thread.updated" || event.thread !== child) return;
        if (this.#finished(task) || child.status === "waiting") done();
      });
    });
  }

  #taskView(task: Task, timedOut: boolean) {
    const child = this.#manager.get(task.id) ?? this.#storedChild(task.id);
    const run = child?.runs[0];
    const finished = this.#finished(task);
    if (finished) task.seen = true;
    const dropped = !run && finished && child?.status !== "closed";
    const status: TaskStatus =
      run?.status ?? (dropped ? "failed" : child?.status === "closed" ? "cancelled" : "starting");
    return {
      taskId: task.id,
      threadId: task.id,
      harness: child?.harness ?? null,
      title: child?.title ?? null,
      status,
      result: clip(run?.result ?? null),
      error: run
        ? run.error
        : dropped
          ? "an extension dropped the task before it started"
          : (child?.error ?? null),
      // The user has to answer an approval or question in the task's thread.
      waitingForUser: child?.status === "waiting",
      waitTimedOut: timedOut,
      laterRuns: Math.max(0, (child?.runs.length ?? 1) - 1),
    };
  }

  #threadView(thread: ManagedThread) {
    const info = thread.thread.info;
    const last = thread.runs.at(-1);
    return {
      threadId: thread.id,
      title: thread.title,
      harness: thread.harness,
      status: thread.status,
      parentId: thread.parentId,
      runtimeMode: info.runtimeMode,
      plan: info.interactionMode === "plan",
      runs: thread.runs.length,
      lastResult: last?.result ? clip(last.result.slice(0, 400)) : null,
    };
  }

  /**
   * Sends a finished task's outcome to the thread that delegated it, unless
   * that thread already saw it: into its running turn where the harness
   * allows, or as its next turn.
   */
  #deliver(child: ManagedThread): void {
    const task = this.#tasks.get(child.id);
    if (!task || task.waiting > 0) return;
    if (task.delivered || task.seen) {
      this.#reportLater(task, child);
      return;
    }
    if (!this.#finished(task)) return;
    task.delivered = true;
    const view = this.#taskView(task, false);
    const { status } = view;
    // Only a finished task is reported, so it is never running or starting.
    if (status === "running" || status === "starting") return;
    const outcome = view.result ?? view.error ?? "(no reply)";
    this.#report(task, child, status, outcome, `${status}`);
  }

  /**
   * A task whose run was interrupted, as a declined approval interrupts it,
   * and which the user then had go on in its thread: what each later run the
   * user started there came to goes to the parent too, once it ends.
   */
  #reportLater(task: Task, child: ManagedThread): void {
    if (child.runs[0]?.status !== "interrupted") return;
    const run = child.runs.at(-1);
    if (!run || run.index <= task.reported || run.status === "running") return;
    if (run.origin && run.origin.type !== "user") return;
    task.reported = run.index;
    const outcome = clip(run.result ?? run.error ?? "(no reply)") ?? "(no reply)";
    this.#report(
      task,
      child,
      run.status,
      outcome,
      `went on after it was interrupted, and ${run.status}`,
    );
  }

  /** Sends a task's outcome to its parent: into its running turn where the harness allows. */
  #report(
    task: Task,
    child: ManagedThread,
    status: Exclude<RunRecord["status"], "running"> | "cancelled",
    outcome: string,
    said: string,
  ): void {
    // A parent closing with its children has no use for their outcomes.
    const parent = this.#manager.get(task.parentId);
    if (!parent || this.#manager.closing(parent.id)) return;
    const message = `[1harness] Task ${task.id} (${child.harness}: ${child.title}) ${said}:\n\n${outcome}`;
    const origin = { type: "report", from: child.id, status, result: outcome } as const;
    if (parent.thread.busy && parent.thread.capabilities.steer) {
      // Steering reports its own failures to the thread; this only keeps one from crashing the host.
      void parent.thread
        .steer({ text: message }, origin)
        .catch((error: unknown) =>
          console.error(`1harness: could not report task ${task.id} to its thread:`, error),
        );
    } else {
      parent.thread.send({ text: message }, origin);
    }
  }

  #caller(context: ToolContext): ManagedThread {
    const caller = this.#manager.byThread(context.thread);
    if (!caller)
      throw new OrchestrationError(
        "orchestration_error",
        "the calling thread is not managed by 1harness",
      );
    return caller;
  }

  #task(caller: ManagedThread, input: Record<string, unknown>): Task {
    const id = text(input, "taskId") ?? "";
    const task = this.#tasks.get(id);
    if (!task || task.parentId !== caller.id)
      throw new OrchestrationError("task_not_found", `no task ${id} delegated by this thread`);
    return task;
  }

  /**
   * A thread in the caller's tree; another tree's is not found. `read` also
   * finds the threads the caller's tree was forked from, whose turns its
   * handoff points to.
   */
  #thread(caller: ManagedThread, input: Record<string, unknown>, read = false): ManagedThread {
    const id = text(input, "threadId") ?? "";
    const thread = this.#manager.get(id);
    const ours = thread && this.#root(thread) === this.#root(caller);
    if (!thread || (!ours && !(read && this.#forkedFrom(caller).has(thread.id))))
      throw new OrchestrationError("thread_not_found", `no thread ${id} in your tree`);
    return thread;
  }

  /** The threads the caller's tree was forked from, and the ones those were forked from. */
  #forkedFrom(caller: ManagedThread): Set<string> {
    const sources = new Set<string>();
    let source = this.#root(caller).forkedFrom;
    while (source && !sources.has(source)) {
      sources.add(source);
      const thread = this.#manager.get(source);
      source = thread ? this.#root(thread).forkedFrom : null;
    }
    return sources;
  }

  /** Another open thread the caller may act on: never one allowed more than the caller. */
  #target(caller: ManagedThread, input: Record<string, unknown>): ManagedThread {
    const target = this.#thread(caller, input);
    if (target.id === caller.id)
      throw new OrchestrationError("invalid_request", "use your own turn for your own thread");
    if (target.status === "closed")
      throw new OrchestrationError("thread_closed", `thread ${target.id} is closed`);
    const mine = caller.thread.info;
    const theirs = target.thread.info;
    if (modeRank(theirs.runtimeMode) > modeRank(mine.runtimeMode))
      throw new OrchestrationError(
        "runtime_mode_escalation_denied",
        `thread ${target.id} runs ${theirs.runtimeMode}, more than this thread's ${mine.runtimeMode}`,
      );
    if (mine.interactionMode === "plan" && theirs.interactionMode !== "plan")
      throw new OrchestrationError(
        "interaction_mode_escalation_denied",
        "a thread in plan mode can only act on planning threads",
      );
    return target;
  }

  #json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
}
