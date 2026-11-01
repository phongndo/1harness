import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { Message } from "../core/thread.ts";
import type { LogEntry } from "../protocol.ts";
import { formatElapsed, plainLine, type AgentRow } from "./agents.ts";
import { inline, renderMarkdown } from "./markdown.ts";
import { visibleWidth, wrap } from "./text.ts";
import { Transcript, renderBlock, type Block, type ToolItem } from "./transcript.ts";
import { ThreadView } from "./view.ts";

const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row));
const context = { width: 60, cwd: "/work", blink: true, now: 100_000 };

const row = (overrides: Partial<AgentRow>): AgentRow => ({
  threadId: "t2",
  callId: null,
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

const ran = (id: string, command: string): ToolItem => ({
  kind: "command",
  id,
  command,
  output: "",
  exitCode: 0,
  status: "completed",
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
    // A harness that does not say which call started an agent keeps the call's row too.
    const agent: AgentRow = {
      threadId: "t2",
      callId: null,
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

  it("shows an agent in place of the call that started it", () => {
    const view = new ThreadView("t1");
    const agent = { label: "codex" };
    view.startTurn();
    view.item(ran("c1", "ls"), true, true);
    view.item(delegate("d1"), false, true);
    view.item(delegate("d2"), false, true);
    view.agent(row({ ...agent, threadId: "t2", callId: "d1", title: "One" }));
    view.agent(row({ ...agent, threadId: "t3", callId: "d2", title: "Two" }));
    view.item({ ...delegate("d1"), status: "completed" }, true, true);
    // An agent can show before the call that started it.
    view.agent(row({ ...agent, threadId: "t4", callId: "d3", title: "Three" }));
    view.item(delegate("d3"), false, true);
    view.item(ran("c2", "git status"), true, true);
    assert.deepEqual(plain(view.transcript.view(context, 20, 0).rows), [
      "● Ran ls",
      "",
      "● 3 agents · 3 working",
      "├ t2 One  codex                               working 1m 05s",
      "├ t3 Two  codex                               working 1m 05s",
      "└ t4 Three  codex                             working 1m 05s",
      "",
      "● Ran git status",
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
      "● Stopped handing off a task",
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
      input: { text: "[1harness] Task t2 (codex: Fix) completed:\n\n**Fixed** it" },
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
    assert.ok(rows.every((text) => text.length <= 24));
    assert.deepEqual(rows.slice(2), ["  k   │ one two three", "      │ four five six"]);
  });
});

/** An edit of /work/a.ts. */
const editA = (id: string): ToolItem => ({
  kind: "file_change",
  id,
  changes: [{ path: "/work/a.ts", kind: "update", diff: "+a" }],
  status: "completed",
});

describe("tool group summaries", () => {
  it("counts files changed, not edits", () => {
    const rows = renderBlock(
      { kind: "tools", settled: true, items: [editA("e1"), editA("e2")] },
      context,
    );
    assert.equal(plain(rows)[0], "● Changed 1 file");
  });
});

describe("decisions", () => {
  it("records the choice made, and each question's answer", () => {
    const view = new ThreadView("t1");
    const at = 1;
    view.apply(
      {
        type: "decision",
        kind: "approval",
        title: "Run this command?",
        answer: "Yes",
        outcome: "allowed",
        at,
      },
      { busy: false, agent: () => null },
    );
    view.apply(
      {
        type: "decision",
        kind: "question",
        title: "Which greeting?",
        answer: "hello",
        outcome: "answered",
        at,
      },
      { busy: false, agent: () => null },
    );
    assert.deepEqual(plain(view.transcript.view(context, 10, 0).rows), [
      "✓ Run this command? → Yes",
      "",
      "◆ Which greeting? → hello",
    ]);
  });

  it("says a call asks to run while its approval is open", () => {
    const view = new ThreadView("t1");
    const command: ToolItem = {
      kind: "command",
      id: "c1",
      command: "rm -rf build",
      output: "",
      exitCode: null,
      status: "running",
    };
    view.item(command, false, true);
    view.awaiting([
      {
        kind: "approval",
        id: "a1",
        title: "Run this command?",
        detail: "$ rm -rf build",
        action: { type: "command", command: "rm -rf build", cwd: null },
        options: [],
        defaultOptionId: "",
      },
    ]);
    assert.deepEqual(plain(view.transcript.view(context, 10, 0).rows), [
      "● Asks to run rm -rf build",
    ]);
    view.awaiting([]);
    assert.deepEqual(plain(view.transcript.view(context, 10, 0).rows), ["● Running rm -rf build"]);
  });

  it("shows a call whole, with its output, in detail", () => {
    const transcript = new Transcript();
    transcript.add({
      kind: "tools",
      settled: true,
      items: [
        {
          kind: "command",
          id: "c1",
          command: "ls\nwc -l app.ts",
          output: "a.ts\nb.ts",
          exitCode: 0,
          status: "completed",
        },
      ],
    });
    assert.deepEqual(plain(transcript.view({ ...context, details: true }, 10, 0).rows), [
      "● Ran ls …",
      "  wc -l app.ts",
      "  a.ts",
      "  b.ts",
    ]);
  });
});

/** Markdown as plain rows. */
const text = (md: string, width = 60) => plain(renderMarkdown(md, width));

/** A running search call on `server`. */
const searchOn = (id: string, server: string): ToolItem => ({
  kind: "tool_call",
  id,
  tool: "search",
  server,
  category: "other",
  summary: "bug",
  output: "",
  status: "running",
});

describe("markdown edge cases", () => {
  it("keeps emphasis and links around code, and escapes literal", () => {
    assert.deepEqual(text("**`a.ts`** and [`b`](c) and \\*not\\* and *.ts or *.tsx"), [
      "  a.ts and b (c) and *not* and *.ts or *.tsx",
    ]);
  });

  it("keeps a heading's own #, and closes fences only on a bare marker", () => {
    assert.deepEqual(text("# Learn C#"), ["  Learn C#"]);
    const rows = text("```js const x = 1``` inline\n\n```\ncode\n```py\nmore\n```\nprose");
    assert.equal(rows[0], "  js const x = 1 inline");
    assert.ok(rows.includes("  ```py"), "an info string does not close a fence");
    assert.equal(rows.at(-1), "  prose");
  });

  it("keeps a lone backtick in its cell, and wide tables within the width", () => {
    assert.deepEqual(text("| Key | Meaning |\n|---|---|\n| ` | a backtick |").slice(2), [
      "  `   │ a backtick",
    ]);
    const wide = `| One header | Two header | Three header | Notes |\n|---|---|---|---|\n| a | b | c | ${"word ".repeat(200)}|`;
    for (const width of [30, 50, 80])
      for (const line of renderMarkdown(wide, width)) assert.ok(visibleWidth(line) <= width);
  });

  it("puts a long word under its bullet rather than leaving the bullet alone", () => {
    const rows = text(`- https://example.com/${"a".repeat(60)}`, 40);
    assert.match(rows[0] ?? "", /^ {2}• https:/);
  });
});

describe("outside text in rows", () => {
  it("keeps tool input and answers on their row", () => {
    const rows = plain(
      renderBlock(
        {
          kind: "tools",
          settled: true,
          items: [
            {
              kind: "tool_call",
              id: "t",
              tool: "create_issue",
              server: "linear",
              category: "other",
              summary: "Steps:\n1. open\tthe app",
              output: "",
              status: "completed",
            },
          ],
        },
        context,
      ),
    );
    assert.deepEqual(rows, ["● Called linear/create_issue Steps: 1. open    the app"]);
    const decision = plain(
      renderBlock(
        {
          kind: "decision",
          request: "question",
          title: "Which?\nA) keep",
          answer: "A",
          outcome: "answered",
        },
        context,
      ),
    );
    assert.deepEqual(decision, ["◆ Which? A) keep → A"]);
  });
});

describe("cut-off calls", () => {
  it("settles a call its turn cut off, even beside a command that goes on", () => {
    const view = new ThreadView("t1");
    view.startTurn(0);
    const command: ToolItem = {
      kind: "command",
      id: "c",
      command: "npm run dev",
      output: "",
      exitCode: null,
      status: "running",
    };
    const search: ToolItem = {
      kind: "tool_call",
      id: "s",
      tool: "search",
      server: "docs",
      category: "other",
      summary: "auth",
      output: "",
      status: "running",
    };
    view.item(command, false, true);
    view.item(search, false, true);
    view.endTurn("interrupted", null, { up: 0, down: 0, at: 1000 });
    const rows = plain(view.transcript.view(context, 10, 0).rows);
    assert.ok(
      rows.some((line) => line.includes("Stopped docs/search")),
      rows.join("\n"),
    );
    assert.equal(view.transcript.running, true, "the command still runs");
    view.item({ ...command, status: "completed", exitCode: 0 }, true, false);
    assert.equal(view.transcript.running, false);
  });

  it("marks only the server's call an approval is for", () => {
    const view = new ThreadView("t1");
    view.item(searchOn("g", "github"), false, true);
    view.item(searchOn("l", "linear"), false, true);
    view.awaiting([
      {
        kind: "approval",
        id: "a",
        title: "Allow linear · search?",
        detail: "",
        action: { type: "tool", tool: "search", server: "linear", input: {} },
        options: [],
        defaultOptionId: "",
      },
    ]);
    const rows = plain(view.transcript.view(context, 10, 0).rows);
    assert.ok(rows.some((line) => line.includes("Asks to use linear/search")));
    assert.ok(rows.some((line) => line.includes("Calling github/search")));
  });
});

describe("loading earlier turns", () => {
  const replay = { busy: false, agent: () => null };

  it("keeps the terminal's own lines in place, and the banner on top", () => {
    const old = new ThreadView("t1");
    old.local({ kind: "banner", title: "1harness", subtitle: "v0" });
    old.earlier("Earlier turns are above");
    const late: LogEntry = {
      type: "item",
      item: { kind: "assistant_message", id: "late", text: "late reply" },
      done: true,
    };
    old.apply(late, replay);
    old.say("info", "Renamed t1");
    const early: LogEntry = {
      type: "item",
      item: { kind: "assistant_message", id: "early", text: "early reply" },
      done: true,
    };
    const view = new ThreadView("t1");
    view.rebuild(old, [early, late], 1, replay, null);
    assert.deepEqual(plain(view.transcript.view(context, 20, 0).rows), [
      "1harness v0",
      "",
      "  early reply",
      "",
      "  late reply",
      "",
      "  Renamed t1",
    ]);
  });

  it("reads a turn across the pages' cut as one", () => {
    const entries: LogEntry[] = [
      { type: "turn.started", turnId: "u1", at: 0 },
      {
        type: "item",
        item: {
          kind: "tool_call",
          id: "r",
          tool: "Read",
          server: null,
          category: "read",
          summary: "a.ts",
          output: "",
          status: "running",
        },
        done: false,
      },
      {
        type: "turn.ended",
        turnId: "u1",
        status: "interrupted",
        error: null,
        at: 5000,
        up: 1,
        down: 2,
      },
    ];
    // The newest page alone starts mid-turn, and still settles what the turn cut off.
    const newest = new ThreadView("t1");
    newest.apply(entries[1]!, replay);
    newest.apply(entries[2]!, replay);
    assert.equal(newest.transcript.running, false);
    const view = new ThreadView("t1");
    view.rebuild(newest, entries, 1, replay, null);
    const rows = plain(view.transcript.view(context, 20, 0).rows);
    assert.ok(
      rows.some((line) => line.includes("Stopped read a.ts")),
      rows.join("\n"),
    );
    assert.ok(rows.includes("  Interrupted · 5s (↑1 ↓2)"), rows.join("\n"));
  });
});

/** A finished call of one of 1harness's own tools. */
const own = (tool: string, summary: string): ToolItem => ({
  kind: "tool_call",
  id: tool,
  tool,
  server: "1harness",
  category: "other",
  summary,
  output: "",
  status: "completed",
});

describe("1harness's own tools", () => {
  it("name the thread they act on, not their input", () => {
    const rows = plain(
      renderBlock(
        {
          kind: "tools",
          settled: true,
          items: [
            own("thread_read", '{"threadId":"t13","runs":1}'),
            own("orchestrator_capabilities", "{}"),
          ],
        },
        context,
      ),
    );
    assert.deepEqual(rows.slice(1), [
      "├ Read a thread t13",
      "└ Checked which harnesses can take tasks",
    ]);
  });
});

describe("markdown, round two", () => {
  it("keeps code spans as written, backslashes and all", () => {
    assert.deepEqual(text("`C:\\Users\\me` and `\\(\\d+\\)` and `a\\*b`"), [
      "  C:\\Users\\me and \\(\\d+\\) and a\\*b",
    ]);
  });

  it("leaves delimiters that do not open emphasis", () => {
    assert.deepEqual(
      text("a ** 2 + b ** 2, snake__case__name, [docs](https://a.com/__x__/y)", 90),
      ["  a ** 2 + b ** 2, snake__case__name, docs (https://a.com/__x__/y)"],
    );
  });

  it("lists a table's rows as header and value when its columns cannot fit", () => {
    const table =
      "| Name | Type | Default | Required | Since | Notes |\n|---|---|---|---|---|---|\n| width | number | 80 | no | 1.0 | the row width |";
    const rows = renderMarkdown(table, 30);
    for (const line of rows) assert.ok(visibleWidth(line) <= 30);
    assert.deepEqual(plain(rows).slice(0, 2), ["  Name: width", "  Type: number"]);
  });

  it("keeps a heading bold after bold inside it", () => {
    const [heading = ""] = renderMarkdown("## Use **foo** now", 40);
    // Bold closes after foo, and opens again for the rest.
    assert.ok(heading.includes("foo\u001b[22m\u001b[1m now"), JSON.stringify(heading));
  });
});

describe("rows that fit", () => {
  it("cuts headers and wraps wide characters within the width", () => {
    const narrow = { ...context, width: 12 };
    for (const block of [
      { kind: "plan", text: "do it" },
      { kind: "todos", steps: [{ text: "one", status: "pending" }] },
      { kind: "report", title: "A long report title", lines: [] },
    ] as Block[])
      for (const line of renderBlock(block, narrow)) assert.ok(visibleWidth(line) <= 12, line);
    assert.deepEqual(wrap("abc日", 4, "   "), ["abc", "日"]);
  });
});

describe("markdown, round three", () => {
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

  it("keeps a table in columns only while its words fit, header-only tables included", () => {
    const table =
      "| Approvals | Supports | Exploration |\n|---|---|---|\n| yes | approvals | exploration |";
    assert.deepEqual(text(table, 30).slice(0, 2), ["  Approvals: yes", "  Supports: approvals"]);
    assert.equal(text("| Only | Header |\n|---|---|", 40).length, 2);
  });
});

describe("diffs", () => {
  it("counts and shows a removed line that reads ---, past the header", () => {
    const change: ToolItem = {
      kind: "file_change",
      id: "e",
      changes: [
        {
          path: "/work/a.sql",
          kind: "update",
          diff: "--- a/a.sql\n+++ b/a.sql\n@@ -1,2 +1,2 @@\n--- drop the old table first\n+++counter;",
        },
      ],
      status: "completed",
    };
    const rows = plain(
      renderBlock({ kind: "tools", settled: true, items: [change] }, { ...context, details: true }),
    );
    assert.match(rows[0] ?? "", /\+1 \/ -1$/);
    assert.ok(rows.some((line) => line.includes("--- drop the old table first")));
  });
});

describe("reports", () => {
  it("keep the spaces that line their columns up", () => {
    const rows = plain(
      renderBlock(
        {
          kind: "report",
          title: "MCP servers",
          lines: [
            [
              { text: "github  ", tone: "text" },
              { text: "connected  ", tone: "good" },
              { text: "error:\nboom\there", tone: "bad" },
            ],
          ],
        },
        context,
      ),
    );
    assert.deepEqual(rows, ["● MCP servers", "  github  connected  error: boom    here"]);
  });
});
