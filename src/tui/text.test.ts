import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  oneLineText,
  outputText,
  plainText,
  spread,
  truncate,
  visibleWidth,
  wrap,
} from "./text.ts";

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

  it("never makes a row wider than asked, even when a hanging indent is wider than the lead", () => {
    // A bullet or detail row whose next rows indent further than its first text.
    const lines = [
      "  /tmp/claude-1000/-home-dp-code-1harness/58bb1dde/scratchpad/live/polish/plan-demo.txt",
      `  • ${BOLD}see https://example.com/a/very/long/path/that/never/has/a/space/in/it${RESET} ok`,
      "a b c 日本語の長い単語がここにありますそしてまだ続きます end",
    ];
    for (const line of lines)
      for (const indent of ["", "  ", "    ", "      "])
        for (let width = 8; width <= 90; width++)
          for (const row of wrap(line, width, indent))
            assert.ok(visibleWidth(row) <= width, `${width} ${JSON.stringify(indent)}: ${row}`);
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

describe("plainText and wide symbols", () => {
  it("keeps only what prints, as a terminal would show it", () => {
    assert.equal(plainText("a\tb\r\nc\x1b[31mred\x1b[0m"), "a    b\ncred");
    // A command's output overwrites with \r, as a terminal does; prose breaks the line.
    assert.equal(outputText("Progress: 10\rProgress: 99"), "Progress: 99");
    assert.equal(plainText("line one\rline two"), "line one\nline two");
    assert.equal(oneLineText("Steps:\n1. open\n2. sign in"), "Steps: 1. open 2. sign in");
    assert.equal(plainText("bell\x07 and\x85 del\x7f\n✓ 😀 café"), "bell and del\n✓ 😀 café");
  });

  it("counts emoji that terminals draw wide as two columns", () => {
    for (const symbol of ["✅", "❌", "⚡", "✨", "⭐", "⏳", "☕"])
      assert.equal(visibleWidth(symbol), 2);
    for (const symbol of ["✓", "✗", "●", "◆", "→"]) assert.equal(visibleWidth(symbol), 1);
  });
});
