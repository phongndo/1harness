import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { ToolCallCheck, ToolPolicy } from "../core/events.ts";
import type { Thread } from "../core/thread.ts";
import { checkToolHook } from "../core/tools.ts";
import type { ToolContext, ToolDefinition } from "./api.ts";
import { ToolServer } from "./tool-server.ts";

const calls: [string, Record<string, unknown>, ToolContext][] = [];

function tool(name: string, options: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `Does ${name}. And more besides.`,
    inputSchema: { type: "object", properties: { x: { type: "number" } } },
    execute: (input, context) => {
      calls.push([name, input, context]);
      return `ran ${name}`;
    },
    ...options,
  };
}

const servers: ToolServer[] = [];

after(async () => {
  for (const server of servers) await server.close();
});

async function serve(
  tools: ToolDefinition[],
  options: {
    gateway?: () => boolean;
    off?: () => (name: string) => boolean;
    policy?: ToolPolicy;
  } = {},
) {
  const server = new ToolServer(
    () => new Map(tools.map((entry) => [entry.name, { tool: entry }])),
    "1",
    options.off,
    options.gateway ?? (() => true),
  );
  servers.push(server);
  const grant = await server.grant(undefined, () => options.policy);
  assert.ok(grant && grant.config.type === "http");
  const thread = { callId: () => "call-1" } as unknown as Thread;
  grant.bind(thread);
  const { url, headers } = grant.config;
  const rpc = async (method: string, params: object = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as {
      result?: {
        tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
        content?: { text: string }[];
        isError?: boolean;
      };
      error?: { message: string };
    };
  };
  return {
    thread,
    names: async () => (await rpc("tools/list")).result?.tools?.map((entry) => entry.name),
    list: async () => (await rpc("tools/list")).result?.tools ?? [],
    call: async (name: string, input: object) => {
      const reply = await rpc("tools/call", { name, arguments: input });
      return {
        text: reply.result?.content?.[0]?.text ?? reply.error?.message ?? "",
        isError: reply.result?.isError === true || reply.error !== undefined,
      };
    },
  };
}

const TOOLS = [
  tool("thread_read", { readOnly: true, description: "Reads a thread's runs. Long ones too." }),
  tool("thread_send", { description: "Sends a message to a thread." }),
  tool("delegate_task", { direct: true }),
];

