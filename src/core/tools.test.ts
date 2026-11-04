import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkToolHook, gatewayCall, isGatewayName, toolAction } from "./tools.ts";

describe("calls through the gateway", () => {
  it("name the tool they reach, however the input was sent", () => {
    assert.deepEqual(
      gatewayCall("1harness", "tool_act", { name: "thread_send", input: { a: 1 } }),
      {
        tool: "thread_send",
        input: { a: 1 },
      },
    );
    assert.deepEqual(gatewayCall("1harness", "tool_read", { name: "thread_list" }), {
      tool: "thread_list",
      input: {},
    });
    assert.deepEqual(gatewayCall("1harness", "tool_read", { name: "t", input: '{"a":1}' }), {
      tool: "t",
      input: { a: 1 },
    });
  });

  it("are told apart from every other call", () => {
    assert.equal(gatewayCall("docs", "tool_act", { name: "x" }), null);
    assert.equal(gatewayCall("1harness", "delegate_task", { name: "x" }), null);
    assert.equal(gatewayCall("1harness", "tool_search", { name: "x" }), null);
    assert.equal(gatewayCall(null, "tool_act", { name: "x" }), null);
    // Its name still streaming in: the gateway's own name stands until it comes.
    assert.equal(gatewayCall("1harness", "tool_act", {}), null);
    assert.equal(isGatewayName("1harness_tool_act"), true);
    assert.equal(isGatewayName("mcp__1harness__tool_read"), true);
    assert.equal(isGatewayName("1harness_tool_search"), false);
    assert.equal(isGatewayName("mytool_act"), false);
  });

  it("show approvals the tool that really runs", () => {
    assert.deepEqual(
      toolAction("mcp__1harness__tool_act", { name: "thread_send", input: { threadId: "t" } }),
      { type: "tool", tool: "thread_send", server: "1harness", input: { threadId: "t" } },
    );
    assert.deepEqual(toolAction("mcp__docs__tool_act", { name: "x" }), {
      type: "tool",
      tool: "tool_act",
      server: "docs",
      input: { name: "x" },
    });
  });

  it("show policies the tool that really runs, which can block it", async () => {
    const seen: unknown[] = [];
    const output = await checkToolHook(
      async (call) => {
        seen.push([call.tool, call.input, call.action]);
        return call.action.type === "tool" && call.action.tool === "thread_send" ? "no" : undefined;
      },
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__1harness__tool_act",
        tool_input: { name: "thread_send", input: { threadId: "t" } },
      },
    );
    assert.deepEqual(seen, [
      [
        "mcp__1harness__thread_send",
        { threadId: "t" },
        { type: "tool", tool: "thread_send", server: "1harness", input: { threadId: "t" } },
      ],
    ]);
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput?.permissionDecisionReason, "no");
  });
});
