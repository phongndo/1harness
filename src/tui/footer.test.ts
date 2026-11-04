import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadState } from "../protocol.ts";
import { statusLine, type StatusLineState } from "./footer.ts";
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

describe("the status line", () => {
  it("shows all it knows where there is room", () => {
    assert.match(line(100), /supervised · codex · gpt-6 · high · ctx 25% · cache 50% · \$0\.42$/);
  });

  it("gives up what matters least first, and keeps the folder and mode to the narrowest pane", () => {
    assert.match(line(60), /^parser-app · main +supervised · codex · gpt-6 · ctx 25%$/);
    assert.match(line(40), /^parser-app · main +supervised · codex$/);
    assert.match(line(30), /^parser-app · main +supervised$/);
  });

  it("keeps the way back from details and a scroll beside the rest", () => {
    const shown = line(100, { scroll: 12, details: true });
    assert.match(shown, /↓ 12 more lines · pgdn {3}details · ctrl\+x {3}supervised/);
    assert.match(shown, /^parser-app · main/);
  });
});
