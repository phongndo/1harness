import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HarnessEvent, SessionOptions } from "../../core/events.ts";
import { CodexSession, type CodexSessionConfig } from "./session.ts";

let root: string;
let codex: string;

/**
 * A stand-in for `codex app-server`. A turn's text says what it does: "plan"
 * proposes a plan, "hold" keeps running, "die" starts a command and exits.
 * Turn IDs name the thread they ran on. A second thread/start, the swap to a
 * thread that runs the tool hook, answers late.
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
      reply({ data: [{ hooks: [{ key: "k", source: "sessionFlags", command: hook, trustStatus: "untrusted", currentHash: "h" }] }] });
      break;
    case "turn/start": {
      const text = params.input?.[0]?.text ?? "";
      const turn = { id: "turn-" + ++turns + "-on-" + params.threadId, items: [], status: "inProgress", error: null, startedAt: 1 };
      reply({ turn });
      const note = (method, extra) => send({ method, params: { threadId: params.threadId, turnId: turn.id, ...extra } });
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

/** Reads a session's events as they come; `ended` settles when they stop. */
function collect(session: CodexSession): { events: HarnessEvent[]; ended: Promise<void> } {
  const events: HarnessEvent[] = [];
  const ended = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, ended };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((resolve) => setTimeout(resolve, ms, "timed out").unref()),
  ]);
}

describe("CodexSession", () => {
  it("ends its events when closed before it started", async () => {
    const session = new CodexSession(config());
    const { events, ended } = collect(session);
    await session.close();
    assert.notEqual(await within(ended, 1_000), "timed out");
    assert.deepEqual(events, [{ type: "session.closed", error: null }]);
  });
});
