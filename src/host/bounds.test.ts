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
});
