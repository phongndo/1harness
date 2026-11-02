import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { registerDriver } from "../drivers/index.ts";
import { JsonRpcPeer } from "../drivers/jsonrpc.ts";
import { Host } from "../host/host.ts";
import { ScriptedSession, registerScripted } from "../testing/scripted.ts";
import { serveAcp } from "./acp-agent.ts";
import { HostClient } from "./client.ts";
import { LocalConnection } from "./connection.ts";

let root: string;
let host: Host;
let unregister: () => void;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-acp-"));
  unregister = registerScripted();
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

interface Update {
  sessionUpdate: string;
  content?: { text: string };
  toolCallId?: string;
  status?: string;
  title?: string;
  entries?: unknown[];
}

/** An editor on the other end of `1harness acp`, which allows whatever it is asked. */
async function editor(id: string, harness = "scripted") {
  const client = new HostClient(
    new LocalConnection(host, id, { owns: false }),
    { cwd: root, version: "test", extensions: [] },
    id,
  );
  await client.connect();
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const served = serveAcp({
    input: toAgent,
    output: fromAgent,
    client,
    defaults: { harness, mode: "supervised" },
    version: "test",
  });
  const peer = new JsonRpcPeer(fromAgent, (line) => toAgent.write(line), {
    name: "1harness acp",
    jsonrpc: true,
  });
  const updates: Update[] = [];
  const asked: unknown[] = [];
  peer.onNotification((method, params) => {
    if (method === "session/update") updates.push((params as { update: Update }).update);
  });
  peer.onRequest(async (method, params) => {
    assert.equal(method, "session/request_permission");
    asked.push(params);
    return { outcome: { outcome: "selected", optionId: "yes" } };
  });
  return {
    peer,
    updates,
    asked,
    close: async () => {
      toAgent.end();
      await served;
    },
  };
}

const said = (updates: Update[], kind: string) =>
  updates
    .filter((update) => update.sessionUpdate === kind)
    .map((update) => update.content?.text ?? "")
    .join("");

describe("1harness acp", () => {
  it("runs editor sessions as 1harness threads, streaming each turn back", async () => {
    host = new Host({
      version: "test",
      cwd: root,
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      idleCloseMs: 0,
    });
    const zed = await editor("zed");
    const init = await zed.peer.request<{ protocolVersion: number }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.equal(init.protocolVersion, 1);
    const session = await zed.peer.request<{
      sessionId: string;
      modes: { currentModeId: string };
      configOptions: { id: string; currentValue: string }[];
    }>("session/new", { cwd: root, mcpServers: [] });
    assert.equal(session.modes.currentModeId, "supervised");
    assert.equal(
      session.configOptions.find((option) => option.id === "harness")?.currentValue,
      "scripted",
    );
    assert.equal(
      session.configOptions.find((option) => option.id === "model")?.currentValue,
      "default",
    );
    assert.ok(host.manager.get(session.sessionId), "the session is a thread");

    const reply = await zed.peer.request<{ stopReason: string }>("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    assert.equal(reply.stopReason, "end_turn");
    assert.equal(said(zed.updates, "agent_message_chunk"), "Done with hello");
    assert.equal(said(zed.updates, "agent_thought_chunk"), "**Reading the parser**");
    const command = zed.updates.filter((update) => update.toolCallId === "1-cmd");
    assert.deepEqual(
      command.map((update) => [update.sessionUpdate, update.status]),
      [
        ["tool_call", "in_progress"],
        ["tool_call_update", "completed"],
      ],
    );
    assert.ok(zed.updates.some((update) => update.sessionUpdate === "plan"));

    // An approval goes to the editor, and its answer back to the thread.
    const approved = await zed.peer.request<{ stopReason: string }>("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go ASK" }],
    });
    assert.equal(approved.stopReason, "end_turn");
    assert.equal(zed.asked.length, 1);

    await zed.peer.request("session/set_mode", {
      sessionId: session.sessionId,
      modeId: "full-access",
    });
    assert.equal(host.manager.get(session.sessionId)?.thread.info.runtimeMode, "full-access");
    await assert.rejects(
      zed.peer.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "model",
        value: "big",
      }),
      /Scripted cannot setModel/,
    );
    const listed = await zed.peer.request<{ sessions: { sessionId: string }[] }>(
      "session/list",
      {},
    );
    assert.ok(listed.sessions.some((entry) => entry.sessionId === session.sessionId));
    await zed.close();

    // Another editor picks the thread up where the first left it.
    const again = await editor("zed-2");
    await again.peer.request("session/load", {
      sessionId: session.sessionId,
      cwd: root,
      mcpServers: [],
    });
    assert.equal(said(again.updates, "user_message_chunk"), "hellogo ASK");
    const more = await again.peer.request<{ stopReason: string }>("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "more" }],
    });
    assert.equal(more.stopReason, "end_turn");
    assert.match(said(again.updates, "agent_message_chunk"), /Done with more$/);
    await again.close();
  });

  it("fails a prompt whose message could not start a turn", async () => {
    const undo = registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) =>
        Object.assign(new ScriptedSession(options), {
          startTurn: async () => {
            throw new Error("not signed in");
          },
        }),
    });
    try {
      host = new Host({
        version: "test",
        cwd: root,
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        idleCloseMs: 0,
      });
      const zed = await editor("zed-broken", "broken");
      const { sessionId } = await zed.peer.request<{ sessionId: string }>("session/new", {
        cwd: root,
        mcpServers: [],
      });
      await assert.rejects(
        zed.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
        /not signed in/,
      );
      await zed.close();
    } finally {
      undo();
    }
  });

  it("does not take a failed turn queued ahead for the prompt's own", async () => {
    const undo = registerDriver({
      id: "flaky",
      label: "Flaky",
      unavailable: () => null,
      create: (options) => {
        const session = new ScriptedSession(options);
        const play = session.startTurn.bind(session);
        return Object.assign(session, {
          startTurn: async (input: { text: string; id?: string }) => {
            if (input.text !== "fail") return play(input);
            session.events.push({ type: "turn.started", turnId: "failing" });
            setTimeout(
              () =>
                session.events.push({
                  type: "turn.ended",
                  turnId: "failing",
                  status: "failed",
                  error: "boom",
                }),
              20,
            );
          },
        });
      },
    });
    try {
      host = new Host({
        version: "test",
        cwd: root,
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        idleCloseMs: 0,
      });
      const zed = await editor("zed-flaky", "flaky");
      const { sessionId } = await zed.peer.request<{ sessionId: string }>("session/new", {
        cwd: root,
        mcpServers: [],
      });
      // Someone else's message runs first, and its turn fails.
      host.manager.get(sessionId)!.thread.send({ text: "fail" });
      const reply = await zed.peer.request<{ stopReason: string }>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.equal(reply.stopReason, "end_turn");
      assert.equal(said(zed.updates, "agent_message_chunk"), "Done with hello");
      await zed.close();
    } finally {
      undo();
    }
  });
});
