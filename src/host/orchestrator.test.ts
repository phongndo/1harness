import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { AsyncQueue } from "../core/async-queue.ts";
import type {
  Capabilities,
  HarnessEvent,
  RequestResponse,
  RuntimeMode,
  SessionInfo,
  SessionOptions,
  UserInput,
} from "../core/events.ts";
import { registerDriver } from "../drivers/index.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { ToolServer } from "../extensions/tool-server.ts";
import { ThreadManager, type ManagedThread } from "./manager.ts";
import { MAX_OPEN_THREADS, MAX_RUNNING_THREADS, Orchestrator } from "./orchestrator.ts";

const ALL_MODES: RuntimeMode[] = ["supervised", "auto-edit", "auto", "full-access"];
/** Numbers each new native thread, so a resumed one can be told apart. */
let natives = 0;

/** A harness that answers each message with `done: <message>` on the next tick. */
class FakeSession {
  readonly capabilities: Capabilities;
  readonly info: SessionInfo;
  /** What the session was started with. */
  readonly options: SessionOptions;
  readonly events = new AsyncQueue<HarnessEvent>();
  /** What each turn was started with, as the harness got it. */
  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  /** Work it reports running between turns, as a harness's background agents. */
  background: string[] = [];
  #turns = 0;
  #pending: (() => void) | null = null;
  /** The running turn, which an interrupt ends. */
  #running: { turnId: string; timer: NodeJS.Timeout | null } | null = null;

  constructor(
    options: SessionOptions,
    modes = ALL_MODES,
    planMode = true,
    // A harness that starts in its own mode whatever it is asked, as some ACP agents do.
    starts: RuntimeMode | null = null,
  ) {
    this.options = options;
    this.capabilities = {
      steer: true,
      planMode,
      runtimeModes: modes,
      images: false,
      toolChecks: false,
      nativeSlashCommands: false,
      mcpActions: [],
    };
    this.info = {
      harness: "fake",
      threadId: options.resume ?? `native-${++natives}`,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      // Each harness reports the mode it really runs.
      runtimeMode:
        starts ?? (modes.includes(options.runtimeMode) ? options.runtimeMode : modes.at(-1)!),
      interactionMode: planMode ? options.interactionMode : "default",
      version: null,
    };
  }

  async start(): Promise<void> {
    // A native thread the harness no longer has.
    if (this.options.resume === "gone") throw new Error("no such thread");
  }

