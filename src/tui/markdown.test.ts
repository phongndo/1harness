import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { codeBlocks, inline, renderMarkdown } from "./markdown.ts";
import { visibleWidth } from "./text.ts";

const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row));

/** Markdown as plain rows. */
const text = (md: string, width = 60) => plain(renderMarkdown(md, width));

describe("Markdown blocks", () => {
  it("renders fx's prose, lists, headings, and code fences", () => {
    const rows = renderMarkdown(
      "Done.\n\n## Changes\n\n- Updated `notes.txt`\n1. first\n\n```ts\nconst x = 1;\n```",
      24,
    );
    assert.deepEqual(plain(rows), [
      "  Done.",
      "",
      "  Changes",
      "",
      "  • Updated notes.txt",
      "  1. first",
      "",
      `  ─ ts ${"─".repeat(17)}`,
      "  const x = 1;",
      `  ${"─".repeat(22)}`,
    ]);
  });

  it("wraps list items under their text", () => {
    assert.deepEqual(plain(renderMarkdown("- alpha beta gamma delta", 16)), [
      "  • alpha beta",
      "    gamma delta",
    ]);
  });

  it("puts a long word under its bullet rather than leaving the bullet alone", () => {
    const rows = text(`- https://example.com/${"a".repeat(60)}`, 40);
    assert.match(rows[0] ?? "", /^ {2}• https:/);
  });

  it("keeps a heading's own #, and closes fences only on a bare marker", () => {
    assert.deepEqual(text("# Learn C#"), ["  Learn C#"]);
    const rows = text("```js const x = 1``` inline\n\n```\ncode\n```py\nmore\n```\nprose");
    assert.equal(rows[0], "  js const x = 1 inline");
    assert.ok(rows.includes("  ```py"), "an info string does not close a fence");
    assert.equal(rows.at(-1), "  prose");
  });
});

describe("Markdown emphasis, links, and code spans", () => {
  it("reads emphasis as CommonMark does", () => {
    const cases: [string, string, string | null][] = [
      ["**Result: 2 * 3 = 6**", "Result: 2 * 3 = 6", "\u001b[1m"],
      ["Call f(**a) and g(**b).", "Call f(**a) and g(**b).", null],
      ["_Note_: and snake_case_name", "Note: and snake_case_name", "\u001b[3m"],
      ["*.ts and *.tsx, *it*", "*.ts and *.tsx, it", "\u001b[3m"],
      [
        "Wrap code in ``` fences and use `x` inline.",
        "Wrap code in ``` fences and use x inline.",
        null,
      ],
      ["***both***", "both", "\u001b[1m\u001b[3m"],
      ["[**the guide**](u)", "the guide (u)", "\u001b[1m"],
    ];
    for (const [md, shown, mark] of cases) {
      const out = inline(md);
      assert.equal(stripVTControlCharacters(out), shown, md);
      if (mark) assert.ok(out.includes(mark), md);
    }
  });

  it("keeps emphasis and links around code, and escapes literal", () => {
    assert.deepEqual(text("**`a.ts`** and [`b`](c) and \\*not\\* and *.ts or *.tsx"), [
      "  a.ts and b (c) and *not* and *.ts or *.tsx",
    ]);
  });

  it("leaves delimiters that do not open emphasis", () => {
    assert.deepEqual(
      text("a ** 2 + b ** 2, snake__case__name, [docs](https://a.com/__x__/y)", 90),
      ["  a ** 2 + b ** 2, snake__case__name, docs (https://a.com/__x__/y)"],
    );
  });

  it("keeps code spans as written, backslashes and all", () => {
    assert.deepEqual(text("`C:\\Users\\me` and `\\(\\d+\\)` and `a\\*b`"), [
      "  C:\\Users\\me and \\(\\d+\\) and a\\*b",
    ]);
  });

  it("keeps a heading bold after bold inside it", () => {
    const [heading = ""] = renderMarkdown("## Use **foo** now", 40);
    // Bold closes after foo, and opens again for the rest.
    assert.ok(heading.includes("foo\u001b[22m\u001b[1m now"), JSON.stringify(heading));
  });
});

describe("Markdown tables", () => {
  it("lines tables up in columns, aligned as the divider says", () => {
    const table = "| Name | Count |\n|:--|--:|\n| `a \\| b` | 3 |\n| longer name | 12 |";
    assert.deepEqual(plain(renderMarkdown(table, 40)), [
      "  Name        │ Count",
      "  ────────────┼──────",
      "  a | b       │     3",
      "  longer name │    12",
    ]);
  });

  it("wraps a table's cells inside their columns when it is too wide", () => {
    const table = "| Key | Value |\n|---|---|\n| k | one two three four five six |";
    const rows = plain(renderMarkdown(table, 24));
    assert.ok(rows.every((row) => row.length <= 24));
    assert.deepEqual(rows.slice(2), ["  k   │ one two three", "      │ four five six"]);
  });

  it("keeps a lone backtick in its cell, and wide tables within the width", () => {
    assert.deepEqual(text("| Key | Meaning |\n|---|---|\n| ` | a backtick |").slice(2), [
      "  `   │ a backtick",
    ]);
    const wide = `| One header | Two header | Three header | Notes |\n|---|---|---|---|\n| a | b | c | ${"word ".repeat(200)}|`;
    for (const width of [30, 50, 80])
      for (const line of renderMarkdown(wide, width)) assert.ok(visibleWidth(line) <= width);
  });

  it("lists a table's rows as header and value when its columns cannot fit", () => {
    const table =
      "| Name | Type | Default | Required | Since | Notes |\n|---|---|---|---|---|---|\n| width | number | 80 | no | 1.0 | the row width |";
    const rows = renderMarkdown(table, 30);
    for (const line of rows) assert.ok(visibleWidth(line) <= 30);
    assert.deepEqual(plain(rows).slice(0, 2), ["  Name: width", "  Type: number"]);
  });

  it("keeps a table in columns only while its words fit, header-only tables included", () => {
    const table =
      "| Approvals | Supports | Exploration |\n|---|---|---|\n| yes | approvals | exploration |";
    assert.deepEqual(text(table, 30).slice(0, 2), ["  Approvals: yes", "  Supports: approvals"]);
    assert.equal(text("| Only | Header |\n|---|---|", 40).length, 2);
  });
});

describe("Markdown code blocks", () => {
  it("finds the code blocks it shows, a block still open at the end among them", () => {
    const reply = "Run:\n\n```sh\npnpm test\n```\n\nThen:\n\n~~~ts\nconst x = 1;\nconst y = 2;";
    assert.deepEqual(codeBlocks(reply), [
      { code: "pnpm test", lang: "sh" },
      { code: "const x = 1;\nconst y = 2;", lang: "ts" },
    ]);
    assert.deepEqual(codeBlocks("Inline ```code``` is no block."), []);
  });
});
