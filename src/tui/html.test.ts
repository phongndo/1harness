import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlText } from "./html.ts";

describe("htmlText", () => {
  it("keeps a page's text, a block to a line, without its markup", () => {
    const html = `<!doctype html><html><head><title>t</title><style>h1{color:red}</style></head>
      <body><h1>Report</h1><p>Build <b>passed</b> in 4&nbsp;s &amp; ran 12&#x20;tests.</p>
      <ul><li>lexer</li><li>parser</li></ul><script>alert(1)</script></body></html>`;
    assert.deepEqual(htmlText(html), [
      "Report",
      "",
      "Build passed in 4 s & ran 12 tests.",
      "",
      "• lexer",
      "• parser",
    ]);
  });

  it("puts a table's rows on lines and keeps the place of drawings and images", () => {
    const html = `<table><tr><th>Step</th><th>Time</th></tr><tr><td>lex</td><td>2s</td></tr></table>
      <svg width="10"><text>42</text></svg><img src="a.png" alt="Logo">`;
    assert.deepEqual(htmlText(html), ["Step   Time", "lex   2s", "", "▣ graphic", "", "▣ Logo"]);
  });

  it("leaves an unknown entity as it is", () => {
    assert.deepEqual(htmlText("<p>a &bogus; b &#0; c</p>"), ["a &bogus; b &#0; c"]);
  });
});
