import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { goodbye } from "./goodbye.ts";

const LOCAL = { label: "local", local: true, inProcess: false };
const IN_PROCESS = { label: "local", local: true, inProcess: true };

function thread(id: string, runCount = 1, threadId: string | null = `native-${id}`) {
  return { id, harness: "codex", runCount, info: { threadId } };
}

describe("goodbye", () => {
  it("names the server /connect moves to", () => {
    const base = { server: LOCAL, stored: true, current: thread("t1"), working: [] };
    assert.deepEqual(goodbye({ ...base, next: "box" }), ["Connecting to box…"]);
    assert.deepEqual(goodbye({ ...base, next: "" }), ["Connecting to this machine's 1harness…"]);
  });

  it("resumes the thread on screen by its 1harness ID where the host keeps threads", () => {
    const said = goodbye({
      next: undefined,
      server: { label: "box", local: false, inProcess: false },
      stored: true,
      current: thread("t1"),
      working: [],
    });
    assert.deepEqual(said, ["Resume with: 1harness -S box --resume t1"]);
  });

  it("resumes the harness's own thread where the host keeps none, and nothing without one", () => {
    const base = { next: undefined, server: IN_PROCESS, stored: false, working: [] };
    assert.deepEqual(goodbye({ ...base, current: thread("t1") }), [
      "Resume with: 1harness --harness codex --resume native-t1",
    ]);
    assert.deepEqual(goodbye({ ...base, current: thread("t1", 1, null) }), []);
  });

  it("says what a server carries on with, and comes back to it when the thread on screen is empty", () => {
    const said = goodbye({
      next: undefined,
      server: LOCAL,
      stored: true,
      current: thread("t1", 0),
      working: [thread("t2"), thread("t3")],
    });
    assert.deepEqual(said, [
      "t2, t3 are still working; they carry on in 1harness's server.",
      "Come back with: 1harness --resume t2",
    ]);
  });

  it("says what stopped with a 1harness that ran it", () => {
    const said = goodbye({
      next: undefined,
      server: IN_PROCESS,
      stored: true,
      current: thread("t1"),
      working: [thread("t1")],
    });
    assert.deepEqual(said, [
      "t1 stopped working: without a server, it ran in this 1harness.",
      "Resume with: 1harness --resume t1",
    ]);
  });
});
