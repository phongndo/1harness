import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INIT_PROMPT } from "./prompts.ts";
import { codexResponse, decisionEffect } from "./requests.ts";
import {
  CodexTranslator,
  codexMcpConfig,
  codexRuntimePolicy,
  grantedRuntimeMode,
  toItem,
  toMcpServer,
  unwrapShell,
  type CodexThreadItem,
  type CodexUserInput,
  type CodexWebSearchAction,
} from "./translate.ts";

function search(action: CodexWebSearchAction): CodexThreadItem {
  return { type: "webSearch", id: "w", query: "", action };
}

function text(input: string): CodexUserInput {
  return { type: "text", text: input, text_elements: [] };
}

function userMessage(...content: CodexUserInput[]): CodexThreadItem {
  return { type: "userMessage", id: "u", content };
}

/** A user message sent with a client ID, or without one. */
function sent(clientId: string | null): CodexThreadItem {
  return { type: "userMessage", id: "u", clientId, content: [text("hi")] };
}

function pending(method: string, params: object, decisions: [string, unknown][] = []) {
  return { method, params: params as Record<string, unknown>, decisions: new Map(decisions) };
}

describe("toItem", () => {
  it("maps commands, file changes, tool errors, and reasoning", () => {
    const cases: [CodexThreadItem, unknown][] = [
      [
        {
          type: "commandExecution",
          id: "c1",
          command: "/bin/zsh -lc 'cat notes.txt'",
          cwd: "/w",
          processId: null,
          status: "declined",
          commandActions: [
            { type: "read", command: "cat notes.txt", name: "notes.txt", path: "/w/notes.txt" },
          ],
          aggregatedOutput: null,
          exitCode: null,
        },
        {
          kind: "command",
          id: "c1",
          command: "cat notes.txt",
          output: "",
          exitCode: null,
          status: "declined",
          actions: [{ type: "read", path: "/w/notes.txt" }],
        },
      ],
      [
        {
          type: "fileChange",
          id: "f1",
          changes: [
            { path: "a.ts", kind: { type: "update", move_path: "b.ts" }, diff: "+x" },
            { path: "c.ts", kind: { type: "add" }, diff: "+y" },
          ],
          status: "inProgress",
        },
        {
          kind: "file_change",
          id: "f1",
          changes: [
            { path: "a.ts", kind: "update", diff: "+x", movePath: "b.ts" },
            { path: "c.ts", kind: "add", diff: "+y" },
          ],
          status: "running",
        },
      ],
      [
        {
          type: "mcpToolCall",
          id: "m1",
          server: "docs",
          tool: "search",
          status: "completed",
          arguments: { q: "x" },
          result: null,
          error: { message: "boom" },
        },
        {
          kind: "tool_call",
          id: "m1",
          tool: "search",
          server: "docs",
          category: "other",
          summary: '{"q":"x"}',
          output: "boom",
          status: "failed",
        },
      ],
      [
        { type: "reasoning", id: "r1", summary: ["one", "two"], content: ["raw"] },
        { kind: "reasoning", id: "r1", text: "one\n\ntwo" },
      ],
      [
        { type: "exitedReviewMode", id: "x1", review: "No issues found." },
        { kind: "assistant_message", id: "x1", text: "No issues found." },
      ],
      // A type this driver does not read, as Codex sends it.
      [{ type: "hookPrompt", id: "h1" } as unknown as CodexThreadItem, null],
    ];
    for (const [native, expected] of cases) assert.deepEqual(toItem(native), expected);
  });

  it("shows status notices once, when the item finishes", () => {
    const compaction: CodexThreadItem = { type: "contextCompaction", id: "k" };
    assert.equal(toItem(compaction, false), null);
    assert.deepEqual(toItem(compaction, true), {
      kind: "notice",
      id: "k",
      level: "info",
      text: "Context compacted",
    });
  });

  it("shows a user message as typed, without its skill selection or command prompt", () => {
    assert.deepEqual(
      toItem(
        userMessage(text("/tidy the docs"), { type: "skill", name: "tidy", path: "/s/SKILL.md" }),
      ),
      { kind: "user_message", id: "u", text: "/tidy the docs" },
    );
    assert.deepEqual(toItem(userMessage(text(INIT_PROMPT))), {
      kind: "user_message",
      id: "u",
      text: "/init",
    });
  });

  it("names the input a user message echoes by the client ID it was sent with", () => {
    assert.deepEqual(toItem(sent("m1")), {
      kind: "user_message",
      id: "u",
      text: "hi",
      inputId: "m1",
    });
    // One Codex's own UI sent has no client ID.
    assert.deepEqual(toItem(sent(null)), { kind: "user_message", id: "u", text: "hi" });
  });

  it("maps web search actions and their status", () => {
    assert.deepEqual(toItem(search({ type: "search", query: "zig", queries: null }), false), {
      kind: "web_search",
      id: "w",
      query: "zig",
      status: "running",
    });
    assert.deepEqual(toItem(search({ type: "openPage", url: "https://x.dev" })), {
      kind: "tool_call",
      id: "w",
      tool: "WebFetch",
      server: null,
      category: "fetch",
      summary: "https://x.dev",
      output: "",
      status: "completed",
    });
  });
});

