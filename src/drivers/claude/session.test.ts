import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "../../core/events.ts";
import { ClaudeSession } from "./session.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-claude-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** A query that takes prompts and never answers them. */
const silent = (({ prompt }: { prompt: AsyncIterable<unknown> }) =>
  Object.assign(
    (async function* () {
      for await (const _ of prompt);
      yield* [];
    })(),
    { close() {}, interrupt: async () => {} },
  )) as unknown as typeof query;

describe("ClaudeSession", () => {
  it("starts no turn, and asks for no answer, when an attached image is missing", async () => {
    const session = new ClaudeSession({
      cwd: root,
      model: null,
      effort: null,
      runtimeMode: "supervised",
      interactionMode: "default",
      resume: null,
      executable: "claude",
      query: silent,
    });
    const events: HarnessEvent[] = [];
    const ended = (async () => {
      for await (const event of session.events) events.push(event);
    })();
    await session.start();
    const missing = { text: "look", images: [join(root, "missing.png")] };
    await assert.rejects(session.startTurn(missing), /ENOENT/);
    assert.equal(events.filter((event) => event.type === "turn.started").length, 0);
    await session.startTurn({ text: "go" });
    await assert.rejects(session.steer(missing), /ENOENT/);
    assert.equal(
      events.filter(
        (event) => event.type === "item.completed" && event.item.kind === "user_message",
      ).length,
      1,
    );
    await session.close();
    await ended;
  });
});
