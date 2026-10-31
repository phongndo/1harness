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

/** A harness that answers each message with `done: <message>` on the next tick. */
class FakeSession {
  readonly capabilities: Capabilities;
  readonly info: SessionInfo;
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly steered: string[] = [];
  #turns = 0;
  #pending: (() => void) | null = null;

  constructor(options: SessionOptions, modes = ALL_MODES, planMode = true) {
    this.capabilities = {
      steer: true,
      planMode,
      runtimeModes: modes.map((id) => ({ id, description: id })),
      images: false,
      toolChecks: false,
      nativeSlashCommands: false,
      mcpActions: [],
    };
    this.info = {
      harness: "fake",
      threadId: "native",
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      // Each harness reports the mode it really runs.
      runtimeMode: modes.includes(options.runtimeMode) ? options.runtimeMode : modes.at(-1)!,
      interactionMode: planMode ? options.interactionMode : "default",
      version: null,
    };
  }

  async start(): Promise<void> {}

  async startTurn(input: UserInput): Promise<void> {
    if (input.text.endsWith("FAIL")) throw new Error("the harness refused the turn");
    const turnId = `turn-${++this.#turns}`;
    this.events.push({ type: "turn.started", turnId });
    this.events.push({
      type: "item.completed",
      item: { kind: "user_message", id: `${turnId}-user`, text: input.text },
    });
    const finish = () => {
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
    setTimeout(finish, input.text.endsWith("SLOW") ? 40 : 1);
  }

  async steer(input: UserInput): Promise<void> {
    this.steered.push(input.text);
  }

  async interrupt(): Promise<void> {}

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

async function call(name: string, caller: ManagedThread, input: Record<string, unknown>) {
  const tool = byName.get(name);
  assert.ok(tool, name);
  const output = await tool.execute(input, { thread: caller.thread });
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
  const orchestrator = new Orchestrator(manager);
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

describe("Orchestrator", () => {
  it("delegates a task to a child thread and waits for its result", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const result = await call("delegate_task", parent, {
      task: "review the parser",
      title: "Review",
    });
    assert.equal(result["status"], "completed");
    assert.equal(result["result"], "done: review the parser");
    const child = manager.get(String(result["threadId"]));
    assert.equal(child?.parentId, parent.id);
    assert.equal(child?.origin, "delegated");
    assert.match(child?.runs[0]?.input ?? "", /final message goes back to that agent/);
    await settle();
    assert.equal(parent.runs.length, 0, "a result the parent waited for is not delivered again");
  });

  it("sends an async task's result to the parent when it finishes", async () => {
    const parent = await manager.create({ harness: "fake", settings: settings() });
    const started = await call("delegate_task", parent, { task: "slow work SLOW", wait: false });
    assert.notEqual(started["status"], "completed");
    await settle(80);
    const delivered = parent.runs[0];
    assert.match(
      delivered?.input ?? "",
      /^\[1harness\] Task task-\d+ \(fake: slow work SLOW\) completed:\n\ndone: slow work SLOW/,
    );
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
    const wide = manager.list().filter((thread) => thread.harness === "fake-wide");
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
    await assert.rejects(call("task_status", parent, { taskId: "task-999" }), /task_not_found/);
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
