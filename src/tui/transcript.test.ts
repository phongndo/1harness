import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import { renderMarkdown } from "./markdown.ts";
import { Transcript, renderBlock, type ToolItem } from "./transcript.ts";

const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row));
const context = { width: 60, cwd: "/work", blink: true };

describe("Transcript", () => {
  it("separates blocks with blank rows and views the bottom", () => {
    const transcript = new Transcript();
    transcript.add({ kind: "user", text: "one" });
    transcript.add({ kind: "assistant", text: "two\n\nthree" });
    transcript.add({ kind: "summary", text: "1s (↑1 ↓2)" });
    const all = transcript.view(context, 100, 0);
    assert.deepEqual(plain(all.rows), ["┃ one", "", "  two", "", "  three", "", "  1s (↑1 ↓2)"]);
    assert.equal(all.total, 7);
    assert.deepEqual(plain(transcript.view(context, 3, 0).rows), ["  three", "", "  1s (↑1 ↓2)"]);
    assert.deepEqual(plain(transcript.view(context, 3, 2).rows), ["  two", "", "  three"]);
  });

  it("re-renders a block only after it is touched", () => {
    const transcript = new Transcript();
    const block = transcript.add({ kind: "assistant", text: "draft" });
    assert.deepEqual(plain(transcript.view(context, 10, 0).rows), ["  draft"]);
    block.text = "final";
    assert.deepEqual(plain(transcript.view(context, 10, 0).rows), ["  draft"]);
    transcript.touch(block);
    assert.deepEqual(plain(transcript.view(context, 10, 0).rows), ["  final"]);
  });

  it("skips empty blocks without leaving gaps", () => {
    const transcript = new Transcript();
    transcript.add({ kind: "user", text: "hi" });
    transcript.add({ kind: "assistant", text: "  " });
    transcript.add({ kind: "summary", text: "done" });
    assert.deepEqual(plain(transcript.view(context, 10, 0).rows), ["┃ hi", "", "  done"]);
  });
});

describe("tool groups", () => {
  const items: ToolItem[] = [
    {
      kind: "command",
      id: "1",
      command: "ls -la && echo done",
      output: "",
      exitCode: 0,
      status: "completed",
    },
    {
      kind: "tool_call",
      id: "2",
      tool: "Read",
      server: null,
      category: "read",
      summary: "/work/notes.txt",
      output: "",
      status: "completed",
    },
    {
      kind: "file_change",
      id: "3",
      changes: [{ path: "/work/notes.txt", kind: "update", diff: "-one\n+two\n+three" }],
      status: "completed",
    },
  ];

  it("summarizes the group and draws a tree of past-tense rows", () => {
    const rows = renderBlock({ kind: "tools", items, settled: true }, context);
    assert.deepEqual(plain(rows), [
      "● 3 tool calls · 1 read · 1 edit · 1 command",
      "├ Ran ls -la && echo done",
      "├ Read notes.txt",
      "└ Edited notes.txt +2 / -1",
    ]);
  });

  it("uses the present tense while running and blinks the marker", () => {
    const running: ToolItem = { ...items[0]!, status: "running", exitCode: null } as ToolItem;
    const block = { kind: "tools" as const, items: [running], settled: false };
    assert.deepEqual(plain(renderBlock(block, { ...context, blink: false })), [
      "  1 tool call · 1 command",
      "└ Running ls -la && echo done",
    ]);
    assert.equal(
      plain(renderBlock({ ...block, settled: true }, context))[1],
      "└ Stopped ls -la && echo done",
    );
  });

  it("reports failures and exit codes", () => {
    const failed: ToolItem[] = [
      { ...items[0], exitCode: 2, status: "failed" } as ToolItem,
      { ...items[1], status: "failed", output: "\nno such file\n" } as ToolItem,
    ];
    assert.deepEqual(plain(renderBlock({ kind: "tools", items: failed, settled: true }, context)), [
      "● 2 tool calls · 1 read · 1 command · 2 failed",
      "├ Ran ls -la && echo done · exit 2",
      "└ Failed read notes.txt: no such file",
    ]);
  });
});

describe("renderMarkdown", () => {
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
});
