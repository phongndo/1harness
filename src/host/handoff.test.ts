import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handoffText } from "./handoff.ts";
import type { RunRecord } from "./manager.ts";

function run(index: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    index,
    turnId: `turn-${index}`,
    harness: "claude",
    status: "completed",
    input: `question ${index}`,
    origin: { type: "user" },
    result: `answer ${index}`,
    files: [],
    commands: [],
    error: null,
    startedAt: 0,
    endedAt: 0,
    ...overrides,
  };
}

const label = (harness: string) => ({ claude: "Claude Code", codex: "Codex" })[harness] ?? harness;

describe("handoffText", () => {
  it("says who sent each turn, how it ended, and which files it changed", () => {
    const text = handoffText({
      threadId: "t1",
      to: "codex",
      resumed: false,
      label,
      runs: [
        run(1, {
          files: ["src/a.ts", "src/b.ts"],
          commands: [
            { command: "pnpm   test\n  --watch=false", exitCode: 1 },
            { command: "git status", exitCode: 0 },
          ],
        }),
        run(2, { origin: { type: "task", from: "t0", task: "check it" }, input: "check it" }),
        run(3, { status: "failed", error: "rate limited", result: null }),
        run(4, { status: "running" }),
      ],
    });
    assert.ok(text);
    assert.match(text, /has moved to you \(Codex\) from Claude Code\./);
    // Old turns are context, so the new harness does not carry out old requests again.
    assert.match(text, /finished history, not requests: do not redo them/);
    assert.match(
      text,
      /Turn 1 · Claude Code\nUser: question 1\nReply: answer 1\nCommands: `pnpm test --watch=false` → exit 1; `git status` → exit 0\nFiles changed: src\/a\.ts, src\/b\.ts/,
    );
    assert.match(text, /Turn 2 · Claude Code\nTask from thread t0: check it/);
    assert.match(
      text,
      /Turn 3 · Claude Code · failed: rate limited\nUser: question 3\nReply: \(none\)/,
    );
    // A run still going is not a turn the harness missed.
    assert.doesNotMatch(text, /Turn 4/);
  });

  it("keeps the original request and the newest turns, naming the call for the rest", () => {
    const long = "x".repeat(5_000);
    const runs = Array.from({ length: 20 }, (_, index) =>
      run(index + 1, { input: long, result: long }),
    );
    const text = handoffText({ threadId: "t7", to: "codex", resumed: false, label, runs });
    assert.ok(text);
    assert.ok(text.length < 30_000);
    const turns = [...text.matchAll(/^Turn (\d+) ·/gm)].map((match) => Number(match[1]));
    assert.equal(turns[0], 1);
    assert.equal(turns.at(-1), 20);
    // The turns left out form one range, with the exact call that reads them.
    const missing = Array.from({ length: 20 }, (_, index) => index + 1).filter(
      (index) => !turns.includes(index),
    );
    assert.ok(missing.length > 0);
    const [from, to] = [missing[0], missing.at(-1)];
    assert.deepEqual(
      missing,
      Array.from({ length: to! - from! + 1 }, (_, index) => from! + index),
    );
    assert.ok(
      text.includes(
        `[Turns ${from}–${to} are left out here. Read them only if you need them: thread_read {"threadId": "t7", "fromRun": ${from}, "toRun": ${to}}]`,
      ),
    );
    // Long messages are cut, with how much was left out.
    assert.match(text, /x… \(3000 more characters\)/);
  });

  it("does not pin the first turn for a harness that resumes, since it saw it", () => {
    const long = "x".repeat(5_000);
    const runs = Array.from({ length: 20 }, (_, index) =>
      run(index + 11, { input: long, result: long, harness: "codex" }),
    );
    const text = handoffText({ threadId: "t7", to: "claude", resumed: true, label, runs });
    assert.ok(text);
    assert.match(
      text,
      /You are back on 1harness thread t7\. While you were away it ran on Codex\./,
    );
    assert.match(text, /^\[Turns 11–\d+ are left out here/m);
    assert.match(text, /Turn 30 · Codex/);
    assert.doesNotMatch(text, /Turn 11 ·/);
  });

  it("is null when the harness missed nothing", () => {
    assert.equal(
      handoffText({ threadId: "t1", to: "codex", resumed: true, label, runs: [] }),
      null,
    );
  });
});
