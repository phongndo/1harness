import { shortThreadId } from "../core/thread-id.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import type { SessionOptions } from "../core/events.ts";
import type { LogEntry } from "../protocol.ts";
import { agentRowOf } from "../tui/agents.ts";
import { ThreadView } from "../tui/view.ts";
import { Store } from "../store/store.ts";
import { ScriptedSession, registerScripted } from "../testing/scripted.ts";
import { registerDriver, type DriverDefinition, type SignIn } from "../drivers/index.ts";
import { Host } from "./host.ts";
import { UNKNOWN_OUTCOME } from "./manager.ts";

const settings: SessionOptions = {
  cwd: "/work",
  model: null,
  effort: null,
  runtimeMode: "supervised",
  interactionMode: "default",
  resume: null,
};

// In detail, so finished turns show their work, not only its summary.
const context = { width: 70, cwd: "/work", blink: true, now: 1_000_000, details: true };
const rows = (view: ThreadView) =>
  view.transcript.view(context, 1000, 0).rows.map((row) => stripVTControlCharacters(row));
const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

let root: string;
let host: Host;
let unregister: (() => void)[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-host-"));
  unregister = [registerScripted()];
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  for (const undo of unregister) undo();
  rmSync(root, { recursive: true, force: true });
});

/** Where the `gated` harness stands, as a client last heard. */
function gatedState(client: HostClient): string | undefined {
  return client.harnesses.find((harness) => harness.id === "gated")?.state;
}

function newHost(extensions: string[] = [], store: Store | null = null): Host {
  host = new Host({
    version: "test",
    cwd: root,
    extensions,
    store,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
  });
  return host;
}

async function connect(id: string, extensions: string[] = []): Promise<HostClient> {
  const client = new HostClient(
    new LocalConnection(host, id, { owns: false }),
    { cwd: "/work", version: "test", extensions },
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

/** Stops a host as a crash would: its store closes, and nothing else is written. */
function crash(store: Store): void {
  store.close();
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
    // The transcript keeps what was asked and what the user chose.
    const page = await client.call("thread.attach", { threadId: thread.id });
    const decision = page.entries.find(({ entry }) => entry.type === "decision")?.entry;
    assert.deepEqual(decision && { ...decision, at: 0 }, {
      type: "decision",
      kind: "approval",
      title: asking.requests[0]?.kind === "approval" ? asking.requests[0].title : "",
      answer: "Yes",
      outcome: "allowed",
      at: 0,
    });
  });

  it("records an answer to a request once, however many clients answer it", async () => {
    newHost();
    const client = await connect("tui");
    const other = await connect("other");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "go ASK" });
    await settle();
    const answer = (who: typeof client, optionId: string) =>
      who.call("thread.respond", {
        threadId: thread.id,
        requestId: "1-ask",
        response: optionId ? { kind: "approval", optionId } : { kind: "cancel" },
      });
    await Promise.all([answer(client, "yes"), answer(other, "")]);
    await idle(client, thread.id);
    const page = await client.call("thread.attach", { threadId: thread.id });
    const decisions = page.entries.filter(({ entry }) => entry.type === "decision");
    assert.equal(decisions.length, 1);
  });

  it("keeps the empty thread a client left until the one it went to starts", async () => {
    newHost();
    // A harness whose session is made but cannot start.
    const undo = registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) =>
        Object.assign(new ScriptedSession(options), {
          start: async () => {
            await settle(10);
            throw new Error("cannot start");
          },
        }),
    });
    try {
      const client = await connect("tui");
      const first = await client.call("thread.open", { harness: "scripted", settings });
      await client.call("client.show", { threadId: first.id });
      const opening = client.call("thread.open", { harness: "broken", settings }).then(
        () => null,
        (error: unknown) => error,
      );
      // The terminal shows the new thread as it starts, before the open settles.
      await settle(0);
      const started = [...client.threads.values()].find((thread) => thread.harness === "broken");
      if (started) await client.call("client.show", { threadId: started.id });
      assert.match(String(await opening), /cannot start/);
      await settle();
      assert.ok(client.threads.has(first.id), "the thread to go back to is still there");
      // Back on it, it is the client's again: a later change does not discard it.
      await client.call("client.show", { threadId: first.id });
      await client.call("thread.rename", { threadId: first.id, title: "kept" });
      await settle();
      assert.ok(client.threads.has(first.id), "the thread gone back to stays");
    } finally {
      undo();
    }
  });

  it("asks a thread's harness where it stands as it opens, comes back, or fails to start a turn", async () => {
    newHost();
    let answer: SignIn = { state: "signed-out", detail: "run `gated login` to sign in" };
    let asked = 0;
    const gated: DriverDefinition = {
      id: "gated",
      label: "Gated",
      unavailable: () => null,
      signIn: async () => {
        asked++;
        return answer;
      },
      create: (options) =>
        Object.assign(new ScriptedSession(options), {
          startTurn: async () => {
            throw new Error("Not logged in");
          },
        }),
    };
    const undo = registerDriver(gated);
    try {
      const client = await connect("tui");
      const thread = await client.call("thread.open", { harness: "gated", settings });
      await settle();
      assert.equal(asked, 1);
      assert.equal(gatedState(client), "signed-out", "clients hear what the check found");
      await client.call("thread.resume", { id: thread.id, harness: "gated", settings });
      await settle();
      assert.equal(asked, 2);
      answer = { state: "ready" };
      await client.call("harnesses.list", { id: "gated" });
      assert.equal(gatedState(client), "ready");
      // A ready harness is not asked again, unless a turn will not start on it.
      answer = { state: "signed-out", detail: "run `gated login` to sign in" };
      await client.call("thread.send", { threadId: thread.id, text: "hi" });
      await settle();
      assert.equal(gatedState(client), "signed-out");
      // A delegation's check reaches clients too.
      answer = { state: "ready" };
      assert.equal((await host.orchestrator.checkHarness(gated)).state, "ready");
      await settle();
      assert.equal(gatedState(client), "ready");
    } finally {
      undo();
    }
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
    assert.match(notices.at(-1) ?? "", /Now on Scripted, in a new session/);
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
    newHost();
    const client = await connect("tui", [extension]);
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
    newHost();
    const client = await connect("tui", [extension]);
    const running = client.call("commands.run", { threadId: null, name: "wait", args: "" });
    await settle(5);
    await host.disconnect("tui");
    await running;
    assert.equal((globalThis as { waited?: unknown }).waited, null);
  });
});

