import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedMap } from "./cache.ts";

describe("BoundedMap", () => {
  it("forgets the entry set longest ago once it holds more than its limit", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    // Set again, `a` is the newest.
    map.set("a", 3);
    map.set("c", 4);
    assert.deepEqual(
      [...map],
      [
        ["a", 3],
        ["c", 4],
      ],
    );
  });
});
