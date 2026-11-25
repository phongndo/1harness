import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ansiHtml, flow, hasFigures, markup } from "./markup.ts";
import { wholeBlocks } from "./transcript.ts";

const html = (text: string, bubble = false) =>
  markup(text, bubble)
    .parts.map((part) => part.html)
    .join("\n");

describe("markup", () => {
  it("escapes what it is given, in text, code, and links", () => {
    const out = html('<script>x</script> `<b>` [a"b](https://e.com/"><img>) <img src=x>');
    assert.doesNotMatch(out, /<script|<img|<b>/);
    assert.match(out, /&#60;script&#62;/);
  });

  it("links only to where a link may go", () => {
    assert.match(html("[a](https://e.com)"), /<a href="https:\/\/e\.com">a<\/a>/);
    assert.match(html("see https://e.com/x."), /<a href="https:\/\/e\.com\/x">.*<\/a>\./);
    assert.doesNotMatch(html("[a](javascript:alert(1))"), /href|javascript/);
    assert.match(html("[notes](src/notes.md)"), /<a class="f">notes<\/a>/);
  });

  it("reads lists in lists, and text that goes on under an item", () => {
    assert.equal(
      html("1. one\n   more\n   - in\n2. two"),
      '<ol><li>one\nmore<div style="padding-top:10.4px"><ul><li>in</li></ul></div></li><li>two</li></ol>'.replace(
        '<div style="padding-top:10.4px">',
        '<div style="padding-top:4px">',
      ),
    );
    assert.match(html("3. three\n4. four"), /<ol start="3">/);
    assert.equal(html("- [x] done"), '<ul><li class="k"><span class="t">☑</span>done</li></ul>');
    // A year that starts a line is not a list.
    assert.doesNotMatch(html("It was made in\n1984. Then it ran."), /<ol/);
  });

  it("gives code as written, and colors a template's own code", () => {
    const { parts, code } = markup("```ts\nconst a = `x${b}`;\n```");
    assert.deepEqual(code, [{ code: "const a = `x${b}`;", lang: "ts" }]);
    const text = parts[0]?.html
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, at: string) => String.fromCharCode(Number(at)));
    assert.equal(text, "tsconst a = `x${b}`;");
  });

  it("breaks a message's lines where they broke, and joins a reply's", () => {
    assert.match(html("a\nb", true), /a<br>b/);
    assert.doesNotMatch(html("a\nb"), /<br>/);
  });

  it("leaves what is drawn another way to what draws it", () => {
    assert.equal(hasFigures("```mermaid\ngraph TD\n```"), true);
    assert.equal(hasFigures("$$\nx\n$$"), true);
    assert.equal(hasFigures("![a](b.png)"), true);
    assert.equal(hasFigures("```ts\nx\n```"), false);
  });

  it("keeps the blocks there were as a reply grows", () => {
    const before = flow(markup("# A\n\none\n\n").parts);
    const after = flow(markup("# A\n\none\n\ntwo\n\n").parts);
    assert.deepEqual(after.slice(0, before.length), before);
  });

  it("shows a reply still coming up to its last whole block", () => {
    assert.equal(wholeBlocks("one\n\ntw"), "one\n\n");
    assert.equal(wholeBlocks("one"), "");
    assert.equal(wholeBlocks("a\n\n```ts\nx\n\ny"), "a\n\n");
    assert.equal(wholeBlocks("a\n\n```ts\nx\n```\nb"), "a\n\n```ts\nx\n```\n");
    // An item is whole once the next one starts; a heading waits for what it heads.
    assert.equal(wholeBlocks("- one\n- tw"), "- one\n");
    assert.equal(wholeBlocks("a\n\n## Next\n\nb"), "a\n\n");
    assert.equal(wholeBlocks("a\n\n## Next\n\nb\n\n"), "a\n\n## Next\n\nb\n\n");
  });

  it("keeps a row's styles", () => {
    assert.equal(
      ansiHtml("a \x1b[1mb\x1b[22m \x1b[38;2;1;2;3mc\x1b[39m"),
      'a <span style="font-weight:600;">b</span> <span style="color:rgb(1,2,3);">c</span>',
    );
  });
});
