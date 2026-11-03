import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SessionOptions } from "../../core/events.ts";
import { collect, notices, until, within } from "../../testing/events.ts";
import { AcpSession, type AcpAgentSpec } from "./session.ts";

let root: string;
let spec: AcpAgentSpec;

/**
 * A stand-in for an ACP agent. A prompt's text says what it does: "die" starts
 * a tool call and a reply, then exits; anything else ends the turn. With
 * FAKE_MODELS set, it offers models, and refuses the one named "missing".
 * With FAKE_MODES set, it offers modes and refuses to switch them.
 */
const FAKE = `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (update) => send({ method: "session/update", params: { sessionId: "s1", update } });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) continue;
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({ agentCapabilities: { promptCapabilities: { image: true } } });
      break;
    case "session/new":
      reply({
        sessionId: "s1",
        ...(process.env.FAKE_MODELS
          ? { configOptions: [{ id: "model", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "big", name: "Big" }] }] }
          : {}),
        ...(process.env.FAKE_MODES
          ? { modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "yolo", name: "Yolo" }, { id: "plan", name: "Plan" }] } }
          : {}),
      });
      break;
    case "session/set_mode":
      send({ id: message.id, error: { code: -32603, message: "modes are locked" } });
      break;
    case "session/set_config_option":
      if (message.params.value === "missing")
        send({ id: message.id, error: { code: -32602, message: "no such model" } });
      else reply({});
      break;
    case "session/prompt":
      if (message.params.prompt[0].text === "die") {
        update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } });
        setTimeout(() => process.exit(1), 50);
      } else reply({ stopReason: "end_turn" });
      break;
    default:
      reply({});
  }
}
`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-acp-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, FAKE);
  spec = { id: "fake", label: "Fake", command: process.execPath, args: [script] };
});

after(() => rmSync(root, { recursive: true, force: true }));

const options: SessionOptions = {
  cwd: "",
  model: null,
  effort: null,
  runtimeMode: "supervised",
  interactionMode: "default",
  resume: null,
};

describe("AcpSession", () => {
  it("ends the tool calls and reply it was in when the agent dies", async () => {
    const session = new AcpSession(spec, { ...options, cwd: root }, "test");
    const { events, ended } = collect(session);
    await session.start();
    await session.startTurn({ text: "die" });
    assert.notEqual(await within(ended, 3_000), "timed out");
    const completed = new Map(
      events.flatMap((event) =>
        event.type === "item.completed" ? [[event.item.id, event.item] as const] : [],
      ),
    );
    const tool = completed.get("tool-1");
    assert.equal(tool && "status" in tool && tool.status, "failed");
    const reply = [...completed.values()].find((item) => item.kind === "assistant_message");
    assert.equal(reply?.kind === "assistant_message" && reply.text, "Looking");
  });

  it("reports only a model the agent took", async () => {
    // An agent with no model option runs its own, which it does not name.
    const plain = new AcpSession(spec, { ...options, cwd: root, model: "big" }, "test");
    const plainEvents = collect(plain).events;
    try {
      await plain.start();
      assert.equal(plain.info.model, null);
      assert.match(notices(plainEvents, "warning").join("\n"), /Could not use big/);
      await assert.rejects(plain.setModel("big"), /does not let 1harness choose its model/);
    } finally {
      await plain.close();
    }

    process.env["FAKE_MODELS"] = "1";
    try {
      const chosen = new AcpSession(spec, { ...options, cwd: root, model: "big" }, "test");
      await chosen.start();
      assert.equal(chosen.info.model, "big");
      await chosen.close();

      const refused = new AcpSession(spec, { ...options, cwd: root, model: "missing" }, "test");
      const refusedEvents = collect(refused).events;
      await refused.start();
      assert.equal(refused.info.model, "small");
      assert.match(
        notices(refusedEvents, "warning").join("\n"),
        /Could not use missing: no such model/,
      );
      await refused.close();
    } finally {
      delete process.env["FAKE_MODELS"];
    }
  });

  it("warns when the agent will not switch to the modes asked", async () => {
    process.env["FAKE_MODES"] = "1";
    const session = new AcpSession(
      spec,
      { ...options, cwd: root, runtimeMode: "full-access", interactionMode: "plan" },
      "test",
    );
    const { events } = collect(session);
    try {
      await session.start();
      assert.equal(session.info.runtimeMode, "supervised");
      assert.equal(session.info.interactionMode, "default");
      const warned = notices(events, "warning").join("\n");
      assert.match(warned, /Could not use full-access: modes are locked/);
      assert.match(warned, /Could not start in plan mode: modes are locked/);
    } finally {
      delete process.env["FAKE_MODES"];
      await session.close();
    }
  });

  it("ends no turn it never started when an attached image is missing", async () => {
    const session = new AcpSession(spec, { ...options, cwd: root }, "test");
    const { events } = collect(session);
    try {
      await session.start();
      await assert.rejects(
        session.startTurn({ text: "look", images: [join(root, "missing.png")] }),
        /ENOENT/,
      );
      const started = events.filter((event) => event.type === "turn.started").length;
      const ended = events.filter((event) => event.type === "turn.ended").length;
      assert.equal(started, ended);
      // The session takes the next message.
      await session.startTurn({ text: "again" });
      await until(() => events.some((event) => event.type === "turn.ended"), "the turn to end");
      assert.ok(
        events.some((event) => event.type === "turn.ended" && event.status === "completed"),
      );
    } finally {
      await session.close();
    }
  });
});
