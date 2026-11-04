import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadState } from "../protocol.ts";
import {
  contextRow,
  footerRows,
  retryHint,
  statusLine,
  type FooterState,
  type StatusLineState,
} from "./footer.ts";
import { plainText } from "./text.ts";

const current = {
  status: "idle",
  info: { runtimeMode: "supervised", effort: "high", interactionMode: "default" },
  usage: {
    inputTokens: 100,
    outputTokens: 10,
    contextTokens: 50,
    contextWindow: 200,
    costUsd: 0.42,
    cachedTokens: 50,
  },
} as unknown as ThreadState;

const state: StatusLineState = {
  exitArmed: false,
  toast: null,
  harness: "codex",
  folder: "parser-app · main",
  current,
  model: "gpt-6",
  runtimeMode: "supervised",
  server: null,
  scroll: 0,
  details: false,
};

const line = (width: number, more: Partial<StatusLineState> = {}) =>
  plainText(statusLine({ ...state, ...more }, width));

describe("the hint after a failed turn", () => {
  it("offers enter, after any wait the failure named", () => {
    assert.equal(retryHint(null, 80), "enter tries again · or type a message · / commands");
    assert.equal(
      retryHint(Date.now() - 1, 80),
      "enter tries again · or type a message · / commands",
    );
    assert.match(retryHint(Date.now() + 41_500, 80), /^wait 42s, then enter tries again · or/);
    assert.equal(retryHint(null, 30), "enter tries again");
  });
});

describe("the context row", () => {
  it("says what was asked, whole where it fits, and how much lies above", () => {
    assert.match(
      plainText(contextRow("fix the\nparser", 15, 50)),
      /^┃ fix the parser +↑ 15 more lines · pgup$/,
    );
  });

  it("gives up the question before the way back", () => {
    const row = plainText(contextRow("x".repeat(80), 1, 40));
    assert.match(row, /^┃ x+… +↑ 1 more line · pgup$/);
    assert.ok(row.length <= 40);
  });

  it("says only how much lies above when nothing was asked", () => {
    assert.match(plainText(contextRow(null, 2, 30)), /^ +↑ 2 more lines · pgup$/);
  });
});

describe("the status line", () => {
  it("shows all it knows where there is room", () => {
    assert.match(line(100), /supervised · codex · gpt-6 · high · ctx 25% · cache 50% · \$0\.42$/);
  });

  it("gives up what matters least first, and keeps the folder and mode to the narrowest pane", () => {
    assert.match(line(60), /^parser-app · main +supervised · codex · gpt-6 · ctx 25%$/);
    assert.match(line(40), /^parser-app · main +supervised · codex$/);
    assert.match(line(30), /^parser-app · main +supervised$/);
  });

  it("says how the turn ended when that is scrolled out of view", () => {
    assert.match(line(100, { scroll: 3, outcome: "✓ Done" }), /↓ 3 more lines to ✓ Done · pgdn/);
    assert.doesNotMatch(line(100, { outcome: "✓ Done" }), /Done/);
  });

  it("keeps the way back from details and a scroll beside the rest", () => {
    const shown = line(100, { scroll: 12, details: true });
    assert.match(shown, /↓ 12 more lines · pgdn {3}ctrl\+x hides details {3}supervised/);
    assert.match(shown, /^parser-app · main/);
  });
});

describe("the line that says another thread needs the user", () => {
  const editor = { layout: () => ({ rows: [""], cursor: { row: 0, column: 0 } }), empty: false };
  const shown = (request: FooterState["waiting"][number]["request"], width = 100) =>
    footerRows(
      {
        turn: null,
        running: false,
        blink: false,
        steer: false,
        queue: [],
        held: false,
        waiting: [{ threadId: "other", request }],
        threads: new Map([["other", { title: "Rebuild the site" } as unknown as ThreadState]]),
        prompt: null,
        panel: null,
        editor: editor as unknown as FooterState["editor"],
        busy: false,
        retry: null,
        suggestions: null,
        status: "",
      },
      width,
      30,
    )
      .rows.map((row) => plainText(row))
      .find((row) => row.includes("◆"));

  it("says what command it wants to run", () => {
    const banner = shown({
      kind: "approval",
      id: "ask",
      title: "Run?",
      detail: "",
      action: { type: "command", command: "rm -rf dist", cwd: null },
      options: [],
      defaultOptionId: "",
    });
    assert.match(
      banner ?? "",
      /◆ Another thread: Rebuild the site {2}wants to run rm -rf dist +ctrl\+o open$/,
    );
  });

  it("says only that it needs approval where there is no command to name", () => {
    const banner = shown({
      kind: "approval",
      id: "ask",
      title: "Edit?",
      detail: "",
      action: { type: "file_change", paths: ["a.ts"] },
      options: [],
      defaultOptionId: "",
    });
    assert.match(banner ?? "", /needs approval/);
  });

  it("keeps the command in view beside a long title", () => {
    const banner = shown(
      {
        kind: "approval",
        id: "ask",
        title: "Run?",
        detail: "",
        action: { type: "command", command: "rm -rf dist", cwd: null },
        options: [],
        defaultOptionId: "",
      },
      50,
    );
    assert.match(banner ?? "", /rm -rf dist/);
  });
});