describe("the tool gateway", () => {
  it("lists only direct tools and its own, naming the rest in its search's description", async () => {
    const { names, list } = await serve(TOOLS);
    assert.deepEqual((await names())?.toSorted(), [
      "delegate_task",
      "tool_act",
      "tool_read",
      "tool_search",
    ]);
    const tools = await list();
    const hinted = (name: string) =>
      tools.find((entry) => entry.name === name)?.annotations?.readOnlyHint === true;
    assert.equal(hinted("tool_search"), true);
    assert.equal(hinted("tool_read"), true);
    assert.equal(hinted("tool_act"), false);
    const search = tools.find((entry) => entry.name === "tool_search") as unknown as {
      description: string;
    };
    assert.match(search.description, /thread_read, thread_send\.$/);
  });

  it("offers every tool by name when turned off, or when nothing would be hidden", async () => {
    const off = await serve(TOOLS, { gateway: () => false });
    assert.deepEqual((await off.names())?.toSorted(), [
      "delegate_task",
      "thread_read",
      "thread_send",
    ]);
    const direct = await serve([tool("delegate_task", { direct: true })]);
    assert.deepEqual(await direct.names(), ["delegate_task"]);
  });

  it("finds tools with their schemas and how to call them", async () => {
    const { call } = await serve(TOOLS);
    const found = JSON.parse((await call("tool_search", { query: "send a message" })).text) as {
      name: string;
      inputSchema: unknown;
      callWith: string;
    }[];
    assert.equal(found[0]?.name, "thread_send");
    assert.equal(found[0]?.callWith, "tool_act");
    assert.deepEqual(found[0]?.inputSchema, TOOLS[1]?.inputSchema);

    const read = JSON.parse((await call("tool_search", { query: "thread_read" })).text) as {
      name: string;
      callWith: string;
    }[];
    assert.equal(read[0]?.name, "thread_read");
    assert.equal(read[0]?.callWith, "tool_read");
  });

  it("lists every hidden tool without schemas for an empty query, and on no match", async () => {
    const { call } = await serve(TOOLS);
    const all = JSON.parse((await call("tool_search", {})).text) as Record<string, unknown>[];
    assert.deepEqual(
      all.map((entry) => entry["name"]),
      ["thread_read", "thread_send"],
    );
    assert.equal(all[0]?.["description"], "Reads a thread's runs.");
    assert.equal("inputSchema" in (all[0] ?? {}), false);
    const none = JSON.parse((await call("tool_search", { query: "zebra" })).text) as {
      found: unknown[];
      tools: string[];
    };
    assert.deepEqual(none, { found: [], tools: ["thread_read", "thread_send"] });
  });

  it("calls a tool as the session's agent, with its call's ID", async () => {
    const { call, thread } = await serve(TOOLS);
    calls.length = 0;
    const result = await call("tool_act", { name: "thread_send", input: { x: 1 } });
    assert.deepEqual(result, { text: "ran thread_send", isError: false });
    assert.equal(calls[0]?.[0], "thread_send");
    assert.deepEqual(calls[0]?.[1], { x: 1 });
    assert.equal(calls[0]?.[2].thread, thread);
    assert.equal(calls[0]?.[2].callId, "call-1");
    assert.equal((await call("tool_read", { name: "thread_read" })).text, "ran thread_read");
    // Some models write the arguments as a JSON string.
    await call("tool_act", { name: "thread_send", input: '{"x":2}' });
    assert.deepEqual(calls.at(-1)?.[1], { x: 2 });
  });

  it("will not run a change through tool_read, whose hint lets it skip approval", async () => {
    const { call } = await serve(TOOLS);
    calls.length = 0;
    const result = await call("tool_read", { name: "thread_send", input: {} });
    assert.equal(result.isError, true);
    assert.match(result.text, /changes things, so it goes through tool_act/);
    assert.equal(calls.length, 0);
  });

  it("refuses what it does not offer: an unknown tool, and a disabled one", async () => {
    let disabled = new Set<string>();
    const { call, names } = await serve(TOOLS, { off: () => (name) => disabled.has(name) });
    const unknown = await call("tool_act", { name: "nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /No tool nope; tool_search finds them/);
    disabled = new Set(["thread_send"]);
    calls.length = 0;
    const off = await call("tool_act", { name: "thread_send" });
    assert.equal(off.isError, true);
    assert.equal(calls.length, 0);
    assert.doesNotMatch((await call("tool_search", {})).text, /thread_send/);
    disabled = new Set(["thread_read", "thread_send"]);
    assert.deepEqual(await names(), ["delegate_task"]);
  });

  it("refuses a hidden tool called by its own name", async () => {
    const { call } = await serve(TOOLS);
    const direct = await call("thread_send", {});
    assert.equal(direct.isError, true);
    assert.match(direct.text, /No tool named thread_send/);
  });

  it("reports a bad input as an error the agent can read", async () => {
    const { call } = await serve(TOOLS);
    const result = await call("tool_act", { name: "thread_send", input: "[1]" });
    assert.equal(result.isError, true);
    assert.match(result.text, /must be a JSON object/);
  });
});

/** A server whose policy blocks one tool by its full name, and notes every check. */
async function guarded(blocked: string, gateway = true) {
  calls.length = 0;
  const seen: ToolCallCheck[] = [];
  const policy: ToolPolicy = async (call) => {
    seen.push(call);
    return call.tool === blocked ? `${blocked} is off limits` : undefined;
  };
  return { seen, policy, ...(await serve(TOOLS, { policy, gateway: () => gateway })) };
}
const blocked = (text: string) => ({ text, isError: true });

describe("a tool policy on the tool server", () => {
  it("keeps a blocked tool from running and tells the agent why", async () => {
    const { call } = await guarded("mcp__1harness__thread_send");
    assert.deepEqual(
      await call("tool_act", { name: "thread_send", input: { x: 1 } }),
      blocked("mcp__1harness__thread_send is off limits"),
    );
    assert.equal(calls.length, 0);
  });

  it("checks the tool that tool_act reaches, as a harness's hook would show it", async () => {
    const { call, seen } = await guarded("nothing");
    assert.equal(
      (await call("tool_act", { name: "thread_send", input: { x: 1 } })).text,
      "ran thread_send",
    );
    assert.deepEqual(seen, [
      {
        tool: "mcp__1harness__thread_send",
        input: { x: 1 },
        action: { type: "tool", tool: "thread_send", server: "1harness", input: { x: 1 } },
      },
    ]);
  });

  it("checks the tool that tool_read reaches, with input sent as a string", async () => {
    const { call, seen } = await guarded("mcp__1harness__thread_read");
    assert.equal(
      (await call("tool_read", { name: "thread_read", input: '{"x":1}' })).text,
      "mcp__1harness__thread_read is off limits",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(seen, [
      {
        tool: "mcp__1harness__thread_read",
        input: { x: 1 },
        action: { type: "tool", tool: "thread_read", server: "1harness", input: { x: 1 } },
      },
    ]);
  });

  it("checks direct tools and tool_search under their own names", async () => {
    const { call, seen } = await guarded("mcp__1harness__delegate_task");
    assert.equal((await call("delegate_task", { x: 1 })).isError, true);
    assert.equal(calls.length, 0);
    assert.equal((await call("tool_search", { query: "read" })).isError, false);
    assert.deepEqual(
      seen.map((check) => [check.tool, check.action]),
      [
        [
          "mcp__1harness__delegate_task",
          { type: "tool", tool: "delegate_task", server: "1harness", input: { x: 1 } },
        ],
        [
          "mcp__1harness__tool_search",
          { type: "tool", tool: "tool_search", server: "1harness", input: { query: "read" } },
        ],
      ],
    );
  });

  it("checks tools by name when the gateway is off", async () => {
    const { call } = await guarded("mcp__1harness__thread_send", false);
    assert.equal((await call("thread_send", {})).isError, true);
    assert.equal((await call("thread_read", {})).text, "ran thread_read");
    assert.deepEqual(
      calls.map(([name]) => name),
      ["thread_read"],
    );
  });

  it("does not let a name that is not a string reach a tool past its check", async () => {
    const { call, seen } = await guarded("mcp__1harness__thread_send");
    const reply = await call("tool_act", { name: ["thread_send"] });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /^No tool /);
    assert.equal(calls.length, 0);
    assert.deepEqual(
      seen.map((check) => check.tool),
      ["mcp__1harness__tool_act"],
    );
  });

  it("shows a handler each call once, when a harness's hook runs first too", async () => {
    const { call, seen, policy } = await guarded("nothing");
    for (const [name, input] of [
      ["tool_act", { name: "thread_send", input: { x: 1 } }],
      ["tool_read", { name: "thread_read" }],
      ["delegate_task", {}],
      ["tool_search", {}],
    ] as const) {
      seen.length = 0;
      await checkToolHook(policy, {
        hook_event_name: "PreToolUse",
        tool_name: `mcp__1harness__${name}`,
        tool_input: input,
      });
      assert.equal(seen.length, 0, `the hook leaves ${name} alone`);
      await call(name, input);
      assert.equal(seen.length, 1, `the server checks ${name}`);
    }
  });
});
