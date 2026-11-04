import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkToolHook, gatewayCall, isGatewayName, ownToolCheck, toolAction } from "./tools.ts";

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

  it("show policies the tool that really runs", () => {
    const action = {
      type: "tool",
      tool: "thread_send",
      server: "1harness",
      input: { threadId: "t" },
    };
    const check = { tool: "mcp__1harness__thread_send", input: { threadId: "t" }, action };
    assert.deepEqual(
      ownToolCheck("tool_act", { name: "thread_send", input: { threadId: "t" } }),
      check,
    );
    assert.deepEqual(ownToolCheck("thread_send", { threadId: "t" }), check);
    assert.deepEqual(ownToolCheck("tool_search", { query: "x" }), {
      tool: "mcp__1harness__tool_search",
      input: { query: "x" },
      action: { type: "tool", tool: "tool_search", server: "1harness", input: { query: "x" } },
    });
  });
});

const hook = (tool_name: string, tool_input: unknown) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});

describe("checkToolHook", () => {
  it("leaves 1harness's own tools to its tool server", async () => {
    const seen: unknown[] = [];
    const policy = async (call: unknown) => {
      seen.push(call);
      return "no";
    };
    assert.deepEqual(await checkToolHook(policy, hook("mcp__1harness__delegate_task", {})), {});
    assert.deepEqual(
      await checkToolHook(policy, hook("mcp__1harness__tool_act", { name: "thread_send" })),
      {},
    );
    assert.deepEqual(seen, []);
  });

  it("blocks every other tool as the policy says", async () => {
    const seen: unknown[] = [];
    const check = (name: string, input: unknown) =>
      checkToolHook(
        async (call) => {
          seen.push(call);
          return "no";
        },
        hook(name, input),
      );
    const output = await check("Bash", { command: "ls" });
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput?.permissionDecisionReason, "no");
    assert.equal(
      (await check("mcp__docs__tool_act", { name: "x" })).hookSpecificOutput?.permissionDecision,
      "deny",
    );
    assert.deepEqual(seen, [
      {
        tool: "Bash",
        input: { command: "ls" },
        action: { type: "command", command: "ls", cwd: null },
      },
      {
        tool: "mcp__docs__tool_act",
        input: { name: "x" },
        action: { type: "tool", tool: "tool_act", server: "docs", input: { name: "x" } },
      },
    ]);
  });
});
