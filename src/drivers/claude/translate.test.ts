import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { toolAction } from "../../core/tools.ts";
import {
  ClaudeTranslator,
  claudeRuntimeModes,
  permissionModeFor,
  runtimeModeFor,
  toMcpServer,
  toolItem,
} from "./translate.ts";

function message(value: object): SDKMessage {
  return value as unknown as SDKMessage;
}

function stream(event: object): SDKMessage {
  return message({ type: "stream_event", parent_tool_use_id: null, event });
}

function assistant(id: string, content: object[], parent: string | null = null): SDKMessage {
  return message({ type: "assistant", parent_tool_use_id: parent, message: { id, content } });
}

function stored(content: string) {
  return new ClaudeTranslator({ replay: true }).translate(
    message({ type: "user", parent_tool_use_id: null, message: { role: "user", content } }),
  );
}

describe("ClaudeTranslator", () => {
  it("matches each per-block assistant message to the block streamed before it", () => {
    const translator = new ClaudeTranslator();
    const events = [
      stream({ type: "message_start", message: { id: "m1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }),
      // The SDK delivers one assistant message per block, each with that block alone.
      assistant("m1", [{ type: "thinking", thinking: "hmm" }]),
      assistant("m1", [{ type: "text", text: "Hi there" }]),
    ].flatMap((entry) => translator.translate(entry));
    assert.deepEqual(events, [
      { type: "item.started", item: { kind: "reasoning", id: "m1:0", text: "" } },
      { type: "item.started", item: { kind: "assistant_message", id: "m1:1", text: "" } },
      { type: "item.delta", itemId: "m1:1", chunk: "Hi" },
      { type: "item.completed", item: { kind: "reasoning", id: "m1:0", text: "hmm" } },
      { type: "item.completed", item: { kind: "assistant_message", id: "m1:1", text: "Hi there" } },
    ]);
  });

  it("completes tool calls from their results and ignores agent transcripts", () => {
    const translator = new ClaudeTranslator();
    const started = translator.translate(
      assistant("m2", [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "ls" } }]),
    );
    assert.equal(started[0]?.type, "item.started");
    assert.deepEqual(
      translator.translate(
        assistant("m3", [{ type: "tool_use", id: "inner", name: "Read", input: {} }], "tool0"),
      ),
      [],
    );
    const done = translator.translate(
      message({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool1", content: "a\nb", is_error: true }],
        },
      }),
    );
    assert.deepEqual(done, [
      {
        type: "item.completed",
        item: {
          kind: "command",
          id: "tool1",
          command: "ls",
          output: "a\nb",
          exitCode: null,
          status: "failed",
        },
      },
    ]);
  });

  it("settles tool calls left open when a turn ends", () => {
    const translator = new ClaudeTranslator();
    translator.translate(
      assistant("m4", [{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "x" } }]),
    );
    const settled = translator.settleOpenTools(true);
    assert.equal(settled.length, 1);
    assert.equal(
      settled[0]?.type === "item.completed" &&
        settled[0].item.kind === "tool_call" &&
        settled[0].item.status,
      "failed",
    );
    assert.deepEqual(translator.settleOpenTools(true), []);
  });

  it("reports usage with context window and cost from the result", () => {
    const translator = new ClaudeTranslator();
    translator.translate(
      message({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m5",
          content: [],
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 90,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
          },
        },
      }),
    );
    const events = translator.translate(
      message({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.25,
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 0,
          output_tokens: 5,
        },
        modelUsage: { haiku: { contextWindow: 1000 } },
      }),
    );
    assert.deepEqual(events, [
      {
        type: "usage.updated",
        usage: {
          inputTokens: 95,
          outputTokens: 5,
          contextTokens: 100,
          contextWindow: 1000,
          costUsd: 0.25,
          limits: [],
        },
      },
    ]);
  });

  it("keeps the main model's context window and skips synthetic usage", () => {
    const translator = new ClaudeTranslator();
    translator.model = "opus";
    translator.translate(
      message({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [],
          usage: { input_tokens: 40, output_tokens: 2 },
        },
      }),
    );
    translator.translate(
      message({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m2",
          model: "<synthetic>",
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
    const [event] = translator.translate(
      message({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { opus: { contextWindow: 200_000 }, haiku: { contextWindow: 1000 } },
      }),
    );
    assert.equal(event?.type === "usage.updated" && event.usage.contextTokens, 42);
    assert.equal(event?.type === "usage.updated" && event.usage.contextWindow, 200_000);
  });

  it("uses the applied patch for edits and tells a new file from a replaced one", () => {
    const translator = new ClaudeTranslator();
    translator.translate(
      assistant("m1", [
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/a.ts", content: "x\n" },
        },
      ]),
    );
    const [event] = translator.translate(
      message({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }],
        },
        tool_use_result: {
          type: "update",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-y", "+x"] },
          ],
        },
      }),
    );
    assert.deepEqual(event?.type === "item.completed" && event.item, {
      kind: "file_change",
      id: "w1",
      changes: [{ path: "/a.ts", kind: "update", diff: "@@ -1,1 +1,1 @@\n-y\n+x" }],
      status: "completed",
    });
  });

  it("builds one task list from Claude's task tools", () => {
    const translator = new ClaudeTranslator();
    const call = (id: string, name: string, input: object, result: object) => {
      translator.translate(assistant(`m-${id}`, [{ type: "tool_use", id, name, input }]));
      return translator.translate(
        message({
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "" }],
          },
          tool_use_result: result,
        }),
      );
    };
    call(
      "t1",
      "TaskCreate",
      { subject: "Write tests" },
      { task: { id: "1", subject: "Write tests" } },
    );
    call("t2", "TaskCreate", { subject: "Ship" }, { task: { id: "2", subject: "Ship" } });
    const events = call(
      "t3",
      "TaskUpdate",
      { taskId: "1", status: "in_progress" },
      { success: true },
    );
    assert.deepEqual(events, [
      {
        type: "item.updated",
        item: {
          kind: "todo_list",
          id: "claude-tasks",
          steps: [
            { text: "Write tests", status: "in_progress" },
            { text: "Ship", status: "pending" },
          ],
        },
      },
    ]);
  });

  it("warns when a subscription limit is near or reached", () => {
    const translator = new ClaudeTranslator();
    const limit = (status: string) =>
      translator.translate(
        message({
          type: "rate_limit_event",
          rate_limit_info: { status, rateLimitType: "five_hour", utilization: 0.95 },
        }),
      );
    const warning = limit("allowed_warning");
    assert.equal(warning[0]?.type === "item.completed" && warning[0].item.kind, "notice");
    const usage = warning.at(-1);
    assert.deepEqual(usage?.type === "usage.updated" && usage.usage.limits, [
      { label: "5h", usedPercent: 95, resetsAt: null, status: "warning" },
    ]);
    // The same status again adds no second warning.
    assert.equal(limit("allowed_warning").length, 1);
  });

  it("keeps retries and compaction on one updating line each", () => {
    const translator = new ClaudeTranslator();
    const retry = (attempt: number) =>
      translator.translate(
        message({
          type: "system",
          subtype: "api_retry",
          attempt,
          max_retries: 5,
          error_status: 529,
          error: "overloaded",
        }),
      )[0];
    const first = retry(1);
    const second = retry(2);
    assert.equal(first?.type, "item.updated");
    assert.equal(
      first?.type === "item.updated" &&
        second?.type === "item.updated" &&
        first.item.id === second.item.id,
      true,
    );
    const compacting = translator.translate(
      message({ type: "system", subtype: "status", status: "compacting" }),
    )[0];
    const compacted = translator.translate(
      message({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { pre_tokens: 9000 },
      }),
    )[0];
    assert.equal(
      compacting?.type === "item.updated" &&
        compacted?.type === "item.updated" &&
        compacting.item.id === compacted.item.id,
      true,
    );
  });

  it("renders stored prompts only when replaying history", () => {
    const prompt = message({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "hello" },
    });
    assert.deepEqual(new ClaudeTranslator().translate(prompt), []);
    const replayed = new ClaudeTranslator({ replay: true }).translate(prompt);
    assert.equal(replayed[0]?.type === "item.completed" && replayed[0].item.kind, "user_message");
  });

  it("replays slash commands as typed and their output as notices", () => {
    const [command] = stored(
      "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>haiku</command-args>",
    );
    assert.equal(
      command?.type === "item.completed" &&
        command.item.kind === "user_message" &&
        command.item.text,
      "/model haiku",
    );
    const [output] = stored("<local-command-stdout>Set model to Haiku</local-command-stdout>");
    assert.equal(output?.type === "item.completed" && output.item.kind, "notice");
    assert.deepEqual(stored("<local-command-caveat>Caveat: generated</local-command-caveat>"), []);
  });
});

