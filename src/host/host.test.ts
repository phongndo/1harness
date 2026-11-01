import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
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
import type { LogEntry } from "../protocol.ts";
import { agentRowOf } from "../tui/agents.ts";
import { ThreadView } from "../tui/view.ts";
import { Host } from "./host.ts";

let natives = 0;

/**
 * A harness that plays a scripted turn for each message: reasoning and a reply
 * streamed in deltas, a command, and a todo list that keeps its ID across
 * turns, as Codex's does.
 */
class ScriptedSession {
  readonly capabilities: Capabilities = {
    steer: false,
    planMode: false,
    runtimeModes: ["supervised", "full-access"] as RuntimeMode[],
    images: false,
    toolChecks: false,
    nativeSlashCommands: false,
    mcpActions: [],
  };
  readonly info: SessionInfo;
  readonly options: SessionOptions;
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly prompts: string[] = [];
  #turns = 0;
  #pending: (() => void) | null = null;

  constructor(options: SessionOptions) {
    this.options = options;
    this.info = {
      harness: "scripted",
      threadId: options.resume ?? `native-${++natives}`,
      cwd: options.cwd,
      model: options.model,
      effort: null,
      runtimeMode: options.runtimeMode,
      interactionMode: "default",
      version: null,
    };
  }

  async start(): Promise<void> {}

  async startTurn(input: UserInput): Promise<void> {
    this.prompts.push(input.text);
    const turn = ++this.#turns;
    const id = (name: string) => `${turn}-${name}`;
    const push = (event: HarnessEvent) => this.events.push(event);
    push({ type: "turn.started", turnId: `turn-${turn}` });
    push({
      type: "item.completed",
      item: { kind: "user_message", id: id("user"), text: input.text, inputId: input.id! },
    });
    push({ type: "item.started", item: { kind: "reasoning", id: id("think"), text: "" } });
    push({ type: "item.delta", itemId: id("think"), chunk: "**Reading the parser**" });
    push({
      type: "item.updated",
      item: {
        kind: "todo_list",
        id: "todos",
        steps: [{ text: `step ${turn}`, status: "in_progress" }],
      },
    });
    push({
      type: "item.started",
      item: {
        kind: "command",
        id: id("cmd"),
        command: "pnpm test",
        output: "",
        exitCode: null,
        status: "running",
      },
    });
    push({ type: "item.delta", itemId: id("cmd"), chunk: "ok 1\n" });
    push({
      type: "item.completed",
      item: {
        kind: "command",
        id: id("cmd"),
        command: "pnpm test",
        output: "ok 1\n",
        exitCode: 0,
        status: "completed",
      },
    });
    push({ type: "item.started", item: { kind: "assistant_message", id: id("reply"), text: "" } });
    for (const chunk of ["Done ", "with ", input.text]) {
      push({ type: "item.delta", itemId: id("reply"), chunk });
    }
    const finish = () => {
      push({
        type: "item.completed",
        item: { kind: "assistant_message", id: id("reply"), text: `Done with ${input.text}` },
      });
      push({
        type: "item.updated",
        item: {
          kind: "todo_list",
          id: "todos",
          steps: [{ text: `step ${turn}`, status: "completed" }],
        },
      });
      push({ type: "turn.ended", turnId: `turn-${turn}`, status: "completed", error: null });
    };
    if (input.text.endsWith("ASK")) {
      this.#pending = finish;
      push({
        type: "request.opened",
        request: {
          kind: "approval",
          id: id("ask"),
          title: "Run?",
          detail: "",
          action: { type: "command", command: "ls", cwd: null },
          options: [{ id: "yes", label: "Yes", effect: "allow" }],
          defaultOptionId: "yes",
        },
      });
      return;
    }
    setTimeout(finish, 2);
  }

  async steer(): Promise<void> {}
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

  async setInteractionMode(): Promise<void> {}

  async listModels() {
    return [
      {
        id: "big",
        aliases: [],
        label: "Big",
        description: "",
        efforts: [],
        defaultEffort: null,
        isDefault: true,
      },
    ];
  }

  async close(): Promise<void> {
    this.events.push({ type: "session.closed", error: null });
    this.events.end();
  }
}

