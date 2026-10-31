import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { Message } from "../core/thread.ts";
import { formatElapsed, plainLine, type AgentRow } from "./agents.ts";
import { renderMarkdown } from "./markdown.ts";
import { Transcript, renderBlock, type ToolItem } from "./transcript.ts";
import { ThreadView } from "./view.ts";

const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row));
const context = { width: 60, cwd: "/work", blink: true, now: 100_000 };

const row = (overrides: Partial<AgentRow>): AgentRow => ({
  threadId: "t2",
  label: "claude · haiku",
  title: "Review the parser",
  status: "working",
  startedAt: 35_000,
  endedAt: null,
  detail: "",
  ...overrides,
});

/** A harness's echo of message `id`. */
const echo = (id: string, text: string) =>
  ({ kind: "user_message", id, text, inputId: id }) as const;

const delegate = (id: string): ToolItem => ({
  kind: "tool_call",
  id,
  tool: "delegate_task",
  server: "1harness",
  category: "other",
  summary: "",
  output: "",
  status: "running",
});

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

  it("sums the group up in a sentence over a tree of past-tense rows", () => {
    const rows = renderBlock({ kind: "tools", items, settled: true }, { ...context, width: 80 });
    assert.deepEqual(plain(rows), [
      "● Changed 1 file, ran 1 command, and performed 1 other action",
      "├ Ran ls -la && echo done",
      "├ Read notes.txt",
      "└ Edited notes.txt +2 / -1",
    ]);
  });

  it("shows a lone call as one row, in the present tense while it runs", () => {
    const running: ToolItem = { ...items[0]!, status: "running", exitCode: null } as ToolItem;
    const block = { kind: "tools" as const, items: [running], settled: false };
    assert.deepEqual(plain(renderBlock(block, { ...context, blink: false })), [
      "  Running ls -la && echo done",
    ]);
    assert.deepEqual(plain(renderBlock({ ...block, settled: true }, context)), [
      "● Stopped ls -la && echo done",
    ]);
  });

  it("reports failures and exit codes", () => {
    const failed: ToolItem[] = [
      { ...items[0], exitCode: 2, status: "failed" } as ToolItem,
      { ...items[1], status: "failed", output: "\nno such file\n" } as ToolItem,
    ];
    assert.deepEqual(plain(renderBlock({ kind: "tools", items: failed, settled: true }, context)), [
      "● Ran 1 command and read 1 file · 2 failed",
      "├ Ran ls -la && echo done · exit 2",
      "└ Failed read notes.txt: no such file",
    ]);
  });
});

describe("agents", () => {
  it("shows one agent with its status and timer", () => {
    assert.deepEqual(plain(renderBlock({ kind: "agents", rows: [row({})] }, context)), [
      "● t2 Review the parser  claude · haiku        working 1m 05s",
    ]);
  });

  it("groups agents a turn started under a count of their states", () => {
    const rows = [
      row({ status: "done", endedAt: 57_000, detail: "Found 3 issues" }),
      row({
        threadId: "t3",
        label: "codex",
        title: "Write the tests",
        status: "needs you",
        detail: "Needs approval · ctrl+o to answer",
      }),
    ];
    assert.deepEqual(plain(renderBlock({ kind: "agents", rows }, context)), [
      "● 2 agents · 1 needs you · 1 done",
      "├ t2 Review the parser  claude · haiku              done 22s",
      "│ Found 3 issues",
      "└ t3 Write the tests  codex                 needs you 1m 05s",
      "  Needs approval · ctrl+o to answer",
    ]);
  });

  it("keeps who an agent is when its status does not fit", () => {
    const rows = renderBlock(
      { kind: "agents", rows: [row({ status: "needs you" })] },
      {
        ...context,
        width: 17,
      },
    );
    assert.deepEqual(plain(rows), ["◆ t2 Review the …"]);
  });

  it("previews a reply as the transcript reads it, code spans whole", () => {
    assert.equal(
      plainLine("\n## Fixed `__init__.py` and **the** [docs](https://x.y)"),
      "Fixed __init__.py and the docs (https://x.y)",
    );
  });

  it("formats timers with padded seconds and minutes", () => {
    assert.deepEqual(
      [formatElapsed(9_400), formatElapsed(65_000), formatElapsed(3_720_000)],
      ["9s", "1m 05s", "1h 02m"],
    );
  });
});

