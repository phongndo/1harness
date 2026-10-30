import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "./editor.ts";

describe("Editor", () => {
  it("edits multi-line text and reports the cursor after the prefix", () => {
    const editor = new Editor();
    editor.insert("one\ntwo");
    editor.home();
    editor.insert(">");
    assert.equal(editor.text, "one\n>two");
    assert.deepEqual(editor.layout("┃ ", 80).cursor, { row: 1, column: 3 });
    editor.end();
    editor.deleteWordBack();
    assert.equal(editor.text, "one\n");
  });

  it("finds the line start at the very beginning of a multi-line buffer", () => {
    const editor = new Editor();
    editor.insert("ab\ncd");
    for (let index = 0; index < 5; index++) editor.left();
    editor.home();
    editor.insert("x");
    assert.equal(editor.text, "xab\ncd");
  });

  it("finds an @ word at the cursor and replaces it", () => {
    const editor = new Editor();
    editor.insert("see @src/ap");
    assert.deepEqual(editor.token("@"), { start: 4, query: "src/ap" });
    editor.replaceToken(4, "@src/app.ts ");
    assert.equal(editor.text, "see @src/app.ts ");
    assert.equal(editor.token("@"), null);
    editor.set("mail a@b");
    assert.equal(editor.token("@"), null);
    editor.set("@x y");
    editor.home();
    editor.right();
    assert.equal(editor.token("@"), null, "the cursor sits inside the word");
  });

  it("restores the draft after browsing history", () => {
    const editor = new Editor();
    editor.insert("sent");
    editor.take();
    editor.insert("draft");
    assert.equal(editor.historyUp(), true);
    assert.equal(editor.text, "sent");
    assert.equal(editor.historyDown(), true);
    assert.equal(editor.text, "draft");
  });

  it("wraps long lines and keeps the cursor on the wrapped row", () => {
    const editor = new Editor();
    editor.insert("abcdefgh");
    const layout = editor.layout("> ", 6);
    assert.deepEqual(layout.rows, ["> abcd", "> efgh", "> "]);
    assert.deepEqual(layout.cursor, { row: 2, column: 2 });
    editor.left();
    assert.deepEqual(editor.layout("> ", 6).cursor, { row: 1, column: 5 });
  });

  it("wraps at spaces and moves the cursor with the carried word", () => {
    const editor = new Editor();
    editor.insert("one two three");
    assert.deepEqual(editor.layout("", 9).rows, ["one two ", "three"]);
    assert.deepEqual(editor.layout("", 9).cursor, { row: 1, column: 5 });
    for (let index = 0; index < 5; index++) editor.left();
    assert.deepEqual(editor.layout("", 9).cursor, { row: 1, column: 0 });
  });

  it("moves between lines keeping the column", () => {
    const editor = new Editor();
    editor.insert("long line\nab\nthird");
    assert.equal(editor.up(), true);
    assert.equal(editor.layout("", 80).cursor.column, 2);
    assert.equal(editor.up(), true);
    assert.deepEqual(editor.layout("", 80).cursor, { row: 0, column: 2 });
    assert.equal(editor.up(), false);
    assert.equal(editor.down(), true);
    assert.equal(editor.down(), true);
    assert.equal(editor.down(), false);
  });
});