describe("Pages the agent shows", () => {
  it("puts a page in its thread's log, which the view shows as text without pictures", async () => {
    newHost();
    const client = await connect("tui");
    const opened = await client.call("thread.open", { harness: "scripted", settings });
    const render = host.pageTools.find((tool) => tool.name === "html_render")!;
    await render.execute(
      { html: "<h1>Build times</h1><ul><li>lexer 2s</li><li>parser 5s</li></ul>", title: "Builds" },
      { thread: host.manager.get(opened.id)!.thread },
    );
    const page = await client.call("thread.attach", { threadId: opened.id });
    const entry = page.entries.find((logged) => logged.entry.type === "html")?.entry;
    assert.deepEqual(entry && { ...entry, at: 0 }, {
      type: "html",
      title: "Builds",
      html: "<h1>Build times</h1><ul><li>lexer 2s</li><li>parser 5s</li></ul>",
      at: 0,
    });
    const view = new ThreadView(opened.id);
    for (const logged of page.entries) view.apply(logged.entry, { busy: false, agent: () => null });
    const shown = rows(view).join("\n");
    assert.match(shown, /▣ Builds · page/);
    assert.match(shown, /Build times\n\s+• lexer 2s\n\s+• parser 5s/);
  });

  it("shows a page from a file where the thread runs, such as one a script wrote", async () => {
    newHost();
    const client = await connect("tui");
    const opened = await client.call("thread.open", {
      harness: "scripted",
      settings: { ...settings, cwd: root },
    });
    const thread = host.manager.get(opened.id)!.thread;
    writeFileSync(join(root, "chart.html"), "<h1>From a file</h1>");
    const render = host.pageTools.find((tool) => tool.name === "html_render")!;
    await render.execute({ path: "chart.html", title: "Chart" }, { thread });
    const page = await client.call("thread.attach", { threadId: opened.id });
    const entry = page.entries.find((logged) => logged.entry.type === "html")?.entry;
    assert.equal(entry?.type === "html" ? entry.html : null, "<h1>From a file</h1>");
  });

  it("refuses a page with no HTML, and one from a thread it does not manage", async () => {
    newHost();
    const client = await connect("tui");
    const opened = await client.call("thread.open", { harness: "scripted", settings });
    const render = host.pageTools.find((tool) => tool.name === "html_render")!;
    const thread = host.manager.get(opened.id)!.thread;
    await assert.rejects(
      async () => render.execute({ html: "  " }, { thread }),
      /html or path is required/,
    );
    await assert.rejects(
      async () => render.execute({ path: "missing.html" }, { thread }),
      /ENOENT/,
    );
    const other = newHost();
    const stranger = other.pageTools.find((tool) => tool.name === "html_render")!;
    await assert.rejects(
      async () => stranger.execute({ html: "<p>hi</p>" }, { thread }),
      /not managed by 1harness/,
    );
  });
});

