import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInput } from "./input.ts";

describe("parseInput", () => {
  it("reads key=value words as JSON where they parse, else as text", () => {
    assert.deepEqual(parseInput(["threadId=ab12", "turn=3", "fresh=true", "model=null"]), {
      threadId: "ab12",
      turn: 3,
      fresh: true,
      model: null,
    });
  });

  it("puts words with no = on the value before them, so a message can have spaces", () => {
    assert.deepEqual(parseInput(["threadId=ab12", "message=fix", "the", "tests"]), {
      threadId: "ab12",
      message: "fix the tests",
    });
    assert.throws(() => parseInput(["loose"]), /not key=value/);
  });

  it("takes one JSON object as the whole input", () => {
    assert.deepEqual(parseInput(['{"answers":{"q1":["yes"]}}']), { answers: { q1: ["yes"] } });
    assert.throws(() => parseInput(["{}", "x=1"]), /not key=value/);
  });
});