const settings: SessionOptions = {
  cwd: "/work",
  model: null,
  effort: null,
  runtimeMode: "supervised",
  interactionMode: "default",
  resume: null,
};

const context = { width: 70, cwd: "/work", blink: true, now: 1_000_000 };
const rows = (view: ThreadView) =>
  view.transcript.view(context, 1000, 0).rows.map((row) => stripVTControlCharacters(row));
const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

let root: string;
let host: Host;
let unregister: (() => void)[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-host-"));
  unregister = [
    registerDriver({
      id: "scripted",
      label: "Scripted",
      unavailable: () => null,
      create: (options) => new ScriptedSession(options),
    }),
  ];
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  for (const undo of unregister) undo();
  rmSync(root, { recursive: true, force: true });
});

function newHost(extensions: string[] = []): Host {
  host = new Host({
    version: "test",
    cwd: root,
    extensions,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
  });
  return host;
}

async function connect(id: string): Promise<HostClient> {
  const client = new HostClient(
    new LocalConnection(host, id, { owns: false }),
    { cwd: "/work", version: "test", extensions: [] },
    id,
  );
  await client.connect();
  return client;
}

/** Waits until a thread has nothing to do, as its state says. */
async function idle(client: HostClient, id: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const state = client.threads.get(id);
    if (state && state.status === "idle" && state.queue.length === 0) return;
    await settle(5);
  }
  throw new Error(`${id} did not settle`);
}

