import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spread, truncate, visibleWidth, wrap } from "./text.ts";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

describe("visibleWidth", () => {
  it("ignores escape sequences and counts wide characters twice", () => {
    assert.equal(visibleWidth("\x1b[1mab\x1b[22m"), 2);
    assert.equal(visibleWidth("日本"), 4);
  });
});

describe("wrap", () => {
  it("leaves short lines alone", () => {
    assert.deepEqual(wrap("short", 10), ["short"]);
  });

  it("breaks prose at spaces and indents continuation rows", () => {
    assert.deepEqual(wrap("  alpha beta gamma", 12, "  "), ["  alpha beta", "  gamma"]);
  });

  it("breaks words longer than a row anywhere", () => {
    assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  });

  it("hard-wraps code without looking for spaces", () => {
    assert.deepEqual(wrap("ab cd ef", 4, "", true), ["ab c", "d ef"]);
  });

  it("carries styles to the next row and closes them on the first", () => {
    const rows = wrap(`${BOLD}one two${RESET}`, 4);
    assert.deepEqual(rows, [`${BOLD}one${RESET}`, `${BOLD}two${RESET}`]);
    for (const row of rows) assert.ok(visibleWidth(row) <= 4);
  });

  it("keeps wide characters whole", () => {
    assert.deepEqual(wrap("日本語", 5), ["日本", "語"]);
  });
});

describe("truncate and spread", () => {
  it("cuts styled text with an ellipsis and resets styles", () => {
    assert.equal(truncate(`${BOLD}abcdef`, 4), `${BOLD}abc…${RESET}`);
    assert.equal(truncate("abc", 4), "abc");
  });

  it("right-aligns a tag and drops it when there is no room", () => {
    assert.equal(spread("left", "tag", 12), "left     tag");
    assert.equal(spread("left side", "tag", 8), "le…  tag");
    assert.equal(spread("left side", "tag", 4), "lef…");
  });
});
