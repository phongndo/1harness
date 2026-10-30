import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unifiedDiff } from "./diff.ts";

describe("unifiedDiff", () => {
  it("shows changed lines with three lines of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    assert.equal(unifiedDiff(before, after), "@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h");
  });

  it("splits distant changes into hunks and handles new files", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[1] = "changed 1";
    after[18] = "changed 18";
    const diff = unifiedDiff(before.join("\n"), after.join("\n"));
    assert.equal(diff.split("\n").filter((line) => line.startsWith("@@")).length, 2);
    assert.equal(unifiedDiff("", "one\ntwo\n"), "@@ -0,0 +1,2 @@\n+one\n+two");
    assert.equal(unifiedDiff("same", "same"), "");
  });
});
