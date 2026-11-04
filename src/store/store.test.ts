import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
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
    forkedFrom: null,
    forkContext: null,
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
    named: false,
    seenRuns: 0,
    usage: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const message = (id: string) => ({ id, input: { text: id }, origin: { type: "user" as const } });

describe("Store", () => {
  it("finds threads by the start of their IDs", () => {
    const store = Store.memory();
    store.saveThread(row("3f9c2a1b-0000-4000-8000-000000000001", { updatedAt: 1 }));
    store.saveThread(row("3f9c2a1b-0000-4000-8000-000000000002", { updatedAt: 2 }));
    store.saveThread(row("77aa0000-0000-4000-8000-000000000003"));
    assert.deepEqual(store.threadIdsStartingWith("3F9C2A1B"), [
      "3f9c2a1b-0000-4000-8000-000000000002",
      "3f9c2a1b-0000-4000-8000-000000000001",
    ]);
    assert.deepEqual(store.threadIdsStartingWith("77aa0000"), [
      "77aa0000-0000-4000-8000-000000000003",
    ]);
    assert.deepEqual(store.threadIdsStartingWith("00000000"), []);
  });

  it("keeps what the harness last said of context and cost", () => {
    const store = Store.memory();
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      contextTokens: 30_000,
      contextWindow: 1_000_000,
      costUsd: 0.16,
      cachedTokens: null,
    };
    store.saveThread(row("t1", { usage }));
    assert.deepEqual(store.thread("t1")?.usage, usage);
    store.saveThread(row("t2"));
    assert.equal(store.thread("t2")?.usage, null);
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
    store.recordMessage("t1", { ...message("a"), requestId: "r1" }, { text: "a", id: "a" });
    store.recordMessage("t1", message("b"), { text: "b", id: "b" });
    store.recordMessage("t1", message("c"), { text: "c", id: "c" });
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
      contextWindow: 200_000,
      leftAt: 3,
    });
    assert.equal(store.visits("t1").get("codex")?.contextWindow, 200_000);
    assert.equal(store.threadByNative("codex-9")?.id, "t1");
    // A search with only punctuation matches nothing rather than failing.
    assert.deepEqual(store.search('"*:'), []);
    store.deleteThread("t2");
    assert.equal(store.thread("t2"), null);
    assert.deepEqual(store.log("t2"), []);
    store.close();
  });

  it("adds the context window to a store's earlier visits", () => {
    const file = join(root, "old-visits.db");
    Store.open(file).close();
    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE visits DROP COLUMN context_window");
    old.exec(
      "INSERT INTO visits (thread_id, harness, native, runs, context_tokens, left_at) VALUES ('t1', 'codex', 'n', 2, 5, 3)",
    );
    old.close();
    const store = Store.open(file);
    assert.deepEqual(store.visits("t1").get("codex"), {
      native: "n",
      runs: 2,
      model: null,
      effort: null,
      contextTokens: 5,
      contextWindow: null,
      leftAt: 3,
    });
    store.close();
  });
});