describe("unwrapShell", () => {
  it("shows the command inside Codex's login shell wrapper", () => {
    assert.equal(unwrapShell("/run/current-system/sw/bin/zsh -lc ls"), "ls");
    assert.equal(unwrapShell(`bash -lc 'echo '"'"'hi'"'"''`), "echo 'hi'");
    assert.equal(
      unwrapShell(`/bin/zsh -lc "sed -n '1,5p' README.md && rg --files"`),
      "sed -n '1,5p' README.md && rg --files",
    );
    assert.equal(unwrapShell('zsh -lc "say \\"hi\\""'), 'say "hi"');
    assert.equal(unwrapShell("git status"), "git status");
  });
});

describe("CodexTranslator", () => {
  it("drops notifications for other threads, such as Codex's own agents", () => {
    const translator = new CodexTranslator();
    translator.threadId = "main";
    const delta = { threadId: "child", itemId: "i", delta: "x" };
    assert.deepEqual(translator.translate("item/agentMessage/delta", delta), []);
    assert.equal(
      translator.translate("item/agentMessage/delta", { ...delta, threadId: "main" }).length,
      1,
    );
    // Agents' requests are answered here, so their resolutions pass.
    assert.deepEqual(
      translator.translate("serverRequest/resolved", { threadId: "child", requestId: 2 }),
      [{ type: "request.resolved", requestId: "codex-request-2" }],
    );
  });

  it("maps turn completion, plan updates, usage, and resolved requests", () => {
    const translator = new CodexTranslator();
    translator.threadId = "t";
    assert.deepEqual(
      translator.translate("turn/completed", {
        threadId: "t",
        turn: { id: "u1", items: [], status: "interrupted", error: null },
      }),
      [{ type: "turn.ended", turnId: "u1", status: "interrupted", error: null }],
    );
    assert.deepEqual(
      translator.translate("turn/plan/updated", {
        threadId: "t",
        turnId: "u1",
        explanation: null,
        plan: [
          { step: "a", status: "completed" },
          { step: "b", status: "inProgress" },
        ],
      }),
      [
        {
          type: "item.updated",
          item: {
            kind: "todo_list",
            id: "codex-todo-u1",
            steps: [
              { text: "a", status: "completed" },
              { text: "b", status: "in_progress" },
            ],
          },
        },
      ],
    );
    assert.deepEqual(
      translator.translate("thread/tokenUsage/updated", {
        threadId: "t",
        turnId: "u1",
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 2 },
          last: { totalTokens: 7 },
          modelContextWindow: 100,
        },
      }),
      [
        {
          type: "usage.updated",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            contextTokens: 7,
            contextWindow: 100,
            costUsd: null,
            limits: [],
          },
        },
      ],
    );
  });

  it("reports a fatal error once and keeps retries on one updating line", () => {
    const translator = new CodexTranslator();
    translator.threadId = "t";
    const error = (willRetry: boolean, message: string) =>
      translator.translate("error", {
        threadId: "t",
        turnId: "u",
        willRetry,
        error: { message, codexErrorInfo: null, additionalDetails: null },
      });
    const first = error(true, "stream disconnected");
    const second = error(true, "stream disconnected");
    assert.equal(first[0]?.type === "item.updated" && first[0].item.id, "codex-retry-u");
    assert.equal(
      second[0]?.type === "item.updated" && second[0].item.kind === "notice" && second[0].item.text,
      "Reconnecting (attempt 2): stream disconnected",
    );
    assert.deepEqual(error(false, "out of credits"), []);
    assert.deepEqual(
      translator.translate("turn/completed", {
        threadId: "t",
        turn: { id: "u", items: [], status: "failed", error: null },
      }),
      [{ type: "turn.ended", turnId: "u", status: "failed", error: "out of credits" }],
    );
  });

  it("shows a review's findings once, whichever copy arrives first", () => {
    const translator = new CodexTranslator();
    translator.threadId = "t";
    const item = (native: object) =>
      translator.translate("item/completed", { threadId: "t", turnId: "u", item: native });
    assert.equal(item({ type: "exitedReviewMode", id: "x", review: "No issues." }).length, 1);
    assert.deepEqual(item({ type: "agentMessage", id: "a", text: "No issues." }), []);
    // An ordinary reply that happens to repeat earlier text is still shown.
    translator.translate("turn/completed", {
      threadId: "t",
      turn: { id: "u", items: [], status: "completed", error: null },
    });
    assert.equal(item({ type: "agentMessage", id: "b", text: "No issues." }).length, 1);
  });

  it("asks for the command list again when skills change on disk", () => {
    assert.deepEqual(new CodexTranslator().translate("skills/changed", {}), [
      { type: "commands.updated" },
    ]);
  });

  it("remembers a proposed plan for the turn", () => {
    const translator = new CodexTranslator();
    translator.threadId = "t";
    translator.translate("item/completed", {
      threadId: "t",
      turnId: "u",
      item: { type: "plan", id: "p", text: "1. do it" },
    });
    assert.equal(translator.takePlan("u"), true);
    assert.equal(translator.takePlan("u"), false);
  });

  it("warns once as a usage window nears its limit", () => {
    const translator = new CodexTranslator();
    const update = (usedPercent: number) =>
      translator.translate("account/rateLimits/updated", {
        rateLimits: {
          primary: { usedPercent, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          rateLimitReachedType: null,
        },
      });
    assert.equal(update(50).length, 1);
    const warned = update(92);
    assert.equal(warned[0]?.type === "item.completed" && warned[0].item.kind, "notice");
    assert.equal(update(95).length, 1);
    const last = update(95).at(-1);
    assert.deepEqual(last?.type === "usage.updated" && last.usage.limits, [
      { label: "5h", usedPercent: 95, resetsAt: null, status: "warning" },
    ]);
  });
});