describe("Host", () => {
  it("replays a thread's log to show what showing it live did", async () => {
    newHost();
    const client = await connect("tui");
    const live = new ThreadView("live");
    const entries: LogEntry[] = [];
    let threadId = "";
    client.on((event) => {
      if (event.type === "entry" && event.threadId === threadId) {
        entries.push(event.entry);
        live.apply(event.entry, {
          busy: client.threads.get(threadId)?.busy ?? false,
          agent: (id) => {
            const child = client.threads.get(id);
            return child ? agentRowOf(child) : null;
          },
        });
      }
    });
    const opened = await client.call("thread.open", { harness: "scripted", settings });
    threadId = opened.id;
    await client.call("thread.send", { threadId, text: "the parser" });
    await idle(client, threadId);
    await client.call("thread.send", { threadId, text: "the lexer" });
    await idle(client, threadId);
    // Streamed text went out live, as deltas.
    assert.ok(entries.some((entry) => entry.type === "delta"));

    const page = await client.call("thread.attach", { threadId });
    // The log holds each item once, with its text, and no deltas.
    assert.equal(page.entries.filter((logged) => logged.entry.type === "delta").length, 0);
    const replayed = new ThreadView("replayed");
    for (const logged of page.entries)
      replayed.apply(logged.entry, { busy: false, agent: () => null });
    assert.deepEqual(rows(replayed), rows(live));
    const shown = rows(replayed).join("\n");
    // Each turn shows its own todo list, though the harness reused one ID.
    assert.match(shown, /step 1[\s\S]*step 2/);
    assert.match(shown, /Done with the lexer/);
  });

  it("keeps each thread's state for clients, and answers its requests", async () => {
    newHost();
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    assert.equal(thread.openedBy, "tui");
    await client.call("thread.send", { threadId: thread.id, text: "go ASK" });
    await settle();
    const asking = client.threads.get(thread.id)!;
    assert.equal(asking.status, "waiting");
    assert.equal(asking.requests[0]?.id, "1-ask");
    await client.call("thread.respond", {
      threadId: thread.id,
      requestId: "1-ask",
      response: { kind: "approval", optionId: "yes" },
    });
    await idle(client, thread.id);
    const done = client.threads.get(thread.id)!;
    assert.equal(done.runCount, 1);
    assert.equal(done.lastRun?.result, "Done with go ASK");
    assert.equal(done.title, "go ASK");
  });

  it("sends a retried message once", async () => {
    newHost();
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    const first = await client.call("thread.send", {
      threadId: thread.id,
      text: "once",
      requestId: "r1",
    });
    const again = await client.call("thread.send", {
      threadId: thread.id,
      text: "once",
      requestId: "r1",
    });
    assert.equal(again.messageId, first.messageId);
    await idle(client, thread.id);
    assert.equal(client.threads.get(thread.id)?.runCount, 1);
  });

  it("runs session calls on the allowlist, waking a parked thread", async () => {
    newHost();
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    assert.ok(await host.manager.park(thread.id));
    await settle(5);
    assert.equal(client.threads.get(thread.id)?.status, "parked");
    // Its harness's methods are still known while parked.
    assert.ok(client.threads.get(thread.id)?.methods.includes("listModels"));
    const models = (await client.call("thread.call", {
      threadId: thread.id,
      method: "listModels",
      args: [],
    })) as { id: string }[];
    assert.equal(models[0]?.id, "big");
    await settle(5);
    assert.equal(client.threads.get(thread.id)?.status, "idle");
    await assert.rejects(
      client.call("thread.call", {
        threadId: thread.id,
        method: "close" as never,
        args: [],
      }),
      /cannot run close/,
    );
  });

  it("drops a thread a client opened and left empty, but keeps one with work", async () => {
    newHost();
    const client = await connect("tui");
    const removed: string[] = [];
    client.on((event) => {
      if (event.type === "removed") removed.push(event.threadId);
    });
    const empty = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("client.show", { threadId: empty.id });
    const used = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("client.show", { threadId: used.id });
    assert.deepEqual(removed, [empty.id]);
    assert.equal(client.threads.has(empty.id), false);
    await client.call("thread.send", { threadId: used.id, text: "hello" });
    await idle(client, used.id);
    const other = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("client.show", { threadId: other.id });
    assert.equal(client.threads.get(used.id)?.status, "idle");
  });

  it("says in the thread how a switch went", async () => {
    newHost();
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    const notices: string[] = [];
    client.on((event) => {
      if (
        event.type === "entry" &&
        event.entry.type === "item" &&
        event.entry.item.kind === "notice"
      )
        notices.push(event.entry.item.text);
    });
    await assert.rejects(
      client.call("thread.switchHarness", { threadId: thread.id, harness: "nope" }),
      /No harness named nope/,
    );
    assert.match(notices.at(-1) ?? "", /Could not move to nope/);
    const result = await client.call("thread.switchHarness", {
      threadId: thread.id,
      harness: "scripted",
      fresh: true,
    });
    assert.equal(result.resumed, false);
    assert.match(notices.at(-1) ?? "", /Now on Scripted, in a new thread/);
  });

  it("runs a host command's pick through the client that ran it", async () => {
    const extension = join(root, "choose.mjs");
    writeFileSync(
      extension,
      `export default (api) => api.registerCommand({
        name: "choose",
        description: "pick one",
        group: "Test",
        async run(context) {
          const index = await context.ui.pick("Pick one", [{ label: "a" }, { label: "b" }]);
          context.ui.notify("info", "chose " + index);
        },
      });\n`,
    );
    newHost([extension]);
    const client = await connect("tui");
    const other = await connect("other");
    const seen: string[] = [];
    client.on((event) => {
      if (event.type !== "ui") return;
      if (event.request.method === "pick") {
        seen.push(event.request.title);
        void client.call("ui.reply", { id: event.request.id, result: 1 });
      }
      if (event.request.method === "notify") seen.push(event.request.text);
    });
    other.on((event) => {
      if (event.type === "ui") seen.push(`other saw ${event.request.method}`);
    });
    const list = await client.call("commands.list", { threadId: null });
    assert.ok(list.some((info) => info.name === "choose"));
    await client.call("commands.run", { threadId: null, name: "choose", args: "" });
    await settle(5);
    assert.deepEqual(seen, ["Pick one", "chose 1"]);
  });

  it("answers a pick as dismissed when its client leaves", async () => {
    const extension = join(root, "wait.mjs");
    writeFileSync(
      extension,
      `export default (api) => api.registerCommand({
        name: "wait",
        description: "",
        group: "Test",
        async run(context) {
          globalThis.waited = await context.ui.pick("Pick", [{ label: "a" }]);
        },
      });\n`,
    );
    newHost([extension]);
    const client = await connect("tui");
    const running = client.call("commands.run", { threadId: null, name: "wait", args: "" });
    await settle(5);
    await host.disconnect("tui");
    await running;
    assert.equal((globalThis as { waited?: unknown }).waited, null);
  });
});
