import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessEvent } from "../core/events.ts";
import { SessionEvents } from "./session-events.ts";

async function drain(events: SessionEvents): Promise<HarnessEvent[]> {
  const seen: HarnessEvent[] = [];
  for await (const event of events.stream) seen.push(event);
  return seen;
}

describe("SessionEvents", () => {
  it("ends what a session left open when it dies", async () => {
    const events = new SessionEvents("test");
    events.emit(
      { type: "turn.started", turnId: "t1" },
      {
        type: "item.started",
        item: {
          kind: "command",
          id: "c1",
          command: "ls",
          output: "",
          exitCode: null,
          status: "running",
        },
      },
      { type: "item.delta", itemId: "c1", chunk: "a.txt" },
      { type: "item.started", item: { kind: "assistant_message", id: "m1", text: "" } },
      { type: "item.completed", item: { kind: "assistant_message", id: "m1", text: "Hi" } },
      {
        type: "request.opened",
        request: { kind: "question", id: "q1", questions: [] },
      },
      {
        type: "request.opened",
        request: { kind: "question", id: "q2", questions: [] },
      },
      { type: "request.resolved", requestId: "q2" },
    );
    events.close("t1", "it crashed", false);
    events.close("t1", "again", false);
    const seen = await drain(events);
    assert.deepEqual(seen.slice(8), [
      // A client would otherwise keep asking a question nothing will answer.
      { type: "request.resolved", requestId: "q1" },
      {
        type: "item.completed",
        item: {
          kind: "command",
          id: "c1",
          command: "ls",
          output: "a.txt",
          exitCode: null,
          status: "failed",
        },
      },
      { type: "turn.ended", turnId: "t1", status: "failed", error: "it crashed" },
      { type: "session.closed", error: "it crashed" },
    ]);
  });

  it("ends the turn as interrupted when closed on purpose", async () => {
    const events = new SessionEvents("test");
    events.close("t1", "closed", true);
    assert.deepEqual(await drain(events), [
      { type: "turn.ended", turnId: "t1", status: "interrupted", error: null },
      { type: "session.closed", error: null },
    ]);
  });
});
