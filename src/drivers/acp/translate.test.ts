import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AcpTranslator, approvalAction, throughGateway, toolItem } from "./translate.ts";

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

describe("1harness's own tools on an ACP agent", () => {
  const act = {
    toolCallId: "t1",
    name: "mcp_1harness_tool_act",
    title: "tool_act",
    kind: "other",
    status: "completed",
    rawInput: { name: "save_note", input: { text: "hello" } },
  };

  it("show as the tool that really runs, in items and approvals", () => {
    const item = toolItem(act as never);
    assert.ok(item.kind === "tool_call");
    assert.equal(item.tool, "save_note");
    assert.equal(item.server, "1harness");
    assert.equal(item.summary, '{"text":"hello"}');
    assert.deepEqual(approvalAction(act as never), {
      type: "tool",
      tool: "save_note",
      server: "1harness",
      input: { text: "hello" },
    });
    assert.equal(throughGateway(act as never), true);
  });

  it("name a search as itself, which is how it goes unasked", () => {
    const search = { ...act, name: "mcp_1harness_tool_search", rawInput: { query: "note" } };
    assert.deepEqual(approvalAction(search as never), {
      type: "tool",
      tool: "tool_search",
      server: "1harness",
      input: { query: "note" },
    });
    assert.equal(throughGateway(search as never), false);
  });

  it("leave other servers' tools as they were", () => {
    const other = { ...act, name: "mcp_docs_tool_act" };
    const item = toolItem(other as never);
    assert.ok(item.kind === "tool_call");
    assert.equal(item.tool, "mcp_docs_tool_act");
    assert.equal(item.server, null);
    assert.equal(item.summary, "tool_act");
    assert.equal(throughGateway(other as never), false);
  });
});
