import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
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
});
