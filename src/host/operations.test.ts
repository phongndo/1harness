import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { mcpBridge } from "../client/mcp-bridge.ts";
import { opCommand } from "../client/ops-cli.ts";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import type { CommandContext } from "../commands/registry.ts";
import { runOperation, type OperationInfo } from "../operations/operation.ts";
import { HostServer } from "../server/http.ts";
import type { HostEvent } from "../protocol.ts";
import { Store } from "../store/store.ts";
import { registerScripted } from "../testing/scripted.ts";
import { Host } from "./host.ts";
import type { ThreadManager } from "./manager.ts";
import { hostOperations } from "./operations.ts";
import { Scope, type ThreadSnapshot } from "./scope.ts";

let root: string;
let host: Host;
let unregister: () => void;
let count = 0;

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms));

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-operations-"));
  unregister = registerScripted();
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

function newHost(settings: Record<string, unknown> = {}, store: Store | null = null): Host {
  const config = join(root, `config-${++count}`);
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ harness: "scripted", ...settings }),
  );
  host = new Host({
    version: "test",
    cwd: root,
    configDir: config,
    stateDir: join(root, `state-${count}`),
    idleCloseMs: 0,
    store,
  });
  return host;
}

function client(id: string, agent = false): HostClient {
  return new HostClient(
    new LocalConnection(host, id, { owns: false }),
    { cwd: root, version: "test", extensions: [], ...(agent ? { agent } : {}) },
    id,
  );
}

async function connect(id: string, agent = false): Promise<HostClient> {
  const connected = client(id, agent);
  await connected.connect();
  return connected;
}

async function call(caller: HostClient, name: string, input: Record<string, unknown> = {}) {
  return (await caller.call("operations.call", { name, input })).result as Record<string, unknown>;
}