describe("Host with a store", () => {
  let file: string;
  let count = 0;
  const fresh = () => {
    file = join(root, `store-${++count}.db`);
    return Store.open(file);
  };

  it("brings threads back parked, with their transcripts, and resumes their harness", async () => {
    newHost([], fresh());
    let client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "the parser" });
    await idle(client, thread.id);
    const native = client.threads.get(thread.id)?.info.threadId;
    const saved = await client.call("thread.attach", { threadId: thread.id });
    await host.shutdown();

    newHost([], Store.open(file));
    client = await connect("tui");
    const back = client.threads.get(thread.id);
    assert.equal(back?.status, "parked");
    assert.equal(back?.runCount, 1);
    const restored = await client.call("thread.attach", { threadId: thread.id });
    // The same transcript, and the session that ended when the host stopped.
    assert.deepEqual(restored.entries.slice(0, saved.entries.length), saved.entries);
    assert.deepEqual(
      restored.entries.slice(saved.entries.length).map((logged) => logged.entry),
      [{ type: "session.ended", error: null }],
    );
    // IDs are never reused.
    const next = await client.call("thread.open", { harness: "scripted", settings });
    assert.notEqual(next.id, thread.id);
    await client.call("thread.send", { threadId: thread.id, text: "the lexer" });
    await idle(client, thread.id);
    const session = host.manager.get(thread.id)?.thread.session as unknown as ScriptedSession;
    assert.equal(session.options.resume, native);
    assert.deepEqual(session.prompts, ["the lexer"]);
  });

  it("marks a turn a crash cut off as interrupted, holds the queue, and sends nothing again", async () => {
    const store = fresh();
    const first = newHost([], store);
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "go ASK" });
    await client.call("thread.send", { threadId: thread.id, text: "queued one" });
    await client.call("thread.send", { threadId: thread.id, text: "queued two" });
    await settle();
    crash(store);
    await first.manager.closeAll();

    newHost([], Store.open(file));
    const again = await connect("tui");
    const back = again.threads.get(thread.id)!;
    assert.equal(back.status, "parked");
    assert.equal(back.held, true);
    assert.deepEqual(
      back.queue.map((message) => message.input.text),
      ["queued one", "queued two"],
    );
    assert.equal(back.lastRun?.status, "interrupted");
    assert.equal(back.lastRun?.error, UNKNOWN_OUTCOME);
    // Nothing started by itself.
    await settle();
    assert.equal(host.manager.get(thread.id)?.thread.session, null);
    // The user's next message lets the queue go, after it.
    await again.call("thread.send", { threadId: thread.id, text: "now" });
    for (let tries = 0; tries < 100; tries++) {
      const prompts = (
        host.manager.get(thread.id)?.thread.session as unknown as ScriptedSession | null
      )?.prompts;
      if (prompts?.length === 3) break;
      await settle(5);
    }
    const session = host.manager.get(thread.id)?.thread.session as unknown as ScriptedSession;
    assert.deepEqual(session.prompts, ["queued one", "queued two", "now"]);
  });

  it("writes again what a failed save left out, and goes on recording messages", async () => {
    const store = fresh();
    const first = newHost([], store);
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await settle();
    // The disk fails for a while, partway through each write.
    let failing = true;
    const disk = <A extends unknown[]>(write: (...args: A) => void) => {
      const real = write.bind(store);
      return (...args: A) => {
        if (failing) throw new Error("disk I/O error");
        real(...args);
      };
    };
    store.saveSeq = disk(store.saveSeq);
    store.recordMessage = disk(store.recordMessage);
    await client.call("thread.send", { threadId: thread.id, text: "go ASK" });
    await settle();
    failing = false;
    await client.call("thread.send", { threadId: thread.id, text: "queued one" });
    await settle();
    crash(store);
    await first.manager.closeAll();

    newHost([], Store.open(file));
    const again = await connect("tui");
    assert.deepEqual(
      again.threads.get(thread.id)?.queue.map((message) => message.input.text),
      ["queued one"],
    );
    const { entries } = await again.call("thread.attach", { threadId: thread.id });
    assert.ok(
      entries.some(
        ({ entry }) =>
          entry.type === "item" &&
          entry.item.kind === "user_message" &&
          entry.item.text === "go ASK",
      ),
    );
  });

  it("records the messages admitted while the disk failed, in order, once it writes again", async () => {
    const store = fresh();
    const first = newHost([], store);
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await settle();
    let failing = true;
    for (const name of ["recordMessage", "setMessageState"] as const) {
      const real = store[name].bind(store) as (...args: unknown[]) => void;
      (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        if (failing) throw new Error("disk I/O error");
        real(...args);
      };
    }
    // Runs, so it must not be stored as still queued; the next one waits behind it.
    await client.call("thread.send", { threadId: thread.id, text: "go ASK" });
    await settle();
    await client.call("thread.send", { threadId: thread.id, text: "queued while failing" });
    await settle();
    failing = false;
    await client.call("thread.send", { threadId: thread.id, text: "queued after" });
    await settle();
    crash(store);
    await first.manager.closeAll();

    newHost([], Store.open(file));
    const again = await connect("tui");
    assert.deepEqual(
      again.threads.get(thread.id)?.queue.map((message) => message.input.text),
      ["queued while failing", "queued after"],
    );
  });

  it("does not write back a thread forgotten while its messages waited to be saved", async () => {
    const store = fresh();
    newHost([], store);
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await settle();
    let failing = true;
    const real = store.recordMessage.bind(store);
    store.recordMessage = (...args) => {
      if (failing) throw new Error("disk I/O error");
      real(...args);
    };
    await client.call("thread.send", { threadId: thread.id, text: "hello" });
    await settle();
    await client.call("thread.forget", { threadId: thread.id });
    failing = false;
    await client.call("thread.open", { harness: "scripted", settings });
    await settle();
    assert.equal(store.thread(thread.id), null);
  });

  it("answers a retried message from before a restart without sending it", async () => {
    const store = fresh();
    newHost([], store);
    let client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    const sent = await client.call("thread.send", {
      threadId: thread.id,
      text: "once",
      requestId: "r-1",
    });
    await idle(client, thread.id);
    await host.shutdown();
    newHost([], Store.open(file));
    client = await connect("tui");
    const again = await client.call("thread.send", {
      threadId: thread.id,
      text: "once",
      requestId: "r-1",
    });
    assert.equal(again.messageId, sent.messageId);
    await settle();
    assert.equal(client.threads.get(thread.id)?.status, "parked");
  });

  it("reopens a closed thread by its ID, and a harness's thread by its own ID", async () => {
    newHost([], fresh());
    let client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "hello" });
    await idle(client, thread.id);
    const native = client.threads.get(thread.id)!.info.threadId!;
    await client.call("thread.close", { threadId: thread.id });
    await host.shutdown();

    newHost([], Store.open(file));
    client = await connect("tui");
    assert.equal(client.threads.has(thread.id), false);
    const listed = await client.call("threads.list", { scope: "recent" });
    assert.ok(listed.some((entry) => entry.id === thread.id && entry.status === "closed"));
    const byNative = await client.call("thread.resume", {
      id: native,
      harness: "scripted",
      settings,
    });
    assert.equal(byNative.id, thread.id);
    assert.equal(byNative.status, "parked");
    const byId = await client.call("thread.resume", {
      id: thread.id,
      harness: "scripted",
      settings,
    });
    assert.equal(byId.id, thread.id);
    const byShort = await client.call("thread.resume", {
      id: shortThreadId(thread.id),
      harness: "scripted",
      settings,
    });
    assert.equal(byShort.id, thread.id);
    const page = await client.call("thread.attach", { threadId: shortThreadId(thread.id) });
    assert.equal(page.thread.id, thread.id);
  });

  it("reopens a closed thread still in memory without telling clients it went away", async () => {
    newHost([], fresh());
    const client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "hello" });
    await idle(client, thread.id);
    await client.call("thread.close", { threadId: thread.id });
    // A client whose reply comes before the events would lose the thread on a removal.
    const removed: string[] = [];
    client.on((event) => {
      if (event.type === "removed") removed.push(event.threadId);
    });
    const reopened = await client.call("thread.resume", {
      id: thread.id,
      harness: "scripted",
      settings,
    });
    assert.equal(reopened.status, "parked");
    await settle();
    assert.deepEqual(removed, []);
    assert.equal(client.threads.get(thread.id)?.status, "parked");
  });

  it("does not report a task cut off by a crash to the thread that started it", async () => {
    const store = fresh();
    const first = newHost([], store);
    const client = await connect("tui");
    const parent = await client.call("thread.open", { harness: "scripted", settings });
    const delegate = first.orchestrator.tools.find((tool) => tool.name === "delegate_task")!;
    const result = JSON.parse(
      String(
        await delegate.execute(
          { task: "look ASK", wait: false },
          { thread: first.manager.get(parent.id)!.thread },
        ),
      ),
    ) as { taskId: string };
    await settle();
    crash(store);
    await first.manager.closeAll();

    newHost([], Store.open(file));
    const again = await connect("tui");
    await settle(30);
    const child = again.threads.get(result.taskId);
    assert.equal(child?.lastRun?.status, "interrupted");
    const back = again.threads.get(parent.id)!;
    assert.equal(back.runCount, 0);
    assert.equal(back.queue.length, 0);
    assert.equal(host.manager.get(parent.id)?.thread.session, null);
  });
});