describe("toolItem", () => {
  it("maps Claude's tools to shared items", () => {
    assert.deepEqual(toolItem("a", "mcp__docs__search", { query: "x" }), {
      kind: "tool_call",
      id: "a",
      tool: "search",
      server: "docs",
      category: "other",
      summary: "x",
      output: "",
      status: "running",
    });
    assert.deepEqual(
      toolItem("b", "TodoWrite", { todos: [{ content: "do", status: "in_progress" }] }),
      {
        kind: "todo_list",
        id: "claude-todos",
        steps: [{ text: "do", status: "in_progress" }],
      },
    );
    assert.equal(toolItem("c", "AskUserQuestion", {}), null);
    const read = toolItem("d", "Read", { file_path: "/x" });
    assert.equal(read?.kind === "tool_call" ? read.category : null, "read");
  });

  it("says what an approval is for", () => {
    assert.deepEqual(toolAction("Bash", { command: "ls" }), {
      type: "command",
      command: "ls",
      cwd: null,
    });
    assert.deepEqual(toolAction("Edit", { file_path: "/a.ts" }), {
      type: "file_change",
      paths: ["/a.ts"],
    });
    assert.deepEqual(toolAction("mcp__docs__search", { q: 1 }), {
      type: "tool",
      tool: "search",
      server: "docs",
      input: { q: 1 },
    });
  });
});

