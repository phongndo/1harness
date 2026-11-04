import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadState } from "../protocol.ts";
import { footerRows, statusLine, type FooterState, type StatusLineState } from "./footer.ts";
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
  above: 0,
  details: false,
};

const line = (width: number, more: Partial<StatusLineState> = {}) =>
  plainText(statusLine({ ...state, ...more }, width));

describe("the status line", () => {
  it("shows all it knows where there is room", () => {
    assert.match(line(100), /supervised · codex · gpt-6 · high · ctx 25% · cache 50% · \$0\.42$/);
  });

  it("gives up what matters least first, and keeps the folder and mode to the narrowest pane", () => {
    assert.match(line(60), /^parser-app · main +supervised · codex · gpt-6 · ctx 25%$/);
    assert.match(line(40), /^parser-app · main +supervised · codex$/);
    assert.match(line(30), /^parser-app · main +supervised$/);
  });

  it("says when more of the transcript lies above the view", () => {
    assert.match(line(100, { above: 19 }), /↑ 19 more lines · pgup/);
    assert.match(
      line(60, { above: 19 }),
      /^parser-app · main +↑ 19 more lines · pgup {3}supervised$/,
    );
    assert.match(line(40, { above: 19 }), /^parser-app · main +supervised$/);
  });

  it("keeps the way back from details and a scroll beside the rest", () => {
    const shown = line(100, { scroll: 12, details: true });
    assert.match(shown, /↓ 12 more lines · pgdn {3}details · ctrl\+x {3}supervised/);
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
