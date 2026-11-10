import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Thread } from "../core/thread.ts";
import type { ToolContext, ToolDefinition } from "./api.ts";
import { ToolServer } from "./tool-server.ts";

describe("ToolServer", () => {
  it("serves tools over MCP to sessions that hold a grant", async () => {
    const calls: ToolContext[] = [];
    const echo: ToolDefinition = {
      name: "echo",
      description: "Repeats its text",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      readOnly: true,
      execute: (input, context) => {
        calls.push(context);
        if (input["text"] === "boom") throw new Error("exploded");
        return String(input["text"]);
      },
    };
    const server = new ToolServer(() => new Map([["echo", { tool: echo }]]), "1.0.0");
    const grant = await server.grant();
    assert.ok(grant && grant.config.type === "http");
    // The harness says which call this is in metadata only its driver reads; the thread
    // numbers it as its own items are numbered.
    const thread = {
      callId: (meta: Record<string, unknown>) => String(meta["call"] ?? "") || null,
    } as unknown as Thread;
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
      const malformed = await post(null);
      assert.equal((malformed.body as { error: { code: number } }).error.code, -32600);
      assert.equal((await post([])).status, 400);
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
        params: { name: "echo", arguments: { text: "hi" }, _meta: { call: "c1" } },
      });
      assert.deepEqual((call.body as { result: unknown }).result, {
        content: [{ type: "text", text: "hi" }],
      });
      assert.equal(calls[0]?.thread, thread, "the tool learns which thread called it");
      assert.equal(calls[0]?.callId, "c1", "and which of its calls it is");
      // A client that takes a stream gets one, so a long call keeps the connection busy.
      const streamed = await fetch(grant.config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...grant.config.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "streamed" } },
        }),
      });
      assert.equal(streamed.headers.get("content-type"), "text/event-stream");
      const event = /^event: message\ndata: (.+)\n\n$/.exec(await streamed.text());
      assert.deepEqual(JSON.parse(event?.[1] ?? "null"), {
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "streamed" }] },
      });
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

  it("closes while a streaming tool call is still pending", async () => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<string>();
    const tool: ToolDefinition = {
      name: "wait",
      description: "",
      inputSchema: {},
      execute: () => {
        started.resolve();
        return result.promise;
      },
    };
    const server = new ToolServer(() => new Map([[tool.name, { tool }]]), "test");
    const grant = await server.grant();
    assert.ok(grant && grant.config.type === "http");
    grant.bind({ callId: () => null } as unknown as Thread);
    const response = await fetch(grant.config.url, {
      method: "POST",
      headers: { ...grant.config.headers, Accept: "text/event-stream" },
      body: JSON.stringify({ id: 1, method: "tools/call", params: { name: tool.name } }),
    });
    const body = response.text().catch(() => "");
    await started.promise;
    const closed = server.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        closed.then(() => "closed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(resolve, 500, "still open");
        }),
      ]);
      assert.equal(outcome, "closed");
    } finally {
      clearTimeout(timer);
      result.resolve("done");
      await closed;
      await body;
    }
  });

  it("keeps disabled tools out of sessions' lists and calls, as settings stand each time", async () => {
    const echo: ToolDefinition = {
      name: "echo",
      description: "Repeats its text",
      inputSchema: { type: "object", properties: {} },
      execute: () => "said",
    };
    let off = new Set(["echo"]);
    const server = new ToolServer(
      () => new Map([["echo", { tool: echo }]]),
      "1.0.0",
      () => (name) => off.has(name),
    );
    assert.equal(await server.grant(), null);
    off = new Set();
    const grant = await server.grant();
    assert.ok(grant && grant.config.type === "http");
    grant.bind({ callId: () => null } as unknown as Thread);
    const { url, headers } = grant.config;
    const rpc = async (method: string, params: object = {}) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await response.json()) as {
        result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
        error?: { message: string };
      };
    };
    const call = () => rpc("tools/call", { name: "echo", arguments: {} });
    assert.deepEqual(
      (await rpc("tools/list")).result?.tools?.map((tool) => tool.name),
      ["echo"],
    );
    assert.equal((await call()).result?.content?.[0]?.text, "said");
    // A harness keeps the list it read, so it may still call what was just turned off.
    off = new Set(["echo"]);
    assert.deepEqual((await rpc("tools/list")).result?.tools, []);
    assert.match(JSON.stringify(await call()), /No tool named echo/);
    grant.revoke();
    await server.close();
  });
});