  async startTurn(input: UserInput): Promise<void> {
    if (input.text.endsWith("FAIL")) throw new Error("the harness refused the turn");
    this.prompts.push(input.text);
    const turnId = `turn-${++this.#turns}`;
    this.events.push({ type: "turn.started", turnId });
    this.events.push({
      type: "item.completed",
      item: {
        kind: "user_message",
        id: `${turnId}-user`,
        text: input.text,
        ...(input.id ? { inputId: input.id } : {}),
      },
    });
    // A message ending in "CMD" runs a command that fails.
    if (input.text.endsWith("CMD"))
      this.events.push({
        type: "item.completed",
        item: {
          kind: "command",
          id: `${turnId}-cmd`,
          command: "pnpm test",
          output: "1 failing",
          exitCode: 1,
          status: "completed",
        },
      });
    const finish = () => {
      this.#running = null;
      this.events.push({
        type: "usage.updated",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 150_000 * this.#turns,
          contextWindow: 1_000_000,
          costUsd: null,
          limits: [],
        },
      });
      this.events.push({
        type: "item.completed",
        item: {
          kind: "assistant_message",
          id: `${turnId}-reply`,
          text: `done: ${input.text.split("\n").at(-1)}`,
        },
      });
      this.events.push({ type: "turn.ended", turnId, status: "completed", error: null });
    };
    // A message ending in "CRASH" ends the session, as a harness process that dies.
    if (input.text.endsWith("CRASH")) {
      setTimeout(() => {
        this.events.push({ type: "session.closed", error: "crashed" });
        this.events.end();
      }, 1);
      return;
    }
    // A message ending in "ASK" waits for an approval first.
    if (input.text.endsWith("ASK")) {
      this.#pending = finish;
      this.events.push({
        type: "request.opened",
        request: {
          kind: "approval",
          id: `${turnId}-ask`,
          title: "Run?",
          detail: "",
          action: { type: "command", command: "ls", cwd: null },
          options: [{ id: "yes", label: "Yes", effect: "allow" }],
          defaultOptionId: "yes",
        },
      });
      return;
    }
    this.#running = { turnId, timer: setTimeout(finish, input.text.endsWith("SLOW") ? 40 : 1) };
  }

  async steer(input: UserInput): Promise<void> {
    this.steered.push(input.text);
  }

  backgroundTasks(): string[] {
    return this.background;
  }

  async interrupt(): Promise<void> {
    const running = this.#running;
    if (!running) return;
    this.#running = null;
    if (running.timer) clearTimeout(running.timer);
    this.events.push({
      type: "turn.ended",
      turnId: running.turnId,
      status: "interrupted",
      error: null,
    });
  }

  async respond(requestId: string, _response: RequestResponse): Promise<void> {
    this.events.push({ type: "request.resolved", requestId });
    const finish = this.#pending;
    this.#pending = null;
    finish?.();
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    this.info.runtimeMode = mode;
  }

  async setInteractionMode(mode: SessionInfo["interactionMode"]): Promise<void> {
    if (!this.capabilities.planMode) throw new Error("no plan mode");
    this.info.interactionMode = mode;
  }

  async close(): Promise<void> {
    this.events.push({ type: "session.closed", error: null });
    this.events.end();
  }
}

let root: string;
let manager: ThreadManager;
let tools: ToolServer;
let extensions: ExtensionHost;
let byName: Map<string, ToolDefinition>;
let orchestrator: Orchestrator;
let unregister: (() => void)[] = [];
/** The errors an extension saw sessions close with. */
const closedEvents: (string | null)[] = [];

const settings = (runtimeMode: RuntimeMode = "supervised"): SessionOptions => ({
  cwd: "/work",
  model: null,
  effort: null,
  runtimeMode,
  interactionMode: "default",
  resume: null,
});

async function call(
  name: string,
  caller: ManagedThread,
  input: Record<string, unknown>,
  callId?: string,
) {
  const tool = byName.get(name);
  assert.ok(tool, name);
  const output = await tool.execute(input, {
    thread: caller.thread,
    ...(callId ? { callId } : {}),
  });
  return JSON.parse(String(output)) as Record<string, unknown>;
}

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

before(async () => {
  root = mkdtempSync(join(tmpdir(), "1harness-host-"));
  unregister = [
    registerDriver({
      id: "fake",
      label: "Fake",
      unavailable: () => null,
      create: (options) => new FakeSession(options),
    }),
    registerDriver({
      id: "fake-sticky",
      label: "Fake sticky",
      unavailable: () => null,
      create: (options) => new FakeSession(options, ALL_MODES, true, "full-access"),
    }),
    registerDriver({
      id: "fake-b",
      label: "Fake B",
      unavailable: () => null,
      create: (options) => new FakeSession(options),
    }),
    // Only broad modes, and no plan mode.
    registerDriver({
      id: "fake-wide",
      label: "Fake wide",
      unavailable: () => null,
      create: (options) => new FakeSession(options, ["auto", "full-access"], false),
    }),
  ];
  (globalThis as { closedEvents?: (string | null)[] }).closedEvents = closedEvents;
  const extension = join(root, "closed.mjs");
  writeFileSync(
    extension,
    `export default (api) => api.on("session.closed", (event) => globalThis.closedEvents.push(event.error));\n`,
  );
  extensions = new ExtensionHost({
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    commands: null,
    ui: null,
  });
  let orchestratorTools = new Map<string, { tool: ToolDefinition }>();
  tools = new ToolServer(() => orchestratorTools, "test");
  manager = new ThreadManager({ version: "test", extensions, tools });
  orchestrator = new Orchestrator(manager);
  byName = new Map(orchestrator.tools.map((tool) => [tool.name, tool]));
  orchestratorTools = new Map(orchestrator.tools.map((tool) => [tool.name, { tool }]));
  await extensions.loadAll([extension]);
});

