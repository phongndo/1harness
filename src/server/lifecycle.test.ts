import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { storeFile } from "../core/paths.ts";
import { JsonStorage } from "../extensions/host.ts";
import { Store } from "../store/store.ts";
import { ensureServer, markStopped, runServer } from "./lifecycle.ts";

// Short, since a socket path is at most about a hundred bytes.
const root = mkdtempSync(join(tmpdir(), "1h-"));
after(() => rmSync(root, { recursive: true, force: true }));

const env = (name: string): NodeJS.ProcessEnv => ({
  XDG_STATE_HOME: join(root, name, "state"),
  XDG_CONFIG_HOME: join(root, name, "config"),
  PATH: process.env["PATH"] ?? "",
});

describe("runServer", () => {
  it("stops cleanly when a listener it was asked for cannot start", async () => {
    const socket = join(root, "a.sock");
    await assert.rejects(
      runServer({
        version: "test",
        socket,
        autostarted: false,
        env: env("a"),
        extraListen: ["ftp://nowhere:1"],
        log: () => {},
      }),
      /Cannot listen on ftp/,
    );
    // Nothing is left listening, and the store is free for the next server.
    assert.equal(existsSync(socket), false);
    Store.open(storeFile(env("a"))).close();
  });

  it("starts and stops, and a client that lost a server stopped on purpose leaves it stopped", async () => {
    const socket = join(root, "b.sock");
    const running = await runServer({
      version: "test",
      socket,
      autostarted: false,
      env: env("b"),
      log: () => {},
    });
    assert.ok(running);
    await running.stop();
    markStopped(socket);
    await assert.rejects(
      ensureServer({ target: { socket }, autostart: true, revive: true, env: env("b") }),
      /was stopped/,
    );
  });
});

describe("JsonStorage", () => {
  it("reads values kept where they were before, until it writes its own", () => {
    const legacy = join(root, "old.json");
    writeFileSync(legacy, JSON.stringify({ rule: "ls" }));
    const storage = new JsonStorage(join(root, "new", "values.json"), legacy);
    assert.equal(storage.get("rule"), "ls");
    storage.set("more", 1);
    assert.equal(new JsonStorage(join(root, "new", "values.json")).get("rule"), "ls");
  });
});
