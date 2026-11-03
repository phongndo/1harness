import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HarnessEvent, SessionOptions } from "../../core/events.ts";
import { collect, notices, until, within } from "../../testing/events.ts";
import { CodexSession, type CodexSessionConfig } from "./session.ts";

let root: string;
let codex: string;

/**
 * A stand-in for `codex app-server`. A turn's text says what it does: "plan"
 * proposes a plan, "hold" keeps running, "slow" is answered late and keeps
 * running, "die" starts a command and exits. A review, like "slow", is
 * answered late and keeps running.
 * Turn IDs name the thread they ran on. A second thread/start, the swap to a
 * thread that runs the tool hook, answers late. With FAKE_NO_HOOKS set,
 * listing hooks fails.
 */
const FAKE = `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let threads = 0;
let turns = 0;
let hook = "";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) continue;
  const params = message.params ?? {};
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({ userAgent: "codex_cli_rs/1.0.0" });
      break;
    case "thread/start": {
      hook ||= params.config?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
      const result = { thread: { id: "thread-" + ++threads, turns: [] }, model: "gpt", reasoningEffort: null, sandbox: null };
      setTimeout(() => reply(result), threads === 1 ? 0 : 300);
      break;
    }
    case "hooks/list":
      if (process.env.FAKE_NO_HOOKS) {
        send({ id: message.id, error: { code: -32603, message: "hooks are off" } });
        break;
      }
      reply({ data: [{ hooks: [{ key: "k", source: "sessionFlags", command: hook, trustStatus: "untrusted", currentHash: "h" }] }] });
      break;
    case "turn/start": {
      const text = params.input?.[0]?.text ?? "";
      const turn = { id: "turn-" + ++turns + "-on-" + params.threadId, items: [], status: "inProgress", error: null, startedAt: 1 };
      const note = (method, extra) => send({ method, params: { threadId: params.threadId, turnId: turn.id, ...extra } });
      if (text === "slow") {
        setTimeout(() => {
          reply({ turn });
          note("turn/started", { turn });
        }, 300);
        break;
      }
      reply({ turn });
      note("turn/started", { turn });
      if (text === "hold") break;
      if (text === "die") {
        note("item/started", { item: { type: "commandExecution", id: "cmd-1", command: "sleep 60", cwd: "/", status: "inProgress", processId: "p1", aggregatedOutput: null, exitCode: null, commandActions: [] } });
        setTimeout(() => process.exit(1), 50);
        break;
      }
      if (text === "plan") note("item/completed", { item: { type: "plan", id: "plan-1", text: "1. do it" } });
      note("turn/completed", { turn: { ...turn, status: "completed" } });
      break;
    }
    case "review/start": {
      const turn = { id: "turn-" + ++turns + "-on-" + params.threadId, items: [], status: "inProgress", error: null, startedAt: 1 };
      setTimeout(() => {
        reply({ turn });
        send({ method: "turn/started", params: { threadId: params.threadId, turnId: turn.id, turn } });
      }, 300);
      break;
    }
    default:
      reply({});
  }
}
`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-codex-"));
  const script = join(root, "codex.mjs");
  writeFileSync(script, FAKE);
  codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(codex, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

function config(overrides: Partial<CodexSessionConfig> = {}): CodexSessionConfig {
  const options: SessionOptions = {
    cwd: root,
    model: null,
    effort: null,
    runtimeMode: "supervised",
    interactionMode: "default",
    resume: null,
  };
  return { ...options, command: codex, version: "test", ...overrides };
}

function turnsStarted(events: readonly HarnessEvent[]): number {
  return events.filter((event) => event.type === "turn.started").length;
}

describe("CodexSession", () => {
  it("ends its events when closed before it started", async () => {
    const session = new CodexSession(config());
    const { events, ended } = collect(session);
    await session.close();
    assert.notEqual(await within(ended, 1_000), "timed out");
    assert.deepEqual(events, [{ type: "session.closed", error: null }]);
  });

  it("ends what was running when Codex dies", async () => {
    const session = new CodexSession(config());
    const { events, ended } = collect(session);
    await session.start();
    await session.startTurn({ text: "die" });
    assert.notEqual(await within(ended, 3_000), "timed out");
    const settled = events.find(
      (event) => event.type === "item.completed" && event.item.id === "cmd-1",
    );
    assert.equal(settled?.type === "item.completed" && "status" in settled.item, true);
    assert.equal(
      settled?.type === "item.completed" && "status" in settled.item && settled.item.status,
      "failed",
    );
    assert.ok(events.findIndex((event) => event === settled) < events.length - 1);
  });

  it("sends a message that comes during the swap to the hook's thread", async () => {
    const session = new CodexSession(config({ toolPolicy: async () => undefined }));
    const { events } = collect(session);
    try {
      await session.start();
      await until(
        () => events.some((event) => event.type === "request.opened"),
        "the hook trust request",
      );
      const request = events.find((event) => event.type === "request.opened");
      assert.ok(request?.type === "request.opened");
      await session.respond(request.request.id, { kind: "approval", optionId: "trust" });
      // The swap's thread/start is out; Codex answers it late.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.startTurn({ text: "hello" });
      await until(() => events.some((event) => event.type === "turn.ended"), "the turn to end");
      assert.equal(session.info.threadId, "thread-2");
      const started = events.find((event) => event.type === "turn.started");
      assert.equal(started?.type === "turn.started" && started.turnId, "turn-1-on-thread-2");
    } finally {
      await session.close();
    }
  });

  for (const { during, text, started } of [
    // Codex has not answered the turn or review yet when the plan is accepted.
    { during: "another turn is starting", text: "slow", started: false },
    { during: "a review is starting", text: "/review", started: false },
    // The thread sent the next message once the plan's turn ended.
    { during: "another turn runs", text: "hold", started: true },
  ]) {
    it(`does not start the plan's implementation while ${during}`, async () => {
      const session = new CodexSession(config({ model: "gpt", interactionMode: "plan" }));
      const { events } = collect(session);
      try {
        await session.start();
        await session.startTurn({ text: "plan" });
        await until(
          () =>
            events.some((event) => event.type === "request.opened") &&
            events.some((event) => event.type === "turn.ended"),
          "the offer to implement the plan",
        );
        const offer = events.find((event) => event.type === "request.opened");
        assert.ok(offer?.type === "request.opened");
        const busy = session.startTurn({ text });
        if (started) {
          await busy;
          await until(() => turnsStarted(events) === 2, "the second turn");
        }
        await session.respond(offer.request.id, { kind: "approval", optionId: "supervised" });
        await busy;
        // Refusing is all the offer does, so no third turn can follow.
        await until(
          () =>
            turnsStarted(events) === 2 &&
            notices(events, "error").some((notice) => /turn is running/.test(notice)),
          "the refusal",
        );
        assert.equal(turnsStarted(events), 2);
      } finally {
        await session.close();
      }
    });
  }

  it("warns that tool calls go unchecked when Codex does not list its hooks", async () => {
    process.env["FAKE_NO_HOOKS"] = "1";
    const session = new CodexSession(config({ toolPolicy: async () => undefined }));
    const { events } = collect(session);
    try {
      await session.start();
      await until(
        () =>
          notices(events, "warning").some((notice) =>
            /cannot check this thread's tool calls/.test(notice),
          ),
        "the warning",
      );
    } finally {
      delete process.env["FAKE_NO_HOOKS"];
      await session.close();
    }
  });
});
