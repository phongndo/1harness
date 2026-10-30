import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpTranslator, approvalAction, toolItem } from "./translate.ts";

describe("AcpTranslator", () => {
  it("streams each message as one item, ended when something else arrives", () => {
    const translator = new AcpTranslator();
    const chunk = (text: string, messageId: string) =>
      translator.translate({
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      });
    assert.deepEqual(chunk("Hel", "m1"), [
      {
        type: "item.started",
        item: { kind: "assistant_message", id: "acp-assistant_message-m1", text: "" },
      },
      { type: "item.delta", itemId: "acp-assistant_message-m1", chunk: "Hel" },
    ]);
    assert.deepEqual(chunk("lo", "m1"), [
      { type: "item.delta", itemId: "acp-assistant_message-m1", chunk: "lo" },
    ]);
    const events = translator.translate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "ls",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls -la" },
    });
    assert.deepEqual(events[0], {
      type: "item.completed",
      item: { kind: "assistant_message", id: "acp-assistant_message-m1", text: "Hello" },
    });
    assert.deepEqual(events[1], {
      type: "item.started",
      item: {
        kind: "command",
        id: "t1",
        command: "ls -la",
        output: "",
        exitCode: null,
        status: "running",
      },
    });
    const done = translator.translate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    });
    assert.deepEqual(done, [
      {
        type: "item.completed",
        item: {
          kind: "command",
          id: "t1",
          command: "ls -la",
          output: "a.txt",
          exitCode: null,
          status: "completed",
        },
      },
    ]);
  });

  it("maps plans and the agent's commands", () => {
    const translator = new AcpTranslator();
    assert.deepEqual(
      translator.translate({
        sessionUpdate: "plan",
        entries: [{ content: "write", status: "in_progress" }],
      }),
      [
        {
          type: "item.updated",
          item: {
            kind: "todo_list",
            id: "acp-plan",
            steps: [{ text: "write", status: "in_progress" }],
          },
        },
      ],
    );
    translator.translate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "review changes", input: { hint: "[target]" } },
      ],
    });
    assert.deepEqual(translator.commands, [
      {
        name: "review",
        aliases: [],
        description: "review changes",
        argumentHint: "[target]",
        kind: "command",
        startsTurn: true,
      },
    ]);
  });
});

describe("toolItem", () => {
  it("shows an edit as a diff, from the agent's texts or fx's edit input", () => {
    const fromDiff = toolItem({
      toolCallId: "e1",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "/w/a.txt", oldText: "one\n", newText: "two\n" }],
    });
    assert.deepEqual(fromDiff, {
      kind: "file_change",
      id: "e1",
      changes: [{ path: "/w/a.txt", kind: "update", diff: "@@ -1,1 +1,1 @@\n-one\n+two" }],
      status: "completed",
    });
    const fromInput = toolItem({
      toolCallId: "e2",
      kind: "edit",
      rawInput: { path: "notes.txt", old_string: "phase one", new_string: "phase two" },
    });
    assert.equal(
      fromInput.kind === "file_change" ? fromInput.changes[0]?.diff : "",
      "@@ -1,1 +1,1 @@\n-phase one\n+phase two",
    );
    assert.deepEqual(
      approvalAction({ toolCallId: "x", kind: "execute", rawInput: { command: "rm -rf build" } }),
      {
        type: "command",
        command: "rm -rf build",
        cwd: null,
      },
    );
  });
});