describe("ThreadView", () => {
  it("groups agents started one after another", () => {
    const view = new ThreadView("t1");
    const agent: AgentRow = {
      threadId: "t2",
      label: "claude",
      title: "One",
      status: "working",
      startedAt: 90_000,
      endedAt: null,
      detail: "",
    };
    view.item(delegate("d1"), false, true);
    view.item(delegate("d2"), false, true);
    view.agent(agent);
    view.agent({ ...agent, threadId: "t3", title: "Two" });
    view.agent({ ...agent, status: "done", endedAt: 95_000 });
    // An agent at work is not a tool running.
    view.item({ ...delegate("d1"), status: "completed" }, true, true);
    view.item({ ...delegate("d2"), status: "completed" }, true, true);
    assert.equal(view.transcript.animating, true);
    assert.equal(view.transcript.running, false);
    assert.deepEqual(plain(view.transcript.view(context, 10, 0).rows).slice(-3), [
      "● 2 agents · 1 working · 1 done",
      "├ t2 One  claude                                     done 5s",
      "└ t3 Two  claude                                 working 10s",
    ]);
  });

  it("settles calls a stopped turn cut off, but not commands still running", () => {
    const view = new ThreadView("t1");
    view.startTurn();
    view.item(delegate("d1"), false, true);
    view.item({ kind: "assistant_message", id: "a1", text: "Starting the server" }, true, true);
    view.item(
      {
        kind: "command",
        id: "c1",
        command: "npm run dev",
        output: "",
        exitCode: null,
        status: "running",
      },
      false,
      true,
    );
    view.endTurn("interrupted", null);
    assert.equal(view.transcript.running, true);
    assert.deepEqual(plain(view.transcript.view(context, 10, 0).rows).slice(0, 5), [
      "● Stopped 1harness/delegate_task",
      "",
      "  Starting the server",
      "",
      "● Running npm run dev",
    ]);
  });

  it("shows a brief as its task and a report as a result, by who sent them", () => {
    const view = new ThreadView("t1");
    const brief: Message = {
      id: "m1",
      input: { text: "You are doing a task for another agent.\n\nFix the parser" },
      origin: { type: "task", from: "t1", task: "Fix the parser" },
    };
    const report: Message = {
      id: "m2",
      input: { text: "[1harness] Task task-1 (codex: Fix) completed:\n\n**Fixed** it" },
      origin: { type: "report", from: "t2", status: "completed", result: "**Fixed** it\n\nMore." },
    };
    view.item(echo("m1", brief.input.text), true, true, brief);
    view.item(echo("m2", report.input.text), true, true, report);
    // A harness that cannot say which message it echoes shows the text it got.
    view.item({ kind: "user_message", id: "u3", text: "from history" }, true, true);
    assert.deepEqual(plain(view.transcript.view({ ...context, width: 48 }, 20, 0).rows), [
      "┃ Task from t1",
      "┃ Fix the parser",
      "",
      "● Result from t2 · done",
      "  Fixed it",
      "",
      "┃ from history",
    ]);
  });

  it("counts the files an edit changed", () => {
    const view = new ThreadView("t1");
    view.item(
      {
        kind: "file_change",
        id: "e",
        changes: [
          { path: "/work/a.ts", kind: "update", diff: "+a" },
          { path: "/work/b.ts", kind: "update", diff: "+b" },
        ],
        status: "completed",
      },
      true,
      true,
    );
    view.item(
      { kind: "command", id: "c", command: "ls", output: "", exitCode: 0, status: "completed" },
      true,
      true,
    );
    assert.equal(
      plain(view.transcript.view(context, 10, 0).rows)[0],
      "● Changed 2 files and ran 1 command",
    );
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
