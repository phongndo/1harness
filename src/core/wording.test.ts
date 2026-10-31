import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK, askFor, askForChanges, planOptions } from "./wording.ts";

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