// Each test starts with no live threads, under the limit on how many may run.
afterEach(() => manager.closeAll());

after(async () => {
  await manager.closeAll();
  await tools.close();
  await extensions.close();
  for (const undo of unregister) undo();
  rmSync(root, { recursive: true, force: true });
});

describe("ThreadManager", () => {
  it("tracks each thread's status and runs, and waits for it to finish", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    assert.equal(thread.status, "idle");
    thread.thread.send({ text: "hello SLOW" });
    // Status follows the harness's events, so it changes once the turn starts.
    await settle(5);
    assert.equal(thread.status, "working");
    const { timedOut } = await manager.wait(thread.id, 1000);
    assert.equal(timedOut, false);
    assert.equal(thread.title, "hello SLOW");
    assert.deepEqual(
      thread.runs.map((run) => [run.index, run.status, run.input, run.result]),
      [[1, "completed", "hello SLOW", "done: hello SLOW"]],
    );
    await manager.close(thread.id);
    assert.equal(thread.status, "closed");
  });

  it("holds every thread to its mode, whatever mode its harness starts in", async () => {
    const sticky = await manager.create({ harness: "fake-sticky", settings: settings() });
    assert.equal(sticky.thread.session.info.runtimeMode, "supervised");
    await assert.rejects(
      manager.create({ harness: "fake-wide", settings: settings("auto-edit") }),
      /fake-wide has no mode as narrow as auto-edit/,
    );
    const wide = await manager.create({ harness: "fake-wide", settings: settings("full-access") });
    assert.equal(wide.thread.session.info.runtimeMode, "full-access");
    await assert.rejects(
      manager.create({
        harness: "fake-wide",
        settings: { ...settings("full-access"), interactionMode: "plan" },
      }),
      /fake-wide has no plan mode/,
    );
  });

  it("settles a wait when a message is dropped or cannot start", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    const remove = thread.thread.addInputHandler(() => null);
    thread.thread.send({ text: "dropped" });
    assert.equal((await manager.wait(thread.id, 1000)).timedOut, false);
    remove();
    thread.thread.send({ text: "nope FAIL" });
    assert.equal((await manager.wait(thread.id, 1000)).timedOut, false);
    assert.deepEqual(
      thread.runs.map((run) => [run.status, run.error]),
      [["failed", "the harness refused the turn"]],
    );
  });

  it("ends the run when a session ends by itself, and tells extensions", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    thread.thread.send({ text: "go CRASH" });
    await manager.wait(thread.id, 1000);
    assert.equal(thread.status, "closed");
    assert.deepEqual(
      thread.runs.map((run) => [run.status, run.error]),
      [["failed", "crashed"]],
    );
    assert.ok(closedEvents.includes("crashed"));
  });
});

const sessionOf = (thread: ManagedThread) => thread.thread.session as unknown as FakeSession;