describe("permission modes", () => {
  it("maps runtime and interaction modes both ways", () => {
    assert.equal(permissionModeFor("auto-edit", "default"), "acceptEdits");
    assert.equal(permissionModeFor("full-access", "plan"), "plan");
    assert.equal(runtimeModeFor("bypassPermissions"), "full-access");
    assert.equal(runtimeModeFor("plan"), null);
  });

  it("leaves out the modes Claude Code's settings turn off", () => {
    assert.deepEqual(claudeRuntimeModes([{}, null]), [
      "supervised",
      "auto-edit",
      "auto",
      "full-access",
    ]);
    assert.deepEqual(
      claudeRuntimeModes([
        { permissions: { disableBypassPermissionsMode: "disable" } },
        { disableAutoMode: "disable" },
      ]),
      ["supervised", "auto-edit"],
    );
    assert.deepEqual(claudeRuntimeModes([{ permissions: { disableAutoMode: "disable" } }]), [
      "supervised",
      "auto-edit",
      "full-access",
    ]);
  });
});

describe("toMcpServer", () => {
  it("maps Claude Code's server status, config, and source", () => {
    assert.deepEqual(
      toMcpServer({
        name: "docs",
        status: "connected",
        source: "project",
        config: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"] },
        tools: [{ name: "search" }, { name: "fetch" }],
      }),
      {
        name: "docs",
        state: "connected",
        source: "project",
        transport: "stdio",
        target: "npx -y docs-mcp",
        auth: null,
        error: null,
        tools: ["fetch", "search"],
      },
    );
    const connector = toMcpServer({
      name: "claude.ai Gmail",
      status: "needs-auth",
      scope: "claudeai",
      config: { type: "claudeai-proxy", url: "https://mcp.example/gmail", id: "g" },
    });
    assert.equal(connector.state, "needs-login");
    assert.equal(connector.source, "claude.ai");
    assert.equal(connector.transport, "http");
  });
});