describe("toMcpServer", () => {
  const status = {
    name: "docs",
    runtimeStatus: "connected",
    authStatus: "oAuth",
    pluginId: null,
    httpOrigin: "https://docs.dev",
    tools: { search: {}, fetch: {} },
    toolsError: null,
  };

  it("fills in the command or URL and the file from Codex's config", () => {
    assert.deepEqual(toMcpServer(status, { url: "https://docs.dev/mcp" }, "~/.codex/config.toml"), {
      name: "docs",
      state: "connected",
      source: "~/.codex/config.toml",
      transport: "http",
      target: "https://docs.dev/mcp",
      auth: "OAuth",
      error: null,
      tools: ["fetch", "search"],
    });
    const local = toMcpServer(
      { ...status, httpOrigin: null, authStatus: "unsupported" },
      { command: "npx", args: ["-y", "docs-mcp"] },
      null,
    );
    assert.equal(local.transport, "stdio");
    assert.equal(local.target, "npx -y docs-mcp");
    assert.equal(local.auth, null);
  });

  it("reads sign-in, plugin, and Codex's own apps connector", () => {
    const signedOut = { ...status, runtimeStatus: null, authStatus: "notLoggedIn" };
    assert.equal(toMcpServer(signedOut, undefined, null).state, "needs-login");
    assert.equal(
      toMcpServer({ ...status, pluginId: "data" }, undefined, null).source,
      "plugin data",
    );
    assert.equal(
      toMcpServer({ ...status, name: "codex_apps" }, undefined, null).source,
      "ChatGPT apps",
    );
  });

  it("reports how a sign-in ended", () => {
    const translator = new CodexTranslator();
    const done = (params: object) =>
      translator.translate("mcpServer/oauthLogin/completed", params as Record<string, unknown>);
    assert.equal(
      (done({ name: "docs", success: true })[0] as { item: { text: string } }).item.text,
      "Signed in to docs",
    );
    assert.equal(
      (done({ name: "docs", success: false, error: "denied" })[0] as { item: { text: string } })
        .item.text,
      "Could not sign in to docs: denied",
    );
  });
});

