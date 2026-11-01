import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { picture, placeholderRow } from "./images.ts";
import { solidPng } from "./images.test.ts";
import { pageKey, paintSelection, selectedText, viewerFrame, wordAt } from "./pointer.ts";
import { columnsText, selectColumns, visibleWidth } from "./text.ts";

const media = { graphics: true, cell: { width: 8, height: 16 }, maxRows: 20 };

/** A key as the decoder makes one. */
const key = (
  name: string,
  text = "",
  mods: Partial<Record<"ctrl" | "meta" | "shift", boolean>> = {},
) => ({
  name,
  text,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
});

describe("the mouse", () => {
  it("shows columns selected in reverse video, through styles and past the text's end", () => {
    const row = "ab\x1b[1mcd\x1b[0mef";
    const painted = selectColumns(row, 1, 4);
    assert.equal(stripVTControlCharacters(painted), "abcdef");
    assert.ok(painted.startsWith("a\x1b[7mb"), painted);
    // The reset inside the selection does not end it.
    assert.ok(painted.includes("\x1b[0m\x1b[7m"), painted);
    assert.ok(painted.includes("\x1b[27me"), painted);
    const past = selectColumns("ab", 1, 5);
    assert.equal(stripVTControlCharacters(past), "ab   ");
    assert.equal(visibleWidth(past), 5);
  });

  it("reads plain text out of columns, wide characters by where they start", () => {
    assert.equal(columnsText("\x1b[2m  hello\x1b[0m world", 2, 7), "hello");
    assert.equal(columnsText("日本語", 2, 4), "本");
    assert.equal(columnsText("abc", 1), "bc");
  });

  it("paints what a selection covers, row by row, and leaves pictures alone", () => {
    const shown = picture(solidPng(16, 16))!;
    const rows = ["  first line", placeholderRow(shown, 0, 2), "  third line"];
    const painted = paintSelection(
      rows,
      { anchor: { row: 12, column: 2 }, head: { row: 10, column: 4 } },
      10,
      14,
    );
    assert.ok(painted[0]?.includes("\x1b[7m"));
    assert.equal(painted[1], rows[1], "a picture's cells are not text");
    assert.ok(painted[2]?.startsWith("\x1b[7m  t"), JSON.stringify(painted[2]));
    assert.ok(painted[2]?.includes("\x1b[27mhird"));
  });

  it("copies selected rows as plain text, without the transcript's indent or markers", () => {
    const lines = ["  Some prose here", "    indented code", "  last words"];
    assert.equal(
      selectedText(lines, { anchor: { row: 0, column: 0 }, head: { row: 2, column: 6 } }),
      "Some prose here\n  indented code\nlast",
    );
    // Started mid-row, the first row is what follows.
    assert.equal(
      selectedText(lines.slice(0, 2), {
        anchor: { row: 0, column: 7 },
        head: { row: 1, column: 30 },
      }),
      "prose here\n  indented code",
    );
    const user = ["┃ Run ls in this folder", "┃ then tell me"];
    assert.equal(
      selectedText(user, { anchor: { row: 0, column: 0 }, head: { row: 1, column: 40 } }),
      "Run ls in this folder\nthen tell me",
    );
    assert.equal(
      selectedText(user, { anchor: { row: 0, column: 9 }, head: { row: 1, column: 40 } }),
      "in this folder\nthen tell me",
    );
  });

  it("finds the word under a double click: a run of anything but spaces", () => {
    const row = "  open src/tui/app.ts now";
    assert.deepEqual(wordAt(row, 9), { from: 7, to: 20 });
    assert.equal(wordAt(row, 6), null);
    assert.deepEqual(wordAt("日本 語", 1), { from: 0, to: 3 });
  });

  it("shows a picture whole, centered under its name, and a tall page scrolled", () => {
    const wide = picture(solidPng(400, 100))!;
    const frame = viewerFrame(
      wide,
      "chart",
      "esc closes",
      { columns: 80, rows: 24 },
      media,
      0,
      false,
    );
    assert.equal(frame.rows.length, 24);
    assert.match(stripVTControlCharacters(frame.rows[0] ?? ""), /chart · 400×100.*esc closes/);
    assert.deepEqual([frame.shown.columns, frame.shown.rows], [50, 6]);
    assert.deepEqual([frame.left, frame.top], [15, 9], "where it is drawn, for the mouse");
    assert.equal(frame.more, 0);
    const tall = picture(solidPng(600, 1600))!;
    const page = viewerFrame(tall, "page", "", { columns: 80, rows: 24 }, media, 5, true);
    assert.equal(page.shown.columns, 75, "as wide as fits");
    assert.equal(page.more, page.shown.rows - 22);
    assert.equal(page.scroll, 5);
    assert.match(stripVTControlCharacters(page.rows.at(-1) ?? ""), /% · ↑↓ scroll/);
    const fitted = viewerFrame(tall, "image", "", { columns: 80, rows: 24 }, media, 5, false);
    assert.equal(fitted.shown.rows, 22, "an image fits the screen instead");
    assert.equal(fitted.more, 0);
  });

  it("passes keys to a live page: named ones and chords as keys, the rest as text", () => {
    assert.deepEqual(pageKey(key("return")), { type: "key", key: "Enter" });
    assert.deepEqual(pageKey(key("tab", "", { shift: true })), {
      type: "key",
      key: "Tab",
      modifiers: 8,
    });
    assert.deepEqual(pageKey(key("a", "a")), { type: "text", text: "a" });
    assert.deepEqual(pageKey(key("a", "", { ctrl: true })), {
      type: "key",
      key: "a",
      modifiers: 2,
    });
    assert.equal(pageKey(key("f13")), null);
  });
});
