import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadListing } from "../protocol.ts";
import { family, threadEntries } from "./threads.ts";

function listed(
  id: string,
  parentId: string | null,
  at: number,
  extra: Partial<ThreadListing> = {},
): ThreadListing {
  return {
    id,
    title: id,
    harness: "claude",
    model: null,
    effort: null,
    cwd: "/code",
    status: "closed",
    parentId,
    runCount: 1,
    createdAt: at,
    updatedAt: at,
    pinned: false,
    archived: false,
    unseen: false,
    native: null,
    ...extra,
  };
}

const ids = (entries: { id: string; depth: number }[]) =>
  entries.map((entry) => `${"  ".repeat(entry.depth)}${entry.id}`);

describe("thread lists", () => {
  const stored = [
    listed("t1", null, 1),
    listed("t3", "t1", 3),
    listed("t2", "t1", 2),
    listed("t4", "t2", 4),
    listed("t5", null, 5),
    // Its thread is gone, so it shows nowhere.
    listed("t6", "t9", 6),
  ];

  it("lists threads newest first, each over its agents, oldest first, then the archived", () => {
    const archived = [listed("t7", null, 7, { archived: true })];
    const entries = threadEntries(stored, archived, [], null);
    assert.deepEqual(ids(entries), ["t5", "t1", "  t2", "    t4", "  t3", "t7"]);
    assert.equal(entries.at(-1)?.archived, true);
  });

  it("leaves out the thread on screen while nothing has run in it", () => {
    const empty = [...stored, listed("t8", null, 8, { runCount: 0 })];
    assert.equal(ids(threadEntries(empty, [], [], "t8")).includes("t8"), false);
    assert.equal(ids(threadEntries(empty, [], [], null)).includes("t8"), true);
  });

  it("gives /lineage the agents under the thread an agent came from", () => {
    const shown = family(stored, [], "t4");
    assert.equal(shown.title, "t1");
    assert.deepEqual(ids(shown.agents), ["t2", "  t4", "t3"]);
  });
});
