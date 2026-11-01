import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Capabilities, SessionInfo } from "../core/events.ts";
import { Store, StoreLocked, type ThreadRow } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "1harness-store-"));
after(() => rmSync(root, { recursive: true, force: true }));

const info: SessionInfo = {
  harness: "claude",
  threadId: "native-1",
  cwd: "/work",
  model: null,
  effort: null,
  runtimeMode: "supervised",
  interactionMode: "default",
  version: null,
};
const capabilities: Capabilities = {
  steer: true,
  planMode: true,
  runtimeModes: ["supervised"],
  images: false,
  toolChecks: false,
  nativeSlashCommands: false,
  mcpActions: [],
};

function row(id: string, overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    title: `Thread ${id}`,
    cwd: "/work",
    harness: "claude",
    parentId: null,
    parentCallId: null,
    origin: "user",
    state: "open",
    info,
    capabilities,
    methods: [],
    handoff: null,
    seenWithoutHandoff: null,
    generation: 0,
    error: null,
    pinned: false,
    archived: false,
    seenRuns: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const message = (id: string) => ({ id, input: { text: id }, origin: { type: "user" as const } });

describe("Store", () => {
  it("gives out thread IDs once, across opens", () => {
    const path = join(root, "ids.db");
    const first = Store.open(path);
    assert.equal(first.nextThreadId(), "t1");
    assert.equal(first.nextThreadId(), "t2");
    first.close();
    const second = Store.open(path);
    assert.equal(second.nextThreadId(), "t3");
    second.close();
  });

  it("lets one process write at a time", () => {
    const path = join(root, "lock.db");
    const owner = Store.open(path);
    assert.throws(() => Store.open(path), StoreLocked);
    owner.close();
    Store.open(path).close();
  });

  it("keeps queued messages in order until sent or dropped", () => {
    const store = Store.memory();
    store.saveThread(row("t1"));
    store.recordMessage(
      "t1",
      { ...message("a"), requestId: "r1" },
      { text: "a", id: "a" },
      "queued",
    );
    store.recordMessage("t1", message("b"), { text: "b", id: "b" }, "queued");
    store.recordMessage("t1", message("c"), { text: "c", id: "c" }, "queued");
    store.setMessageState("a", "dispatched");
    store.setMessageState("c", "dropped");
    assert.deepEqual(
      store.queuedMessages("t1").map((queued) => queued.message.id),
      ["b"],
    );
    assert.equal(store.messageByRequest("t1", "r1"), "a");
    store.close();
  });

  it("finds threads by title, transcript, and the harness's own thread", () => {
    const store = Store.memory();
    store.saveThread(row("t1", { title: "Fix the parser", updatedAt: 5 }));
    store.saveThread(
      row("t2", { title: "Other", updatedAt: 9, info: { ...info, threadId: "n2" } }),
    );
    store.saveThread(row("t3", { title: "Gone", state: "closed", archived: true }));
    store.writeLog("t2", [
      {
        seq: 1,
        entry: {
          type: "item",
          item: { kind: "assistant_message", id: "r", text: "The lexer drops tabs." },
          done: true,
        },
      },
    ]);
    // A changed entry replaces what it added to search.
    store.writeLog("t2", [
      {
        seq: 1,
        entry: {
          type: "item",
          item: { kind: "assistant_message", id: "r", text: "The lexer keeps tabs." },
          done: true,
        },
      },
    ]);
    assert.deepEqual(
      store.listThreads({ scope: "recent" }).map((thread) => thread.id),
      ["t2", "t1"],
    );
    assert.deepEqual(
      store.listThreads({ scope: "recent", query: "parser" }).map((thread) => thread.id),
      ["t1"],
    );
    assert.deepEqual(
      store.listThreads({ scope: "recent", query: "lex" }).map((thread) => thread.id),
      ["t2"],
    );
    assert.deepEqual(
      store.search("keeps").map((hit) => hit.threadId),
      ["t2"],
    );
    assert.deepEqual(store.search("drops"), []);
    assert.deepEqual(
      store.listThreads({ scope: "archived" }).map((thread) => thread.id),
      ["t3"],
    );
    assert.equal(store.threadByNative("n2")?.id, "t2");
    store.saveVisit("t1", "codex", {
      native: "codex-9",
      runs: 2,
      model: null,
      effort: null,
      contextTokens: null,
      leftAt: 3,
    });
    assert.equal(store.threadByNative("codex-9")?.id, "t1");
    // A search with only punctuation matches nothing rather than failing.
    assert.deepEqual(store.search('"*:'), []);
    store.deleteThread("t2");
    assert.equal(store.thread("t2"), null);
    assert.deepEqual(store.log("t2"), []);
    store.close();
  });
});
