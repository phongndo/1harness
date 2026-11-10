import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpReply, type McpEndpoint } from "./mcp.ts";

const endpoint: McpEndpoint = {
  version: "test",
  instructions: "",
  tools: () => [
    { name: "echo", description: "", inputSchema: {}, effect: "read", callers: ["user"] },
  ],
  call: (_name, input) => input,
};

describe("mcpReply", () => {
  it("answers malformed messages as invalid requests", async () => {
    for (const value of [
      null,
      [],
      42,
      "text",
      {},
      { id: {}, method: "ping" },
      { id: 1, method: 2 },
    ]) {
      const reply = await mcpReply(value as never, endpoint);
      assert.equal((reply as { error: { code: number } }).error.code, -32600);
    }
  });

  it("rejects non-object parameters and tool arguments before calling a tool", async () => {
    let calls = 0;
    const own = {
      ...endpoint,
      call: () => {
        calls++;
      },
    };
    for (const params of [
      [],
      "bad",
      { name: "echo", arguments: [] },
      { name: "echo", arguments: 4 },
    ]) {
      const reply = await mcpReply({ id: 1, method: "tools/call", params: params as never }, own);
      assert.equal((reply as { error: { code: number } }).error.code, -32602);
    }
    assert.equal(calls, 0);
  });

  it("reports endpoint failures as protocol errors", async () => {
    const own = {
      ...endpoint,
      tools: () => {
        throw new Error("list failed");
      },
    };
    const reply = await mcpReply({ id: 1, method: "tools/list" }, own);
    assert.deepEqual(reply, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "list failed" },
    });
  });

  it("keeps valid notifications silent and accepts zero as a request ID", async () => {
    assert.equal(await mcpReply({ method: "notifications/initialized" }, endpoint), null);
    assert.deepEqual(await mcpReply({ id: 0, method: "ping" }, endpoint), {
      jsonrpc: "2.0",
      id: 0,
      result: {},
    });
  });
});
