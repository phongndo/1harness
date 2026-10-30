import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Thread } from "../core/thread.ts";
import type { ToolDefinition } from "./api.ts";
import { ToolServer } from "./tool-server.ts";

describe("ToolServer", () => {
  it("serves tools over MCP to sessions that hold a grant", async () => {
    const calls: unknown[] = [];
    const echo: ToolDefinition = {
      name: "echo",
      description: "Repeats its text",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      readOnly: true,
      execute: (input, context) => {
        calls.push(context.thread);
        if (input["text"] === "boom") throw new Error("exploded");
        return String(input["text"]);
      },
    };
    const server = new ToolServer(() => new Map([["echo", { tool: echo }]]), "1.0.0");
    const grant = await server.grant();
    assert.ok(grant && grant.config.type === "http");
    const thread = {} as Thread;
    grant.bind(thread);
    const post = async (
      body: unknown,
      headers = grant.config.type === "http" ? grant.config.headers : {},
    ) => {
      const response = await fetch(grant.config.type === "http" ? grant.config.url : "", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : null,
      };
    };
    try {
      const init = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      assert.equal(
        (init.body as { result: { protocolVersion: string } }).result.protocolVersion,
        "2025-03-26",
      );
      assert.equal(
        (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status,
        202,
      );
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      assert.deepEqual((list.body as { result: { tools: unknown[] } }).result.tools, [
        {
          name: "echo",
          description: "Repeats its text",
          inputSchema: echo.inputSchema,
          annotations: { readOnlyHint: true },
        },
      ]);
      const call = await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      });
      assert.deepEqual((call.body as { result: unknown }).result, {
        content: [{ type: "text", text: "hi" }],
      });
      assert.equal(calls[0], thread, "the tool learns which thread called it");
      const failed = await post({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "boom" } },
      });
      assert.deepEqual((failed.body as { result: unknown }).result, {
        content: [{ type: "text", text: "exploded" }],
        isError: true,
      });
      assert.equal(
        (await post({ jsonrpc: "2.0", id: 5, method: "ping" }, { Authorization: "Bearer wrong" }))
          .status,
        401,
      );
      grant.revoke();
      assert.equal((await post({ jsonrpc: "2.0", id: 6, method: "ping" })).status, 401);
    } finally {
      await server.close();
    }
  });

  it("offers nothing when no extension has a tool", async () => {
    assert.equal(await new ToolServer(() => new Map(), "1").grant(), null);
  });
});
