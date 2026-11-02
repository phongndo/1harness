import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { FileIndex } from "../core/files.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { Store } from "../store/store.ts";
import { registerScripted, scriptedSettings as settings } from "../testing/scripted.ts";
import { Host } from "./host.ts";
import { MAX_HTML_BYTES } from "./media.ts";

// What a long-lived host keeps stays bounded, and what it is done with it lets go.

let root: string;
let host: Host;
let unregister: () => void;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-bounds-"));
  unregister = registerScripted();
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

function newHost(store: Store | null = null): Host {
  host = new Host({
    version: "test",
    cwd: root,
    store,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
  });
  return host;
}

async function connect(id: string): Promise<HostClient> {
  const client = new HostClient(
    new LocalConnection(host, id, { owns: false }),
    { cwd: root, version: "test", extensions: [] },
    id,
  );
  await client.connect();
  return client;
}

describe("A long-lived host", () => {
  it("keeps recent events for catching up by their size, not only their count", async () => {
    newHost();
    const client = await connect("tui");
    const opened = await client.call("thread.open", { harness: "scripted", settings });
    const render = host.pageTools.find((tool) => tool.name === "html_render")!;
    const from = host.seq;
    const html = `<p>${"x".repeat(MAX_HTML_BYTES - 16)}</p>`;
    // About 100 MB of pages, far fewer events than the count allows.
    for (let page = 0; page < 200; page++)
      await render.execute(
        { html, title: `Page ${page}` },
        {
          thread: host.manager.get(opened.id)!.thread,
        },
      );
    assert.equal(host.since(from), null);
    const kept = host.since(host.seq - 10);
    assert.equal(kept?.length, 10);
  });

  it("keeps file indexes for a few folders, closing the rest, and names a folder one way", async () => {
    newHost();
    const loaded: string[] = [];
    const closed: string[] = [];
    const { load, close } = FileIndex.prototype;
    FileIndex.prototype.load = function () {
      loaded.push(this.cwd);
      return Promise.resolve();
    };
    FileIndex.prototype.close = function () {
      closed.push(this.cwd);
    };
    try {
      for (let folder = 0; folder < 40; folder++)
        await host.call("tui", "files.search", {
          cwd: join(root, `f${folder}`),
          query: "a",
          limit: 5,
        });
      assert.ok(loaded.length - closed.length <= 8, `${loaded.length - closed.length} kept`);
      const from = loaded.length;
      await host.call("tui", "files.search", { cwd: "~/1harness-x", query: "a", limit: 5 });
      await host.call("tui", "files.search", {
        cwd: join(homedir(), "1harness-x"),
        query: "a",
        limit: 5,
      });
      assert.deepEqual(loaded.slice(from), [join(homedir(), "1harness-x")]);
    } finally {
      FileIndex.prototype.load = load;
      FileIndex.prototype.close = close;
    }
  });

  it("keeps extensions for a few folders no thread uses, closing the rest", async () => {
    newHost();
    let loaded = 0;
    let closed = 0;
    const { loadAll, close } = ExtensionHost.prototype;
    ExtensionHost.prototype.loadAll = function (...args) {
      loaded++;
      return loadAll.apply(this, args);
    };
    ExtensionHost.prototype.close = function () {
      closed++;
      return close.apply(this);
    };
    try {
      const client = await connect("tui");
      const opened = await client.call("thread.open", { harness: "scripted", settings });
      const own = host.manager.extensionsOf(opened.id);
      for (let folder = 0; folder < 40; folder++) {
        const cwd = join(root, `x${folder}`);
        mkdirSync(cwd, { recursive: true });
        await host.call("roaming", "client.hello", {
          clientId: "roaming",
          cwd,
          version: "test",
          extensions: [],
        });
      }
      await new Promise((done) => setTimeout(done, 20));
      assert.ok(loaded - closed <= 16, `${loaded - closed} kept`);
      // A thread's extensions, and its client's, stay while they are used.
      assert.equal(host.manager.extensionsOf(opened.id), own);
      const commands = await client.call("commands.list", { threadId: opened.id });
      assert.ok(commands.length > 0);
      const loadedBefore = loaded;
      await client.call("commands.list", { threadId: null });
      assert.equal(loaded, loadedBefore);
    } finally {
      ExtensionHost.prototype.loadAll = loadAll;
      ExtensionHost.prototype.close = close;
    }
  });

  it("lets go of a closed thread once it is stored, reading and reopening it from the store", async () => {
    newHost(Store.memory());
    const client = await connect("tui");
    const removed: string[] = [];
    client.on((event) => {
      if (event.type === "removed") removed.push(event.threadId);
    });
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "remember this" });
    await idle(client, thread.id);
    const transcript = await client.call("thread.attach", { threadId: thread.id });
    await client.call("thread.close", { threadId: thread.id });
    await settle();
    assert.equal(host.manager.get(thread.id), undefined);
    // Clients showing it keep it: it went from memory, not from the store.
    assert.deepEqual(removed, []);
    const hello = await host.call("other", "client.hello", {
      clientId: "other",
      cwd: root,
      version: "test",
      extensions: [],
    });
    assert.equal(
      hello.threads.some((state) => state.id === thread.id),
      false,
    );
    const stored = await client.call("thread.attach", { threadId: thread.id });
    assert.equal(stored.thread.status, "closed");
    assert.deepEqual(stored.entries.slice(0, transcript.entries.length), transcript.entries);
    const listed = await client.call("threads.list", { scope: "recent" });
    assert.equal(listed.find((entry) => entry.id === thread.id)?.status, "closed");
    const back = await client.call("thread.resume", {
      id: thread.id,
      harness: "scripted",
      settings,
    });
    assert.equal(back.status, "parked");
  });

  it("lets go of agents and their tasks with the thread that started them, not before", async () => {
    newHost(Store.memory());
    const client = await connect("tui");
    const parent = await client.call("thread.open", { harness: "scripted", settings });
    const tool = (name: string) => host.orchestrator.tools.find((found) => found.name === name)!;
    const caller = { thread: host.manager.get(parent.id)!.thread };
    const task = async () =>
      JSON.parse(
        String(await tool("delegate_task").execute({ task: "help", wait: true }, caller)),
      ) as {
        taskId: string;
      };
    const cancelled = await task();
    const finished = await task();
    await tool("task_cancel").execute({ taskId: cancelled.taskId }, caller);
    await settle();
    // Its parent may still ask how it went.
    assert.equal(host.manager.get(cancelled.taskId)?.status, "closed");
    const status = JSON.parse(
      String(await tool("task_status").execute({ taskId: cancelled.taskId }, caller)),
    ) as { status: string };
    assert.equal(status.status, "completed");
    assert.equal(host.orchestrator.taskRows().length, 2);

    await client.call("thread.close", { threadId: parent.id });
    await settle();
    for (const id of [parent.id, cancelled.taskId, finished.taskId])
      assert.equal(host.manager.get(id), undefined);
    assert.deepEqual(host.orchestrator.taskRows(), []);
    const page = await client.call("thread.attach", { threadId: parent.id });
    assert.deepEqual(
      page.children.map((child) => child.id).toSorted(),
      [cancelled.taskId, finished.taskId].toSorted(),
    );
  });

  it("brings a reopened thread's tasks back with it, to report how they went", async () => {
    newHost(Store.memory());
    const client = await connect("tui");
    const parent = await client.call("thread.open", { harness: "scripted", settings });
    const tool = (name: string) => host.orchestrator.tools.find((found) => found.name === name)!;
    const call = async (name: string, input: Record<string, unknown>) =>
      JSON.parse(
        String(await tool(name).execute(input, { thread: host.manager.get(parent.id)!.thread })),
      ) as { taskId: string; status: string; result: string | null };
    const { taskId } = await call("delegate_task", { task: "help", wait: true });
    const finished = await call("task_status", { taskId });
    await client.call("thread.close", { threadId: parent.id });
    await settle();
    assert.equal(host.manager.get(parent.id), undefined);
    await client.call("thread.resume", { id: parent.id, harness: "scripted", settings });
    const reopened = await call("task_status", { taskId });
    assert.equal(reopened.status, finished.status);
    assert.equal(reopened.result, finished.result);
  });
});

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

/** Waits until a thread has nothing to do, as its state says. */
async function idle(client: HostClient, id: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const state = client.threads.get(id);
    if (state && state.status === "idle" && state.queue.length === 0 && state.runCount > 0) return;
    await settle(5);
  }
  throw new Error(`${id} did not settle`);
}