describe("grantedRuntimeMode", () => {
  it("runs in the mode the granted sandbox allows, never broader than asked", () => {
    const workspace = {
      type: "workspaceWrite" as const,
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    assert.equal(grantedRuntimeMode("auto", workspace), "auto");
    assert.equal(grantedRuntimeMode("full-access", workspace), "auto-edit");
    assert.equal(
      grantedRuntimeMode("full-access", { type: "readOnly", networkAccess: false }),
      "supervised",
    );
    assert.equal(grantedRuntimeMode("supervised", workspace), "supervised");
    assert.equal(grantedRuntimeMode("supervised", { type: "dangerFullAccess" }), "full-access");
  });
});

describe("codexRuntimePolicy", () => {
  it("enforces each mode with Codex's own approval policy and sandbox", () => {
    assert.deepEqual(
      [
        codexRuntimePolicy("supervised"),
        codexRuntimePolicy("auto"),
        codexRuntimePolicy("full-access"),
      ].map((policy) => [
        policy.approvalPolicy,
        policy.approvalsReviewer,
        policy.sandboxPolicy.type,
      ]),
      [
        ["untrusted", "user", "readOnly"],
        ["on-request", "auto_review", "workspaceWrite"],
        ["never", "user", "dangerFullAccess"],
      ],
    );
  });

  it("keeps the user's configured writable roots and network access", () => {
    const base = {
      type: "workspaceWrite" as const,
      writableRoots: ["/data"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    assert.deepEqual(codexRuntimePolicy("auto-edit", base).sandboxPolicy, base);
  });
});

describe("codexMcpConfig", () => {
  it("adds servers as one table that merges with Codex's own", () => {
    assert.deepEqual(
      codexMcpConfig({
        "docs.v2": { type: "stdio", command: "npx", args: ["docs"], env: { A: "b" } },
        "1harness": {
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer t" },
        },
      }),
      {
        mcp_servers: {
          "docs.v2": { command: "npx", args: ["docs"], env: { A: "b" } },
          "1harness": {
            url: "http://127.0.0.1:1/mcp",
            http_headers: { Authorization: "Bearer t" },
          },
        },
      },
    );
    assert.deepEqual(codexMcpConfig({}), {});
  });
});

describe("decisionEffect", () => {
  it("says what each native decision does", () => {
    assert.equal(decisionEffect("accept"), "allow");
    assert.equal(decisionEffect("acceptForSession"), "allow-always");
    assert.equal(
      decisionEffect({ acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } }),
      "allow-always",
    );
    assert.equal(decisionEffect("cancel"), "deny");
    assert.equal(
      decisionEffect({
        applyNetworkPolicyAmendment: { network_policy_amendment: { action: "deny" } },
      }),
      "deny",
    );
    assert.equal(
      decisionEffect({ action: "accept", _meta: { persist: "session" } }),
      "allow-always",
    );
    assert.equal(decisionEffect({ action: "decline" }), "deny");
  });
});

describe("codexResponse", () => {
  it("declines with Codex's continue-without-it decision", () => {
    const offered = pending("item/commandExecution/requestApproval", {}, [
      ["d0", "accept"],
      ["d1", "decline"],
      ["d2", "cancel"],
    ]);
    assert.deepEqual(codexResponse(offered, { kind: "decline", reason: "no" }), {
      decision: "decline",
    });
    const cancelOnly = pending("item/commandExecution/requestApproval", {}, [["d0", "cancel"]]);
    assert.deepEqual(
      codexResponse(cancelOnly, { kind: "decline", reason: "no" }),
      { decision: "decline" },
      "Codex accepts it even when it offers only cancel",
    );
  });

  it("maps option IDs back to the decisions Codex offered", () => {
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } };
    assert.deepEqual(
      codexResponse(
        pending("item/commandExecution/requestApproval", {}, [
          ["d0", "accept"],
          ["d1", amendment],
        ]),
        { kind: "approval", optionId: "d1" },
      ),
      { decision: amendment },
    );
    assert.deepEqual(
      codexResponse(pending("item/fileChange/requestApproval", {}), { kind: "cancel" }),
      { decision: "cancel" },
    );
  });

  it("builds permission, question, and MCP form replies", () => {
    assert.deepEqual(
      codexResponse(
        pending(
          "item/permissions/requestApproval",
          { permissions: { network: { enabled: true }, fileSystem: null } },
          [["d1", "session"]],
        ),
        { kind: "approval", optionId: "d1" },
      ),
      { permissions: { network: { enabled: true } }, scope: "session" },
    );
    assert.deepEqual(
      codexResponse(pending("item/tool/requestUserInput", {}), {
        kind: "question",
        answers: { q1: ["Yes"] },
      }),
      { answers: { q1: { answers: ["Yes"] } } },
    );
    assert.deepEqual(
      codexResponse(
        pending("mcpServer/elicitation/request", {
          requestedSchema: {
            properties: {
              count: { type: "number" },
              color: { type: "string", oneOf: [{ const: "r", title: "Red" }] },
            },
          },
        }),
        { kind: "question", answers: { count: ["3"], color: ["Red"] } },
      ),
      { action: "accept", content: { count: 3, color: "r" }, _meta: null },
    );
    assert.deepEqual(
      codexResponse(
        pending("mcpServer/elicitation/request", {}, [
          ["d0", { action: "accept", content: {}, _meta: { persist: "session" } }],
        ]),
        { kind: "approval", optionId: "d0" },
      ),
      { action: "accept", content: {}, _meta: { persist: "session" } },
    );
  });
});
