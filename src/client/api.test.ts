import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runServer, type RunningServer } from "../server/lifecycle.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { connect, RpcError, type ClientEvent } from "./api.ts";

let root: string;
let server: RunningServer;
let socket: string;
let unregister: () => void;
const env = { ...process.env };

before(async () => {
  root = mkdtempSync(join(tmpdir(), "1h-api-"));
  socket = join(root, "s.sock");
  unregister = registerScripted();
  process.env["XDG_STATE_HOME"] = join(root, "state");
  process.env["XDG_CONFIG_HOME"] = join(root, "config");
  const running = await runServer({ version: "test", socket, autostarted: false, log: () => {} });
  assert.ok(running);
  server = running;
});

after(async () => {
  await server.stop();
  unregister();
  process.env = env;
  rmSync(root, { recursive: true, force: true });
});

describe("the client API", () => {
  it("runs a thread on a server, following its events", async () => {
    const client = await connect({ server: socket, cwd: root });
    try {
      const events: ClientEvent[] = [];
      const ended = new Promise<void>((done) => {
        client.on((event) => {
          events.push(event);
          if (event.type === "entry" && event.entry.type === "turn.ended") done();
        });
      });
      const thread = await client.call("thread.open", {
        harness: "scripted",
        settings: { ...scriptedSettings, cwd: root },
      });
      await client.call("thread.send", { threadId: thread.id, text: "hello" });
      await ended;
      const replies = events.flatMap((event) =>
        event.type === "entry" &&
        event.entry.type === "item" &&
        event.entry.done &&
        event.entry.item.kind === "assistant_message"
          ? [event.entry.item.text]
          : [],
      );
      assert.deepEqual(replies, ["Done with hello"]);
      assert.equal(client.threads.get(thread.id)?.harness, "scripted");
    } finally {
      await client.close();
    }
  });

  it("reaches what agents reach, through operations", async () => {
    const client = await connect({ server: socket, cwd: root });
    try {
      const names = (await client.call("operations.list", {})).map((operation) => operation.name);
      assert.ok(names.includes("thread_open"));
      const { result } = await client.call("operations.call", { name: "thread_list", input: {} });
      assert.ok(result !== undefined);
    } finally {
      await client.close();
    }
  });

  it("says why a request fails, with a code a program can act on", async () => {
    const client = await connect({ server: socket, cwd: root });
    try {
      await assert.rejects(
        client.call("thread.send", { threadId: "nope", text: "hi" }),
        (error: Error) => error instanceof RpcError && error.code === "thread_not_found",
      );
    } finally {
      await client.close();
    }
  });

  it("is what the package exports as 1harness/client", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, { types: string; default: string }> };
    assert.deepEqual(manifest.exports["./client"], {
      types: "./src/client/api.ts",
      default: "./dist/client/api.js",
    });
  });
});