describe("Switching harness", () => {
  it("moves a thread with a handoff of what it missed, and back to its old thread", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    const first = sessionOf(thread);
    thread.thread.send({ text: "plan the parser" });
    await manager.wait(thread.id, 1000);

    const moved = await manager.switchHarness(thread.id, "fake-b");
    assert.deepEqual(moved, {
      from: "fake",
      to: "fake-b",
      resumed: false,
      resumeError: null,
      handedOver: 1,
      resumedContext: null,
    });
    assert.equal(thread.harness, "fake-b");
    assert.equal(thread.status, "idle");
    assert.equal(first.events.ended, true);
    const second = sessionOf(thread);
    assert.equal(second.info.runtimeMode, "supervised");

    // The handoff rides on the next message; the run keeps the message as sent.
    thread.thread.send({ text: "write it" });
    await manager.wait(thread.id, 1000);
    const handed = second.prompts[0] ?? "";
    assert.match(
      handed,
      /^<1harness-handoff>\n1harness thread t\d+ has moved to you \(Fake B\) from Fake\./,
    );
    assert.match(handed, /Turn 1 · Fake\nUser: plan the parser\nReply: done: plan the parser/);
    assert.ok(handed.endsWith("The next message follows.\n\nwrite it"));
    assert.deepEqual(
      thread.runs.map((run) => [run.harness, run.input, run.result]),
      [
        ["fake", "plan the parser", "done: plan the parser"],
        ["fake-b", "write it", "done: write it"],
      ],
    );
    const read = await call("thread_read", thread, { threadId: thread.id });
    assert.deepEqual(
      (read["runs"] as { harness: string }[]).map((run) => run.harness),
      ["fake", "fake-b"],
    );

    // Going back resumes the first harness's own thread, which missed only turn 2.
    const back = await manager.switchHarness(thread.id, "fake");
    assert.equal(back.resumed, true);
    assert.equal(back.handedOver, 1);
    const third = sessionOf(thread);
    assert.equal(third.options.resume, first.info.threadId);
    thread.thread.send({ text: "test it" });
    await manager.wait(thread.id, 1000);
    const delta = third.prompts[0] ?? "";
    assert.match(
      delta,
      /You are back on 1harness thread t\d+\. While you were away it ran on Fake B/,
    );
    assert.match(delta, /Turn 2 · Fake B\nUser: write it/);
    assert.doesNotMatch(delta, /Turn 1/);
  });

  it("starts a new thread when the old one is gone, and stays put on a narrower mode", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    thread.thread.send({ text: "one" });
    await manager.wait(thread.id, 1000);
    sessionOf(thread).info.threadId = "gone";
    await manager.switchHarness(thread.id, "fake-b");
    const back = await manager.switchHarness(thread.id, "fake");
    assert.deepEqual(
      [back.resumed, back.resumeError, back.handedOver],
      [false, "no such thread", 1],
    );
    assert.equal(sessionOf(thread).options.resume, null);

    // A supervised thread cannot move to a harness whose narrowest mode is auto.
    const staying = sessionOf(thread);
    await assert.rejects(
      manager.switchHarness(thread.id, "fake-wide"),
      /fake-wide has no mode as narrow as supervised/,
    );
    assert.equal(thread.harness, "fake");
    assert.equal(sessionOf(thread), staying);
    thread.thread.send({ text: "two" });
    await manager.wait(thread.id, 1000);
    assert.equal(thread.runs.at(-1)?.status, "completed");
  });

  it("keeps a handoff that was never sent for the next time the harness is used", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    thread.thread.send({ text: "one" });
    await manager.wait(thread.id, 1000);
    // Onto fake-b and straight back, so fake-b's handoff never goes out.
    await manager.switchHarness(thread.id, "fake-b");
    const skipped = sessionOf(thread);
    await manager.switchHarness(thread.id, "fake");
    thread.thread.send({ text: "two" });
    await manager.wait(thread.id, 1000);
    // fake-b resumes its thread, which never heard of turn 1 either.
    const again = await manager.switchHarness(thread.id, "fake-b");
    assert.equal(again.resumed, true);
    assert.equal(sessionOf(thread).options.resume, skipped.info.threadId);
    assert.equal(again.handedOver, 2);
    thread.thread.send({ text: "three" });
    await manager.wait(thread.id, 1000);
    const handed = sessionOf(thread).prompts[0] ?? "";
    assert.match(handed, /Turn 1 · Fake\nUser: one/);
    assert.match(handed, /Turn 2 · Fake\nUser: two/);
  });

  it("starts a harness over with fresh, and says how large a resumed thread is", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    const first = sessionOf(thread);
    thread.thread.send({ text: "check it CMD" });
    await manager.wait(thread.id, 1000);
    assert.deepEqual(thread.runs[0]?.commands, [{ command: "pnpm test", exitCode: 1 }]);
    await manager.switchHarness(thread.id, "fake-b");
    const handed = (() => {
      thread.thread.send({ text: "go on" });
      return manager.wait(thread.id, 1000).then(() => sessionOf(thread).prompts[0] ?? "");
    })();
    assert.match(await handed, /Commands: `pnpm test` → exit 1/);

    const back = await manager.switchHarness(thread.id, "fake");
    assert.equal(back.resumed, true);
    assert.equal(back.resumedContext?.tokens, 150_000);
    assert.ok((back.resumedContext?.idleMs ?? -1) >= 0);
    assert.equal(sessionOf(thread).options.resume, first.info.threadId);

    // fresh skips the resume, and restarts the harness the thread is on.
    const restarted = await manager.switchHarness(thread.id, "fake", { fresh: true });
    assert.deepEqual(
      [
        restarted.from,
        restarted.to,
        restarted.resumed,
        restarted.resumedContext,
        restarted.handedOver,
      ],
      ["fake", "fake", false, null, 2],
    );
    assert.equal(sessionOf(thread).options.resume, null);
  });

  it("does not move while the old harness still runs background work", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    sessionOf(thread).background = ["Explore the parser"];
    await assert.rejects(
      manager.switchHarness(thread.id, "fake-b"),
      /still runs background work on fake, which moving would stop: Explore the parser/,
    );
    assert.equal(thread.harness, "fake");
    sessionOf(thread).background = [];
    await manager.switchHarness(thread.id, "fake-b");
    assert.equal(thread.harness, "fake-b");
  });

  it("refuses to move a working thread or to a harness that is not there", async () => {
    const thread = await manager.create({ harness: "fake", settings: settings() });
    await assert.rejects(manager.switchHarness(thread.id, "nope"), /No harness named nope/);
    await assert.rejects(manager.switchHarness(thread.id, "fake"), /already runs on fake/);
    thread.thread.send({ text: "busy SLOW" });
    await settle(5);
    await assert.rejects(manager.switchHarness(thread.id, "fake-b"), /is working/);
    await manager.wait(thread.id, 1000);
  });
});

