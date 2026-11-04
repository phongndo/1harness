import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import { welcomeRows } from "./welcome.ts";

const thread = { harness: "Codex", model: "gpt-6", mode: "supervised" } as const;
const text = (width: number, height: number, more = {}) =>
  welcomeRows({ ...thread, ...more }, width, height)
    .map((row) => stripVTControlCharacters(row))
    .join("\n");

describe("a thread with nothing in it", () => {
  it("says who runs it, what they may do, and how to begin", () => {
    const shown = text(100, 20);
    assert.match(shown, /● Codex · gpt-6/);
    assert.match(shown, /Supervised: read freely; ask before edits and commands · \/mode changes/);
    assert.match(shown, /Describe a task to begin · \/resume picks up a thread/);
  });

  it("says full access never asks", () => {
    assert.match(text(100, 20, { mode: "full-access" }), /Full access: never ask/);
  });

  it("fits a short pane", () => {
    assert.equal(welcomeRows(thread, 40, 3).length, 3);
    assert.match(text(40, 3), /^  ● Codex/);
  });
});