/** A thread the scripted harness has run `messages` on, one turn each. */
async function threadWith(client: HostClient, ...messages: string[]) {
  const thread = await client.call("thread.open", { harness: "scripted", settings });
  for (const text of messages) {
    await client.call("thread.send", { threadId: thread.id, text });
    await idle(client, thread.id);
  }
  return thread;
}

describe("Managing threads over time", () => {
  let count = 0;
  const store = () => Store.open(join(root, `manage-${++count}.db`));

  it("renames, pins, and archives threads, and lists them by where they belong", async () => {
    newHost([], store());
    const client = await connect("tui");
    const first = await threadWith(client, "parser work");
    const second = await threadWith(client, "lexer work");
    await client.call("thread.rename", { threadId: first.id, title: "The parser" });
    await settle(5);
    assert.equal(client.threads.get(first.id)?.title, "The parser");
    await client.call("thread.flag", { threadId: first.id, pinned: true });
    const recent = await client.call("threads.list", { scope: "recent" });
    // Pinned first, then newest.
    assert.deepEqual(
      recent.map((thread) => thread.id),
      [first.id, second.id],
    );
    const archived = await client.call("thread.flag", { threadId: second.id, archived: true });
    assert.equal(archived.status, "closed");
    assert.deepEqual(
      (await client.call("threads.list", { scope: "recent" })).map((thread) => thread.id),
      [first.id],
    );
    assert.deepEqual(
      (await client.call("threads.list", { scope: "archived" })).map((thread) => thread.id),
      [second.id],
    );
  });

  it("finds threads by what was said in them", async () => {
    newHost([], store());
    const client = await connect("tui");
    const parser = await threadWith(client, "the tokenizer drops tabs");
    await threadWith(client, "something else");
    const found = await client.call("threads.search", { query: "tokeniz" });
    assert.deepEqual(
      found.map((hit) => hit.thread.id),
      [parser.id],
    );
    assert.match(found[0]?.snippet ?? "", /tokenizer/);
  });

  it("forks a thread through a turn, handing the new one those turns", async () => {
    newHost([], store());
    const client = await connect("tui");
    const source = await threadWith(client, "first idea", "second idea", "third idea");
    const fork = await client.call("thread.fork", { threadId: source.id, turn: 2 });
    assert.notEqual(fork.id, source.id);
    assert.match(fork.title, /\(fork\)$/);
    await client.call("thread.send", { threadId: fork.id, text: "go on" });
    await idle(client, fork.id);
    const session = host.manager.get(fork.id)?.thread.session as unknown as ScriptedSession;
    const prompt = session.prompts[0] ?? "";
    assert.match(prompt, new RegExp(`starts from thread ${source.id}, as it stood after turn 2`));
    assert.match(prompt, /second idea/);
    assert.doesNotMatch(prompt, /third idea/);
    assert.match(prompt, /go on$/);
    await assert.rejects(
      client.call("thread.fork", { threadId: source.id, turn: 9 }),
      /has turns 1 to 3/,
    );
  });

  it("forgets a thread for good, with what it started", async () => {
    newHost([], store());
    const client = await connect("tui");
    const thread = await threadWith(client, "remember nothing");
    const { forgotten } = await client.call("thread.forget", { threadId: thread.id });
    assert.deepEqual(forgotten, [thread.id]);
    await settle(5);
    assert.equal(client.threads.has(thread.id), false);
    assert.deepEqual(await client.call("threads.list", { scope: "recent" }), []);
    await assert.rejects(client.call("thread.attach", { threadId: thread.id }), /No thread/);
  });

  it("keeps nothing for a thread once it leaves memory, however it goes", async () => {
    newHost([], store());
    const client = await connect("tui");
    // Shown, then left empty for another, it is dropped.
    const empty = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("client.show", { threadId: empty.id });
    const forgotten = await threadWith(client, "pin me");
    await client.call("client.show", { threadId: forgotten.id });
    assert.equal(host.manager.get(empty.id), undefined);
    await client.call("thread.flag", { threadId: forgotten.id, pinned: true });
    await client.call("thread.forget", { threadId: forgotten.id });
    // Closed, it is stored and leaves memory, and flagging it there keeps it there.
    const closed = await threadWith(client, "close me");
    await client.call("thread.close", { threadId: closed.id });
    await settle(5);
    assert.equal(host.manager.get(closed.id), undefined);
    await client.call("thread.flag", { threadId: closed.id, pinned: true });
    assert.deepEqual(host.trackedThreads, []);
  });

  it("deletes closed threads past the retention when it starts, but not pinned ones", async () => {
    const file = join(root, `manage-${++count}.db`);
    newHost([], Store.open(file));
    let client = await connect("tui");
    const old = await threadWith(client, "old work");
    const kept = await threadWith(client, "kept work");
    await client.call("thread.flag", { threadId: kept.id, pinned: true });
    await client.call("thread.close", { threadId: old.id });
    await client.call("thread.close", { threadId: kept.id });
    await host.shutdown();
    // A day passes.
    const later = Date.now() + 2 * 86_400_000;
    const now = Date.now;
    Date.now = () => later;
    try {
      host = new Host({
        version: "test",
        cwd: root,
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        idleCloseMs: 0,
        store: Store.open(file),
        retainClosedDays: 1,
      });
      client = await connect("tui");
      const left = await client.call("threads.list", { scope: "recent" });
      assert.deepEqual(
        left.map((thread) => thread.id),
        [kept.id],
      );
    } finally {
      Date.now = now;
    }
  });

  it("keeps a fork's starting turns through a park before its first message", async () => {
    newHost([], store());
    const client = await connect("tui");
    const source = await threadWith(client, "the plan");
    const fork = await client.call("thread.fork", { threadId: source.id });
    assert.ok(await host.manager.park(fork.id));
    await client.call("thread.send", { threadId: fork.id, text: "continue" });
    await idle(client, fork.id);
    const session = host.manager.get(fork.id)!.thread.session as unknown as ScriptedSession;
    const prompt = session.prompts[0] ?? "";
    assert.match(prompt, /starts from thread/);
    assert.match(prompt, /the plan/);
  });

  it("forks a stored closed thread without reopening it, and forgets tasks with threads", async () => {
    const file = join(root, `manage-${++count}.db`);
    newHost([], Store.open(file));
    let client = await connect("tui");
    const source = await threadWith(client, "old idea");
    await client.call("thread.close", { threadId: source.id });
    await host.shutdown();
    newHost([], Store.open(file));
    client = await connect("tui");
    await client.call("thread.fork", { threadId: source.id });
    const listed = await client.call("threads.list", { scope: "recent" });
    assert.equal(listed.find((thread) => thread.id === source.id)?.status, "closed");
    assert.equal(host.manager.get(source.id), undefined);

    const parent = await threadWith(client, "delegate");
    const delegate = host.orchestrator.tools.find((tool) => tool.name === "delegate_task")!;
    await delegate.execute(
      { task: "help", wait: true },
      { thread: host.manager.get(parent.id)!.thread },
    );
    assert.equal(host.orchestrator.taskRows().length, 1);
    await client.call("thread.forget", { threadId: parent.id });
    assert.deepEqual(host.orchestrator.taskRows(), []);
  });

  it("does not bring back what a closed thread had queued when it is reopened", async () => {
    const file = join(root, `manage-${++count}.db`);
    newHost([], Store.open(file));
    let client = await connect("tui");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "wait ASK" });
    await client.call("thread.send", { threadId: thread.id, text: "queued" });
    await settle();
    await client.call("thread.close", { threadId: thread.id });
    await host.shutdown();
    newHost([], Store.open(file));
    client = await connect("tui");
    const back = await client.call("thread.resume", {
      id: thread.id,
      harness: "scripted",
      settings,
    });
    assert.equal(back.held, false);
    assert.deepEqual(back.queue, []);
  });
});
