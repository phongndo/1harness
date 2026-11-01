import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { SocketConnection, serverHello } from "../client/socket.ts";
import { Host } from "../host/host.ts";
import type { HostEvent } from "../protocol.ts";
import { Store } from "../store/store.ts";
import { registerScripted, scriptedSettings as settings } from "../testing/scripted.ts";
import { CLIENT_HEADER, HostServer, REQUEST_HEADER } from "./http.ts";

let root: string;
let unregister: () => void;
let host: Host;
let server: HostServer;
let socket: string;
let count = 0;
const clients: HostClient[] = [];

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-server-"));
  unregister = registerScripted();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<void> {
  socket = join(root, `s${++count}.sock`);
  host = new Host({
    version: "test",
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
    store: Store.memory(),
  });
  server = new HostServer(host, { version: "test", autostarted: false });
  await server.listen({ path: socket });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server.close();
  await host.shutdown();
});

async function connect(id: string, extensions: string[] = []): Promise<HostClient> {
  const client = new HostClient(
    new SocketConnection({ socket }, id),
    { cwd: root, version: "test", extensions },
    id,
  );
  clients.push(client);
  await client.connect();
  return client;
}

async function idle(client: HostClient, id: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const state = client.threads.get(id);
    if (state && state.status === "idle" && state.queue.length === 0 && state.runCount > 0) return;
    await settle(5);
  }
  throw new Error(`${id} did not settle`);
}

/** A raw request to the server, as a client that lost its answer retries it. */
function post(body: unknown, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const outgoing = request({
      socketPath: socket,
      path: "/v1/rpc",
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    });
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve(JSON.parse(data)));
    });
    outgoing.end(text);
  });
}

/** The lines of an event stream, until it ends or `ms` pass. */
function lines(path: string, ms: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const found: string[] = [];
    const outgoing = request({ socketPath: socket, path, headers: { [CLIENT_HEADER]: "raw" } });
    const timer = setTimeout(() => {
      outgoing.destroy();
      resolve(found);
    }, ms);
    outgoing.on("error", (error) => {
      if (found.length === 0) reject(error);
    });
    outgoing.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => found.push(...chunk.split("\n").filter(Boolean)));
      response.on("end", () => {
        clearTimeout(timer);
        resolve(found);
      });
    });
    outgoing.end();
  });
}