describe("Orchestrator", () => {
  it("delegates a task to a child thread and waits for its result", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const result = await call(
      "delegate_task",
      parent,
      { task: "review the parser", title: "Review" },
      "call-1",
    );
    assert.equal(result["status"], "completed");
    assert.equal(result["result"], "done: review the parser");
    // A task goes by its thread's ID.
    assert.equal(result["taskId"], result["threadId"]);
    const child = manager.get(String(result["taskId"]));
    assert.equal(child?.parentId, parent.id);
    assert.equal(child?.parentCallId, "call-1");
    assert.equal(child?.origin, "delegated");
    // The agent is sent a brief, but its run keeps the task as it was given.
    const session = child?.thread.session as unknown as FakeSession;
    assert.match(session.prompts[0] ?? "", /final message goes back to that agent/);
    assert.equal(child?.runs[0]?.input, "review the parser");
    assert.deepEqual(child?.runs[0]?.origin, {
      type: "task",
      from: parent.id,
      task: "review the parser",
    });
    const read = await call("thread_read", parent, { threadId: child?.id });
    const [run] = read["runs"] as Record<string, unknown>[];
    assert.equal(run?.["startedBy"], `task from ${parent.id}`);
    await settle();
    assert.equal(parent.runs.length, 0, "a result the parent waited for is not delivered again");
  });

  it("sends an async task's result to the parent when it finishes", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const started = await call("delegate_task", parent, { task: "slow work SLOW", wait: false });
    assert.notEqual(started["status"], "completed");
    await settle(80);
    const session = parent.thread.session as unknown as FakeSession;
    assert.match(
      session.prompts[0] ?? "",
      /^\[1harness\] Task t\d+ \(fake: slow work SLOW\) completed:\n\ndone: slow work SLOW/,
    );
    assert.equal(parent.runs[0]?.input, "done: slow work SLOW");
    assert.deepEqual(parent.runs[0]?.origin, {
      type: "report",
      from: started["threadId"],
      status: "completed",
      result: "done: slow work SLOW",
    });
  });

  it("stops a thread and its agents, dropping their queues and what they report", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    parent.thread.send({ text: "plan SLOW" });
    const started = await call("delegate_task", parent, { task: "slow work SLOW", wait: false });
    const child = manager.get(String(started["threadId"]));
    assert.ok(child);
    await settle(5);
    child.thread.send({ text: "and then this" });
    // The parent has queued a message the user typed and one an agent sent.
    parent.thread.send({ text: "next" });
    parent.thread.send({ text: "from an agent" }, { type: "message", from: child.id });
    await orchestrator.stop(parent.id);
    await settle(80);
    assert.deepEqual(
      child.runs.map((run) => run.status),
      ["interrupted"],
    );
    // The parent's own turn stopped, and only what the user queued ran after it.
    assert.deepEqual(
      parent.runs.map((run) => [run.status, run.input]),
      [
        ["interrupted", "plan SLOW"],
        ["completed", "next"],
      ],
    );
  });

  it("tells the parent of a thread stopped on its own that it was interrupted", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const started = await call("delegate_task", parent, { task: "slow work SLOW", wait: false });
    await settle(5);
    await orchestrator.stop(String(started["threadId"]));
    await settle(60);
    const origin = parent.runs[0]?.origin;
    assert.equal(origin?.type === "report" && origin.status, "interrupted");
  });

  it("returns the same task for a retried request ID", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const first = await call("delegate_task", parent, { task: "once", requestId: "r1" });
    const again = await call("delegate_task", parent, { task: "once", requestId: "r1" });
    assert.equal(again["taskId"], first["taskId"]);
    // Retries that arrive together, before the task has started.
    const [one, two] = await Promise.all([
      call("delegate_task", parent, { task: "twice", requestId: "r2", wait: false }),
      call("delegate_task", parent, { task: "twice", requestId: "r2", wait: false }),
    ]);
    assert.equal(one?.["taskId"], two?.["taskId"]);
    assert.equal(manager.descendants(parent.id).length, 2);
  });

  it("limits threads working and open, and task_cancel frees a finished one", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    // Delegations that start together are counted before their threads exist.
    const started = await Promise.allSettled(
      Array.from({ length: MAX_RUNNING_THREADS + 1 }, (_, index) =>
        call("delegate_task", parent, { task: `job ${index} SLOW`, wait: false }),
      ),
    );
    const refused = started.filter((outcome) => outcome.status === "rejected");
    assert.equal(refused.length, 1);
    assert.match(String(refused[0]?.reason), /thread_limit: 8 threads are working/);
    await settle(80);
    // Finished tasks are idle, so more can start, up to the open limit.
    const tasks: Record<string, unknown>[] = [];
    while (manager.list().filter((thread) => thread.status !== "closed").length < MAX_OPEN_THREADS)
      tasks.push(await call("delegate_task", parent, { task: "more" }));
    assert.ok(tasks.every((task) => task["status"] === "completed"));
    await assert.rejects(
      call("delegate_task", parent, { task: "one too many" }),
      /thread_limit: 16 threads are open/,
    );
    await call("task_cancel", parent, { taskId: tasks[0]?.["taskId"] });
    assert.equal((await call("delegate_task", parent, { task: "now" }))["status"], "completed");
  });

  it("keeps the brief out of the title", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const task = await call("delegate_task", parent, { task: `first line\n${"x".repeat(200)}` });
    const title = manager.get(String(task["threadId"]))?.title ?? "";
    assert.ok(title.startsWith("first line x") && title.length <= 48, title);
  });

  it("reports a task whose turn could not start", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const result = await call("delegate_task", parent, { task: "nope FAIL", timeoutSeconds: 5 });
    assert.equal(result["status"], "failed");
    assert.equal(result["error"], "the harness refused the turn");
    assert.equal(result["waitTimedOut"], false);
  });

  it("refuses work with more freedom than the caller has", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings("auto-edit") });
    await assert.rejects(
      call("delegate_task", parent, { task: "x", runtimeMode: "full-access" }),
      /runtime_mode_escalation_denied/,
    );
    await assert.rejects(
      call("delegate_task", parent, { task: "x", runtimeMode: "constructor" }),
      /invalid_request: no runtime mode constructor/,
    );
    const child = await call("delegate_task", parent, { task: "y", runtimeMode: "supervised" });
    const target = manager.get(String(child["threadId"]));
    assert.equal(target?.thread.session.info.runtimeMode, "supervised");
    await assert.rejects(
      call("thread_send", parent, { threadId: parent.id, message: "hi" }),
      /invalid_request/,
    );
    const sent = await call("thread_send", parent, { threadId: target?.id, message: "follow up" });
    assert.equal(sent["threadId"], target?.id);
    await manager.wait(String(target?.id), 1000);
    assert.equal(target?.runs.at(-1)?.result, "done: follow up");
    assert.deepEqual(target?.runs.at(-1)?.origin, { type: "message", from: parent.id });
  });

  it("refuses a harness that cannot run as narrowly as the task", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings("auto-edit") });
    await assert.rejects(
      call("delegate_task", parent, { task: "x", harness: "fake-wide" }),
      /runtime_mode_unavailable/,
    );
    const planner = await manager.create({
      harness: "fake",
      settings: { ...settings("full-access"), interactionMode: "plan" },
    });
    await assert.rejects(
      call("delegate_task", planner, { task: "x", harness: "fake-wide" }),
      /plan_mode_unavailable/,
    );
    const wide = manager
      .list()
      .filter((thread) => thread.parentId === parent.id || thread.parentId === planner.id);
    assert.equal(wide.length, 2);
    assert.ok(wide.every((thread) => thread.status === "closed"));
  });

  it("stops waiting when the child needs the user, and cancels a task", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const waiting = await call("delegate_task", parent, { task: "needs approval ASK" });
    assert.equal(waiting["waitingForUser"], true);
    // Clients see the session close, so their views of it wind down.
    const closed: string[] = [];
    const stop = manager.subscribe((event) => {
      if (event.type === "thread.event" && event.event.type === "session.closed")
        closed.push(event.threadId);
    });
    const cancelled = await call("task_cancel", parent, { taskId: waiting["taskId"] });
    stop();
    assert.deepEqual(closed, [cancelled["threadId"]]);
    assert.equal(cancelled["status"], "interrupted");
    assert.equal(manager.get(String(cancelled["threadId"]))?.status, "closed");
    await assert.rejects(call("task_status", parent, { taskId: "t999" }), /task_not_found/);
    await settle();
    assert.equal(parent.runs.length, 0, "a cancelled task's outcome is not delivered");
  });

  it("delivers nothing to a parent that closes with its children", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    await call("delegate_task", parent, { task: "long SLOW", wait: false });
    await settle(5);
    await manager.close(parent.id);
    assert.equal(parent.runs.length, 0);
  });

  it("lists threads with their parents and reports capabilities", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const listing = await call("thread_list", parent, {});
    assert.equal(listing["you"], parent.id);
    const capabilities = await call("orchestrator_capabilities", parent, {});
    const harnesses = capabilities["harnesses"] as { id: string; available: boolean }[];
    assert.ok(harnesses.some((harness) => harness.id === "fake" && harness.available));
  });
});
