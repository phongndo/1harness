import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK, ago, askFor, askForChanges, planOptions } from "./wording.ts";

const labels = (options: ReturnType<typeof planOptions>) =>
  options.map((option) => [option.id, option.label]);

describe("wording", () => {
  it("asks about an action by what it is", () => {
    assert.equal(askFor({ type: "command", command: "ls", cwd: null }), ASK.command);
    assert.equal(askFor({ type: "file_change", paths: ["src/a.ts"] }), "Edit a.ts?");
    assert.equal(askFor({ type: "file_change", paths: ["a", "b"] }), ASK.edits);
    assert.equal(askForChanges([{ path: "src/db.ts", kind: "delete" }]), "Delete db.ts?");
    assert.equal(askForChanges([{ path: "new.ts", kind: "add" }]), "Create new.ts?");
    assert.equal(askForChanges([{ path: "a.ts", kind: "update", movePath: "b.ts" }]), "Move a.ts?");
    assert.equal(
      askFor({ type: "tool", tool: "search", server: "docs", input: {} }),
      "Allow docs · search?",
    );
  });

  it("offers a plan in the thread's own mode first, then narrower ones the harness has", () => {
    assert.deepEqual(labels(planOptions("full-access", ["supervised", "full-access"])), [
      ["full-access", "Yes, implement it in full-access mode"],
      ["supervised", "Yes, implement it in supervised mode"],
      ["keep", "No, keep planning"],
    ]);
    // Accepting a plan never widens the thread; /mode does.
    assert.deepEqual(
      planOptions("supervised", ["supervised", "auto-edit"]).map((option) => option.id),
      ["supervised", "keep"],
    );
  });
});

const now = new Date(2026, 9, 31, 22, 0).getTime();

/** A time this many days, hours, and minutes before `now`. */
function at(days: number, hours = 0, minutes = 0): number {
  return new Date(2026, 9, 31 - days, 22 - hours, -minutes).getTime();
}

describe("ago", () => {
  it("says how long ago, more coarsely the longer it was", () => {
    assert.equal(ago(now - 20_000, now), "just now");
    assert.equal(ago(at(0, 0, 5), now), "5m ago");
    assert.equal(ago(at(0, 3), now), "3h ago");
    assert.equal(ago(at(1), now), "yesterday");
    assert.match(ago(at(3), now), /^[A-Z][a-z]+day$/);
    assert.match(ago(at(20), now), /Oct/);
    assert.match(ago(new Date(2025, 0, 2).getTime(), now), /2025/);
  });
});