/** Sends JSON-RPC lines into `input` and reads the replies `output` gives back, by ID. */
function rpcLines(input: PassThrough, output: PassThrough) {
  const replies = new Map<number, (message: unknown) => void>();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id: number };
      buffer = buffer.slice(newline + 1);
      replies.get(message.id)?.(message);
      newline = buffer.indexOf("\n");
    }
  });
  let next = 0;
  return (method: string, params: unknown = {}) =>
    new Promise<{ result: Record<string, unknown> }>((resolve) => {
      const id = ++next;
      replies.set(id, resolve as (message: unknown) => void);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
}

async function toolNames(url: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

const listed = (operations: OperationInfo[]) => operations.map((operation) => operation.name);

describe("operations", () => {
  it("are offered on every surface their callers use, and only there", async () => {
    newHost();
    const person = await connect("tui");
    const outsider = await connect("outside", true);

    // People: the server's API, the CLI, and /op.
    const forPeople = listed(await person.call("operations.list", {}));
    const out = new PassThrough();
    let cli = "";
    out.on("data", (chunk: Buffer) => (cli += chunk.toString("utf8")));
    assert.equal(await opCommand([], async () => client("cli"), out), 0);
    const op = BUILTIN_COMMANDS.find((command) => command.name === "op")!;
    const userOperations = await person.call("operations.list", {});
    const completed =
      op
        .complete?.({ lookup: () => userOperations } as unknown as CommandContext, "")
        ?.items.map((item) => item.value) ?? [];

    // Agents in 1harness threads: the MCP server each session gets.
    const grant = await host.tools.grant();
    assert.ok(grant && grant.config.type === "http");
    const forThreads = await toolNames(grant.config.url, grant.config.headers);
    grant.revoke();

    // Agents outside: `1harness mcp`, and the server's /mcp.
    const input = new PassThrough();
    const output = new PassThrough();
    const bridged = mcpBridge({
      input,
      output,
      version: "test",
      env: {},
      connect: async () => outsider,
    });
    const send = rpcLines(input, output);
    const bridgeList = await send("tools/list");
    const forBridge = (bridgeList.result["tools"] as { name: string }[]).map((tool) => tool.name);
    input.end();
    await bridged;
    const server = new HostServer(host, { version: "test", autostarted: false });
    const address = (await server.listen({ port: 0, host: "127.0.0.1" })) as AddressInfo;
    const forServer = await toolNames(`http://127.0.0.1:${address.port}/mcp`);
    await server.close();

    assert.ok(host.operations.length > 20);
    for (const operation of host.operations) {
      const { name, callers } = operation;
      const user = callers.includes("user");
      const agent = callers.includes("agent");
      const outside = callers.includes("external");
      assert.equal(forPeople.includes(name), user, `${name} through the server's API`);
      assert.equal(
        cli.split("\n").some((line) => line.startsWith(`${name} `)),
        user,
        `${name} in 1harness op`,
      );
      assert.equal(completed.includes(name), user, `${name} in /op`);
      assert.equal(forThreads.includes(name), agent, `${name} for agents in threads`);
      assert.equal(forBridge.includes(name), outside, `${name} through 1harness mcp`);
      assert.equal(forServer.includes(name), outside, `${name} through /mcp`);
    }
  });

  it("serves nothing through 1harness mcp inside a session 1harness runs", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let connected = false;
    const bridged = mcpBridge({
      input,
      output,
      version: "test",
      env: { ONEHARNESS_HOSTED: "1" },
      connect: async () => {
        connected = true;
        throw new Error("no server");
      },
    });
    const send = rpcLines(input, output);
    const init = await send("initialize", { protocolVersion: "2025-06-18" });
    assert.match(String(init.result["instructions"]), /already/);
    assert.deepEqual((await send("tools/list")).result["tools"], []);
    input.end();
    await bridged;
    assert.equal(connected, false, "it never reaches for a server");
  });

  it("holds agents outside 1harness to agentMode, and leaves approvals to people", async () => {
    newHost({ agentMode: "supervised" });
    const person = await connect("tui");
    const outsider = await connect("outside", true);
    await assert.rejects(
      call(outsider, "thread_open", { runtimeMode: "full-access" }),
      /runtime_mode_escalation_denied.*agentMode/,
    );
    // Without a mode, it gets the user's default narrowed to what it may have.
    const theirs = await call(outsider, "thread_open", { message: "hi" });
    assert.equal(theirs["runtimeMode"], "supervised");
    const mine = await call(person, "thread_open", { runtimeMode: "full-access" });
    await assert.rejects(
      call(outsider, "thread_send", { threadId: mine["threadId"], message: "go" }),
      /runtime_mode_escalation_denied/,
    );
    await assert.rejects(
      call(outsider, "thread_close", { threadId: mine["threadId"] }),
      /runtime_mode_escalation_denied/,
    );
    // It can still read it.
    assert.equal(
      (await call(outsider, "thread_read", { threadId: mine["threadId"] }))["threadId"],
      mine["threadId"],
    );

    // It may not answer approvals; a person may.
    await call(outsider, "thread_send", { threadId: theirs["threadId"], message: "go ASK" });
    let waiting: Record<string, unknown> = {};
    for (let tries = 0; tries < 100 && !waiting["waitingOn"]; tries++) {
      await settle(5);
      waiting = await call(person, "thread_read", { threadId: theirs["threadId"] });
    }
    const [request] = waiting["waitingOn"] as {
      requestId: string;
      options: { optionId: string }[];
    }[];
    assert.ok(request);
    const answer = { threadId: theirs["threadId"], requestId: request.requestId, optionId: "yes" };
    await assert.rejects(call(outsider, "thread_respond", answer), /not_allowed.*people only/);
    await call(person, "thread_respond", answer);
    await call(person, "thread_wait", { threadId: theirs["threadId"], timeoutSeconds: 5 });
    const read = await call(person, "thread_read", { threadId: theirs["threadId"] });
    assert.equal((read["runs"] as { status: string }[]).at(-1)?.status, "completed");
    assert.equal(read["waitingOn"], undefined);
  });

  it("keeps agents in 1harness threads to their tree, and to themselves", async () => {
    newHost();
    const person = await connect("tui");
    const own = await call(person, "thread_open", { runtimeMode: "supervised" });
    const other = await call(person, "thread_open", { runtimeMode: "supervised" });
    const thread = host.manager.get(String(own["threadId"]))!.thread;
    const agent = { kind: "agent" as const, thread, callId: null };
    const run = (name: string, input: Record<string, unknown> = {}) =>
      runOperation(
        host.operations.find((operation) => operation.name === name),
        name,
        input,
        agent,
      ) as Promise<Record<string, unknown>>;
    const listing = await run("thread_list");
    assert.deepEqual(
      (listing["threads"] as { threadId: string }[]).map((entry) => entry.threadId),
      [own["threadId"]],
    );
    await assert.rejects(run("thread_open", {}), /not_allowed/);
    await assert.rejects(
      run("thread_switch_harness", { threadId: own["threadId"], harness: "scripted" }),
      /your own turn/,
    );
    await assert.rejects(run("thread_read", { threadId: other["threadId"] }), /thread_not_found/);
    await assert.rejects(
      run("thread_respond", { threadId: own["threadId"], requestId: "x" }),
      /not_allowed/,
    );
  });

  it("follows a thread by cursor, waiting for news, and says when events were missed", async () => {
    newHost();
    const person = await connect("tui");
    const opened = await call(person, "thread_open", { runtimeMode: "supervised" });
    const threadId = opened["threadId"];
    const start = await call(person, "thread_events", { threadId });
    assert.deepEqual(start["events"], []);
    await call(person, "thread_send", { threadId, message: "hello" });
    const seen: { type: string; text?: string }[] = [];
    let cursor = start["cursor"] as number;
    for (let tries = 0; tries < 20 && !seen.some((event) => event.type === "turn.ended"); tries++) {
      const page = await call(person, "thread_events", {
        threadId,
        after: cursor,
        timeoutSeconds: 5,
      });
      assert.equal(page["gap"], false);
      seen.push(...(page["events"] as typeof seen));
      assert.ok((page["cursor"] as number) > cursor, "the cursor moves on");
      cursor = page["cursor"] as number;
    }
    const types = seen.map((event) => event.type);
    for (const type of ["turn.started", "message", "command", "reply", "turn.ended"])
      assert.ok(types.includes(type), `${type} in ${types.join(", ")}`);
    assert.equal(seen.find((event) => event.type === "reply")?.text, "Done with hello");
    // Nothing new: a short wait comes back empty, with the same cursor.
    const quiet = await call(person, "thread_events", {
      threadId,
      after: cursor,
      timeoutSeconds: 0.05,
    });
    assert.deepEqual(quiet["events"], []);
    assert.equal(quiet["cursor"], cursor);
    // A cursor this run of the server never gave is a gap.
    const missed = await call(person, "thread_events", { threadId, after: cursor + 1000 });
    assert.equal(missed["gap"], true);
  });

  it("moves, tunes, and forks threads for people", async () => {
    newHost();
    const person = await connect("tui");
    const opened = await call(person, "thread_open", { runtimeMode: "supervised", message: "one" });
    const threadId = opened["threadId"];
    await call(person, "thread_wait", { threadId, timeoutSeconds: 5 });
    const models = (
      await person.call("operations.call", { name: "thread_models", input: { threadId } })
    ).result as { id: string }[];
    assert.deepEqual(
      models.map((model) => model.id),
      ["big"],
    );
    const fork = await call(person, "thread_fork", { threadId });
    assert.notEqual(fork["threadId"], threadId);
    await call(person, "thread_set_mode", { threadId, runtimeMode: "full-access" });
    assert.equal(host.manager.get(String(threadId))?.thread.info.runtimeMode, "full-access");
    const harnesses = (await person.call("operations.call", { name: "harness_list" })).result as {
      id: string;
    }[];
    assert.ok(harnesses.some((harness) => harness.id === "scripted"));
    const forgotten = await call(person, "thread_forget", { threadId: fork["threadId"] });
    assert.deepEqual(forgotten["forgotten"], [fork["threadId"]]);
  });

  it("adds extensions' operations for people and outside agents, never over 1harness's own", async () => {
    newHost();
    const folder = join(root, `config-${count}`, "extensions");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "greet.ts"),
      `export default function (api) {
        const inputSchema = { type: "object", properties: { name: { type: "string" } } };
        api.registerOperation({ name: "greet", description: "Says hello", inputSchema,
          callers: ["user", "external"], run: (input, { caller }) => \`hello \${input.name}, \${caller.kind}\` });
        api.registerOperation({ name: "thread_list", description: "an impostor", inputSchema,
          run: () => "impostor" });
      }`,
    );
    const person = await connect("tui");
    const outsider = await connect("outside", true);
    const named = (await person.call("operations.list", {})).filter(
      (operation) => operation.name === "greet",
    );
    assert.equal(named.length, 1);
    assert.equal(
      (await person.call("operations.call", { name: "greet", input: { name: "ana" } })).result,
      "hello ana, user",
    );
    assert.equal(
      (await outsider.call("operations.call", { name: "greet", input: { name: "bo" } })).result,
      "hello bo, external",
    );
    const listing = await call(person, "thread_list");
    assert.ok(Array.isArray(listing["threads"]), "1harness's own thread_list still answers");
  });

  it("hands back the cursor of the last event it looked at, so a burst is not skipped", async () => {
    const thread = {
      id: "t1",
      title: "",
      harness: "scripted",
      status: "working",
      parentId: null,
      runs: [],
      thread: { info: {}, requests: [] },
    } as unknown as ThreadSnapshot;
    const feed: HostEvent[] = [];
    const listeners = new Set<(event: HostEvent) => void>();
    const emit = (text: string) => {
      const event = {
        seq: feed.length + 1,
        type: "entry",
        threadId: "t1",
        entry: { type: "item", done: true, item: { kind: "assistant_message", id: text, text } },
      } as HostEvent;
      feed.push(event);
      for (const listener of listeners) listener(event);
    };
    const manager = { get: (id: string) => (id === "t1" ? thread : undefined) };
    const events = hostOperations({
      manager: manager as unknown as ThreadManager,
      scope: new Scope(manager as unknown as ThreadManager),
      request: async () => {
        throw new Error("unused");
      },
      cwd: () => root,
      defaultHarness: () => null,
      defaultMode: () => "supervised",
      seq: () => feed.length,
      since: (cursor) => feed.filter((event) => event.seq > cursor),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }).find((operation) => operation.name === "thread_events")!;
    const caller = { kind: "user" as const, clientId: "c" };
    const waiting = events.run(
      { threadId: "t1", after: 0, timeoutSeconds: 5 },
      { caller },
    ) as Promise<{
      cursor: number;
      events: { text: string }[];
    }>;
    // Three in one go: the wait ends at the first, before its answer is built.
    emit("one");
    emit("two");
    emit("three");
    const first = await waiting;
    assert.deepEqual(
      first.events.map((event) => event.text),
      ["one"],
    );
    assert.equal(first.cursor, 1);
    const rest = (await events.run({ threadId: "t1", after: first.cursor }, { caller })) as {
      events: { text: string }[];
    };
    assert.deepEqual(
      rest.events.map((event) => event.text),
      ["two", "three"],
    );
  });

  it("reads and forks a closed thread that only the store keeps", async () => {
    newHost({}, Store.memory());
    const person = await connect("tui");
    const opened = await call(person, "thread_open", { runtimeMode: "supervised", message: "one" });
    const threadId = String(opened["threadId"]);
    await call(person, "thread_wait", { threadId, timeoutSeconds: 5 });
    await call(person, "thread_close", { threadId });
    for (let tries = 0; tries < 100 && host.manager.get(threadId); tries++) await settle(5);
    assert.equal(host.manager.get(threadId), undefined, "it left memory");
    const read = await call(person, "thread_read", { threadId });
    assert.equal((read["runs"] as { result: string }[])[0]?.result, "Done with one");
    assert.equal((await call(person, "thread_wait", { threadId }))["status"], "closed");
    const fork = await call(person, "thread_fork", { threadId });
    assert.notEqual(fork["threadId"], threadId);
    await assert.rejects(call(person, "thread_send", { threadId, message: "x" }), /thread_closed/);
  });
});
