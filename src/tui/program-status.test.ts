import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StatusReporter,
  encodeStatus,
  statusRecords,
  validId,
  type ThreadStatusInput,
} from "./program-status.ts";

function thread(id: string, overrides: Partial<ThreadStatusInput> = {}): ThreadStatusInput {
  return {
    id,
    parentId: null,
    title: `Thread ${id}`,
    status: "idle",
    request: null,
    lastRun: null,
    error: null,
    activity: null,
    notify: true,
    ...overrides,
  };
}

function run(index: number, status: "running" | "completed" | "failed", result = "") {
  return { index, status, result, error: status === "failed" ? "rate limited" : null };
}

const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");

describe("encodeStatus", () => {
  it("writes pairs with base64 text, and a kind only for blocked records", () => {
    assert.equal(
      encodeStatus({
        id: "t1/t3",
        state: "blocked",
        kind: "permission",
        app: "1harness",
        title: "Fix the parser",
        msg: "Run pnpm test?",
      }),
      `\x1b]7501;state=blocked:id=t1/t3:kind=permission:app=1harness:title=${Buffer.from("Fix the parser").toString("base64")}:msg=${Buffer.from("Run pnpm test?").toString("base64")}\x1b\\`,
    );
    assert.equal(
      encodeStatus({ id: null, state: "working", kind: "question" }),
      "\x1b]7501;state=working\x1b\\",
    );
    assert.equal(encodeStatus({ id: null, state: "clear" }), "\x1b]7501;state=clear\x1b\\");
  });

  it("keeps text to one safe line within the protocol's limits", () => {
    const sequence = encodeStatus({
      id: "t1",
      state: "done",
      msg: `line one\nline\ttwo\u0007‮ ${"é".repeat(3000)}`,
      title: "x".repeat(500),
    });
    const msg = /msg=([A-Za-z0-9+/=]+)/.exec(sequence)?.[1] ?? "";
    const title = /title=([A-Za-z0-9+/=]+)/.exec(sequence)?.[1] ?? "";
    assert.ok(decode(msg).startsWith("line one line two "));
    assert.ok(Buffer.byteLength(decode(msg)) <= 2048);
    assert.equal(decode(title).length, 192);
    assert.ok(sequence.length < 4096);
  });

  it("accepts only IDs in the protocol's grammar", () => {
    assert.equal(validId("t1/t3/t9"), true);
    assert.equal(validId("t1//t3"), false);
    assert.equal(validId("a b"), false);
    assert.equal(validId(Array.from({ length: 9 }, (_, index) => `t${index}`).join("/")), false);
    assert.throws(() => encodeStatus({ id: "bad id", state: "idle" }), /Not a status ID/);
  });
});

describe("statusRecords", () => {
  it("maps each thread's state, nested under the thread that started it", () => {
    const records = statusRecords(
      [
        thread("t1", { status: "working", activity: "Reading the parser" }),
        thread("t3", {
          parentId: "t1",
          status: "waiting",
          request: { kind: "approval", title: "Run pnpm test?" },
        }),
        thread("t4", {
          parentId: "t1",
          status: "waiting",
          request: { kind: "question", title: "Which file?" },
        }),
        thread("t5", { lastRun: run(2, "completed", "Fixed it.\nDetails follow.") }),
        thread("t6", { lastRun: run(1, "failed") }),
        thread("t7", { status: "closed" }),
      ],
      () => 0,
    );
    assert.deepEqual(
      records.slice(1).map((record) => [record.id, record.state, record.kind, record.msg]),
      [
        ["t1", "working", undefined, "Reading the parser"],
        ["t1/t3", "blocked", "permission", "Run pnpm test?"],
        ["t1/t4", "blocked", "question", "Which file?"],
        ["t5", "done", undefined, "Fixed it."],
        ["t6", "error", undefined, "rate limited"],
      ],
    );
    // 1harness as a whole shows what most needs the user: here, a request.
    assert.deepEqual(records[0], {
      id: null,
      state: "blocked",
      app: "1harness",
      kind: "permission",
      msg: "t1/t3: Run pnpm test?",
    });
  });

  it("treats seen runs, and an agent's finished work, as idle", () => {
    const records = statusRecords(
      [
        thread("t1", { lastRun: run(3, "completed", "done") }),
        thread("t2", { notify: false, lastRun: run(1, "completed", "for my parent") }),
        thread("t3", { notify: false, lastRun: run(1, "failed") }),
      ],
      (id) => (id === "t1" ? 3 : 0),
    );
    assert.deepEqual(
      records.map((record) => [record.id, record.state]),
      [
        [null, "idle"],
        ["t1", "idle"],
        ["t2", "idle"],
        ["t3", "idle"],
      ],
    );
  });

  it("reports UUID threads by their short IDs", () => {
    const root = "3f9c2a1b-7d4e-4a10-9b2c-0123456789ab";
    const child = "77aa0000-0000-4000-8000-000000000003";
    const records = statusRecords(
      [thread(root, { status: "working" }), thread(child, { parentId: root, status: "working" })],
      () => 0,
    );
    assert.deepEqual(
      records.map((record) => record.id),
      [null, "3f9c2a1b", "3f9c2a1b/77aa0000"],
    );
  });
});

describe("StatusReporter", () => {
  it("writes only what changed, clears what is gone deepest first, and clears all at the end", () => {
    const writes: string[] = [];
    const reporter = new StatusReporter((data) => writes.push(data));
    reporter.update([
      { id: null, state: "working", app: "1harness" },
      { id: "t1", state: "working" },
      { id: "t1/t3", state: "working" },
    ]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.split("\x1b]7501;").length, 4);
    reporter.update([
      { id: null, state: "working", app: "1harness" },
      { id: "t1", state: "working" },
      { id: "t1/t3", state: "working" },
    ]);
    assert.equal(writes.length, 1);
    reporter.update([{ id: null, state: "idle", app: "1harness" }]);
    assert.equal(
      writes[1],
      "\x1b]7501;state=idle:app=1harness\x1b\\\x1b]7501;state=clear:id=t1/t3\x1b\\\x1b]7501;state=clear:id=t1\x1b\\",
    );
    reporter.clear();
    reporter.clear();
    assert.deepEqual(writes.slice(2), ["\x1b]7501;state=clear\x1b\\"]);
  });
});