describe("HostServer", () => {
  it("serves the host over its socket: hello, requests, and the event feed", async () => {
    await start();
    const hello = await serverHello({ socket });
    assert.equal(hello.name, "1harness");
    assert.equal(hello.store, ":memory:");
    const client = await connect("a");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await client.call("thread.send", { threadId: thread.id, text: "over the socket" });
    await idle(client, thread.id);
    assert.equal(client.threads.get(thread.id)?.lastRun?.result, "Done with over the socket");
    const page = await client.call("thread.attach", { threadId: thread.id });
    assert.ok(page.entries.length > 0);
  });

  it("picks up after a dropped stream, from the last event it had", async () => {
    await start();
    const client = await connect("a");
    const seen: number[] = [];
    const states: string[] = [];
    client.on((event) => {
      if (event.type === "connection") states.push(event.state);
      else if ("seq" in event) seen.push(event.seq);
    });
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    await settle();
    // The server goes away and comes back on the same socket, as after a restart of its listener.
    await server.close();
    await host.call("other", "thread.send", { threadId: thread.id, text: "while away" });
    await settle(30);
    server = new HostServer(host, { version: "test", autostarted: false });
    await server.listen({ path: socket });
    await idle(client, thread.id);
    assert.deepEqual(states.slice(0, 2), ["reconnecting", "connected"]);
    // Every event once, in order, with nothing missed while it was away.
    assert.deepEqual(
      seen,
      seen.toSorted((a, b) => a - b),
    );
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(client.threads.get(thread.id)?.lastRun?.result, "Done with while away");
  });

  it("answers a retried request with its first answer", async () => {
    await start();
    const client = await connect("a");
    const thread = await client.call("thread.open", { harness: "scripted", settings });
    const body = { method: "thread.send", params: { threadId: thread.id, text: "once" } };
    const headers = { [CLIENT_HEADER]: "a", [REQUEST_HEADER]: "a:retry" };
    const first = (await post(body, headers)) as { result: { messageId: string } };
    const again = (await post(body, headers)) as { result: { messageId: string } };
    assert.equal(again.result.messageId, first.result.messageId);
    await idle(client, thread.id);
    assert.equal(client.threads.get(thread.id)?.runCount, 1);
    const refused = (await post({ method: "nope", params: {} }, { [CLIENT_HEADER]: "a" })) as {
      error: { code: string };
    };
    assert.equal(refused.error.code, "unknown_method");
  });

  it("tells a client too far behind to say hello again", async () => {
    await start();
    const client = await connect("a");
    await client.call("thread.open", { harness: "scripted", settings });
    assert.deepEqual(await lines("/v1/events?after=-100", 200), ['{"type":"resync"}']);
    const fromNow = await lines(`/v1/events?after=${host.seq}`, 100);
    assert.deepEqual(fromNow, []);
  });

  it("sends a command's UI to the client that ran it, and dismisses it when that client leaves", async () => {
    await start();
    const extension = join(root, "ask.mjs");
    writeFileSync(
      extension,
      `export default (api) => api.registerCommand({
        name: "ask",
        description: "",
        group: "Test",
        async run(context) {
          globalThis.asked = await context.ui.pick("Which?", [{ label: "a" }]);
        },
      });\n`,
    );
    const asking = await connect("asking", [extension]);
    const other = await connect("other");
    const ui: string[] = [];
    asking.on((event: HostEvent | { type: string }) => {
      if (event.type === "ui") ui.push("asking");
    });
    other.on((event: HostEvent | { type: string }) => {
      if (event.type === "ui") ui.push("other");
    });
    const running = asking.call("commands.run", { threadId: null, name: "ask", args: "" });
    await settle(30);
    assert.deepEqual(ui, ["asking"]);
    // Leaving answers it as dismissed, so the command is not left waiting.
    await asking.close();
    clients.splice(clients.indexOf(asking), 1);
    await running.catch(() => {});
    await settle(10);
    assert.equal((globalThis as { asked?: unknown }).asked, null);
  });

  it("shows each client only the threads it opens, though all see every thread", async () => {
    await start();
    const first = await connect("first");
    const second = await connect("second");
    const thread = await first.call("thread.open", { harness: "scripted", settings });
    await settle();
    assert.equal(second.threads.get(thread.id)?.openedBy, "first");
    assert.equal(first.threads.get(thread.id)?.openedBy, "first");
  });

  it("tells a client of the host before a restart to start over, though its count went on", async () => {
    await start();
    const client = await connect("a");
    const resyncs: string[] = [];
    client.on((event) => {
      if (event.type === "resync") resyncs.push(event.hello.instance);
    });
    const first = host.instance;
    // A new host on the same socket, which numbers its events past where the client got.
    await server.close();
    await host.shutdown();
    host = new Host({
      version: "test",
      cwd: root,
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      idleCloseMs: 0,
    });
    for (let index = 0; index < 50; index++)
      await host.call("other", "client.show", { threadId: null });
    await host.call("other", "thread.open", { harness: "scripted", settings });
    server = new HostServer(host, { version: "test", autostarted: false });
    await server.listen({ path: socket });
    for (let tries = 0; tries < 100 && resyncs.length === 0; tries++) await settle(20);
    assert.equal(resyncs.length, 1);
    assert.notEqual(resyncs[0], first);
    assert.equal(resyncs[0], host.instance);
  });

  it("tells a client it counted as gone to say hello again", async () => {
    socket = join(root, `s${++count}.sock`);
    host = new Host({
      version: "test",
      cwd: root,
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      idleCloseMs: 0,
    });
    server = new HostServer(host, { version: "test", autostarted: false, leaveGraceMs: 20 });
    await server.listen({ path: socket });
    await host.call("raw", "client.hello", {
      clientId: "raw",
      cwd: root,
      version: "test",
      extensions: [],
    });
    await lines(`/v1/events?after=${host.seq}`, 30);
    await settle(60);
    assert.equal(host.clients, 0);
    assert.deepEqual(await lines(`/v1/events?after=${host.seq}`, 100), ['{"type":"resync"}']);
  });
});
