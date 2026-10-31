import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenCodeTranslator,
  findModel,
  formAnswer,
  formRequest,
  mergeRules,
  modelOptions,
  permissionRequest,
  sessionRules,
  type OcAgent,
  type OcForm,
  type OcModel,
  type OcPermission,
} from "./translate.ts";

// Events as OpenCode 2.2 sends them, trimmed to the fields that matter.
const PATCH =
  "Index: note.txt\n===================================================================\n--- note.txt\n+++ note.txt\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n";

const tokens = (input: number, read: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write: 0 },
});

const statuses = (events: ReturnType<OpenCodeTranslator["translate"]>) =>
  events.map(
    (event) => event.type === "item.completed" && "status" in event.item && event.item.status,
  );

function call(translator: OpenCodeTranslator, id: string, name: string, input: unknown) {
  translator.translate({ type: "session.tool.input.started", data: { id, name } });
  return translator.translate({ type: "session.tool.called", data: { id, input } });
}

describe("OpenCodeTranslator", () => {
  it("streams replies and reasoning by their message and ordinal", () => {
    const translator = new OpenCodeTranslator("/work");
    const at = { assistantMessageID: "msg_a", ordinal: 0 };
    assert.deepEqual(translator.translate({ type: "session.text.started", data: at }), [
      { type: "item.started", item: { kind: "assistant_message", id: "msg_a:text:0", text: "" } },
    ]);
    assert.deepEqual(
      translator.translate({ type: "session.text.delta", data: { ...at, delta: "hi" } }),
      [{ type: "item.delta", itemId: "msg_a:text:0", chunk: "hi" }],
    );
    translator.translate({ type: "session.reasoning.started", data: at });
    assert.deepEqual(
      translator.translate({ type: "session.text.ended", data: { ...at, text: "hi there" } }),
      [
        {
          type: "item.completed",
          item: { kind: "assistant_message", id: "msg_a:text:0", text: "hi there" },
        },
      ],
    );
    // A reasoning stream the turn cut off ends with what it had.
    translator.translate({ type: "session.reasoning.delta", data: { ...at, delta: "hmm" } });
    assert.deepEqual(translator.flush(), [
      { type: "item.completed", item: { kind: "reasoning", id: "msg_a:reasoning:0", text: "hmm" } },
    ]);
  });

  it("maps commands, edits with OpenCode's patch, and writes with the diff their approval showed", () => {
    const translator = new OpenCodeTranslator("/work");
    assert.deepEqual(call(translator, "c1", "shell", { command: "ls" }), [
      {
        type: "item.started",
        item: {
          kind: "command",
          id: "c1",
          command: "ls",
          output: "",
          exitCode: null,
          status: "running",
        },
      },
    ]);
    assert.deepEqual(
      translator.translate({
        type: "session.tool.success",
        data: { id: "c1", content: [{ type: "text", text: "a.txt\n" }], metadata: { exit: 0 } },
      }),
      [
        {
          type: "item.completed",
          item: {
            kind: "command",
            id: "c1",
            command: "ls",
            output: "a.txt\n",
            exitCode: 0,
            status: "completed",
          },
        },
      ],
    );
    call(translator, "e1", "edit", {
      path: "/work/note.txt",
      oldString: "alpha",
      newString: "beta",
    });
    const edited = translator.translate({
      type: "session.tool.success",
      data: {
        id: "e1",
        content: [],
        metadata: { files: [{ file: "note.txt", patch: PATCH, status: "modified" }] },
      },
    });
    assert.deepEqual(edited[0]?.type === "item.completed" && edited[0].item, {
      kind: "file_change",
      id: "e1",
      changes: [
        { path: "/work/note.txt", kind: "update", diff: "@@ -1,1 +1,1 @@\n-alpha\n+beta\n" },
      ],
      status: "completed",
    });
    call(translator, "w1", "write", { path: "/work/new.txt", content: "x\n" });
    translator.translate({
      type: "permission.asked",
      data: {
        id: "per_1",
        action: "edit",
        resources: ["new.txt"],
        metadata: { files: [{ file: "new.txt", patch: "@@ -0,0 +1,1 @@\n+x\n", status: "added" }] },
        source: { type: "tool", id: "w1" },
      },
    });
    const written = translator.translate({
      type: "session.tool.success",
      data: { id: "w1", content: [{ type: "text", text: "Created file" }], metadata: {} },
    });
    assert.deepEqual(written[0]?.type === "item.completed" && written[0].item, {
      kind: "file_change",
      id: "w1",
      changes: [{ path: "/work/new.txt", kind: "add", diff: "@@ -0,0 +1,1 @@\n+x\n" }],
      status: "completed",
    });
  });

  it("marks declined calls, and fails calls an interruption or the turn's end cut off", () => {
    const translator = new OpenCodeTranslator("/work");
    call(translator, "c1", "shell", { command: "rm -rf build" });
    const declined = translator.translate({
      type: "session.tool.failed",
      data: { id: "c1", error: { type: "aborted", message: "The user declined this tool call" } },
    });
    assert.deepEqual(statuses(declined), ["declined"]);
    call(translator, "c2", "shell", { command: "sleep 30" });
    const interrupted = translator.translate({
      type: "session.tool.failed",
      data: { id: "c2", error: { type: "aborted", message: "Tool execution interrupted" } },
    });
    assert.deepEqual(statuses(interrupted), ["failed"]);
    call(translator, "c3", "shell", { command: "sleep 60" });
    assert.deepEqual(statuses(translator.flush()), ["failed"]);
  });

  it("names MCP tools by their server and finds the running calls of one", () => {
    const translator = new OpenCodeTranslator("/work");
    translator.mcpServers = ["1harness", "probe"];
    const [started] = call(translator, "m1", "1harness_delegate_task", { task: "fix it" });
    assert.deepEqual(started?.type === "item.started" && started.item, {
      kind: "tool_call",
      id: "m1",
      tool: "delegate_task",
      server: "1harness",
      category: "other",
      summary: '{"task":"fix it"}',
      output: "",
      status: "running",
    });
    assert.deepEqual(translator.running("delegate_task"), ["m1"]);
    call(translator, "m2", "1harness_delegate_task", { task: "and this" });
    assert.deepEqual(translator.running("delegate_task"), ["m1", "m2"]);
    // A question shows as its form, and a subagent as an agent.
    assert.deepEqual(call(translator, "q1", "question", { questions: [] }), []);
    const [agent] = call(translator, "s1", "subagent", {
      agent: "general",
      description: "Look",
      prompt: "Look around",
    });
    assert.equal(agent?.type === "item.started" && agent.item.kind, "agent");
  });

  it("matches MCP tools to servers by the names OpenCode gives them, from the input's start", () => {
    const translator = new OpenCodeTranslator("/work");
    translator.mcpServers = ["docs", "docs.search"];
    translator.translate({
      type: "session.tool.input.started",
      data: { id: "m1", name: "docs_search_lookup" },
    });
    // The call is known once its input starts, before OpenCode says it is called.
    assert.deepEqual(translator.running("lookup"), ["m1"]);
    const [started] = translator.translate({
      type: "session.tool.called",
      data: { id: "m1", input: { q: "x" } },
    });
    assert.deepEqual(
      started?.type === "item.started" &&
        started.item.kind === "tool_call" && [started.item.server, started.item.tool],
      ["docs.search", "lookup"],
    );
  });

  it("shows a patch as changes to the files it names, with the diffs its result has", () => {
    const translator = new OpenCodeTranslator("/work");
    const [started] = call(translator, "p1", "patch", {
      patchText:
        "*** Begin Patch\n*** Update File: note.txt\n@@\n-alpha\n+beta\n*** Add File: new.txt\n+x\n*** End Patch",
    });
    assert.deepEqual(
      started?.type === "item.started" &&
        started.item.kind === "file_change" &&
        started.item.changes.map((change) => [change.path, change.kind]),
      [
        ["note.txt", "update"],
        ["new.txt", "add"],
      ],
    );
    const [done] = translator.translate({
      type: "session.tool.success",
      data: {
        id: "p1",
        content: [],
        metadata: { files: [{ file: "note.txt", patch: PATCH, status: "modified" }] },
      },
    });
    assert.deepEqual(
      done?.type === "item.completed" && done.item.kind === "file_change" && done.item.changes,
      [{ path: "/work/note.txt", kind: "update", diff: "@@ -1,1 +1,1 @@\n-alpha\n+beta\n" }],
    );
  });

  it("reports context from the last step and totals from the session", () => {
    const translator = new OpenCodeTranslator("/work");
    translator.contextWindow = 200_000;
    translator.translate({ type: "session.step.ended", data: { tokens: tokens(151, 10_240, 2) } });
    assert.deepEqual(
      translator.translate({
        type: "session.usage.updated",
        data: { cost: 0.5, tokens: tokens(10_077, 11_136, 46) },
      }),
      [
        {
          type: "usage.updated",
          usage: {
            inputTokens: 21_213,
            outputTokens: 46,
            contextTokens: 10_393,
            contextWindow: 200_000,
            costUsd: 0.5,
            limits: [],
          },
        },
      ],
    );
  });

  it("replays a session's history as finished items", () => {
    const translator = new OpenCodeTranslator("/work");
    const events = translator.history([
      { type: "user", id: "msg_1", text: "run ls" },
      {
        type: "assistant",
        id: "msg_2",
        content: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool",
            id: "c1",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "ls" },
              content: [{ type: "text", text: "a.txt" }],
              metadata: { exit: 0 },
            },
          },
          { type: "text", text: "Done." },
        ],
      },
      { type: "idle", id: "msg_3" },
    ] as never);
    assert.deepEqual(
      events.map((event) => event.type === "item.completed" && [event.item.kind, event.item.id]),
      [
        ["user_message", "msg_1"],
        ["command", "c1"],
        ["assistant_message", "msg_2:text:2"],
      ],
    );
  });
});

describe("OpenCode requests", () => {
  it("asks for a command with what it runs, and offers OpenCode's choices", () => {
    const permission: OcPermission = {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["sleep 8", "echo slept"],
      save: ["sleep *", "echo *"],
      source: { type: "tool", id: "c1" },
    };
    const command = {
      kind: "command",
      id: "c1",
      command: "sleep 8; echo slept",
      output: "",
      exitCode: null,
      status: "running",
    } as const;
    const request = permissionRequest(permission, command, "/work");
    assert.equal(request.title, "Run this command?");
    assert.equal(request.detail, "$ sleep 8; echo slept");
    assert.deepEqual(
      request.options.map((option) => [option.id, option.label, option.effect]),
      [
        ["once", "Yes", "allow"],
        ["always", "Yes, and always allow `sleep *`, `echo *`", "allow-always"],
        ["reject", "No, and tell the agent what to do differently", "deny"],
      ],
    );
  });

  it("asks for an edit by what it does to the file, with its diff", () => {
    const request = permissionRequest(
      {
        id: "per_2",
        sessionID: "ses_1",
        action: "edit",
        resources: ["note.txt"],
        save: ["*"],
        metadata: {
          files: [{ file: "note.txt", patch: "@@ -0,0 +1,1 @@\n+alpha\n", status: "added" }],
        },
      },
      undefined,
      "/work",
    );
    assert.equal(request.title, "Create note.txt?");
    assert.equal(request.detail, "/work/note.txt\n@@ -0,0 +1,1 @@\n+alpha\n");
    assert.equal(request.options[1]?.label, "Yes, and always allow edits here");
  });

  it("turns a form into questions and the answers back into its values", () => {
    const form: OcForm = {
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      fields: [
        {
          key: "q0",
          type: "string",
          title: "Color",
          description: "Which color?",
          options: [
            { value: "red", label: "Red", description: "Warm" },
            { value: "blue", label: "Blue" },
          ],
          custom: true,
        },
        { key: "q1", type: "multiselect", title: "Sizes", options: ["S", "M"] },
        { key: "q2", type: "boolean", title: "Confirm?" },
        { key: "q3", type: "string", hidden: true },
      ],
    };
    const request = formRequest(form);
    assert.deepEqual(
      request.questions.map((question) => [
        question.id,
        question.question,
        question.options.map((option) => option.label),
        question.multiSelect,
        question.allowOther,
      ]),
      [
        ["q0", "Which color?", ["Red", "Blue"], false, true],
        ["q1", "Sizes", ["S", "M"], true, false],
        ["q2", "Confirm?", ["Yes", "No"], false, false],
      ],
    );
    assert.deepEqual(formAnswer(form, { q0: ["Blue"], q1: ["S", "M"], q2: ["No"] }), {
      q0: "blue",
      q1: ["S", "M"],
      q2: false,
    });
    assert.deepEqual(formAnswer(form, { q0: ["green"] }), { q0: "green" });
  });
});

describe("OpenCode settings", () => {
  const plan: OcAgent = {
    id: "plan",
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/home/me/.opencode/plan/*", effect: "allow" },
      { action: "browser", resource: "*", effect: "deny" },
    ],
  };

  it("asks for everything but reading in supervised, after which the agent's denials still hold", () => {
    const rules = sessionRules("supervised", plan, true);
    assert.deepEqual(rules[0], { action: "*", resource: "*", effect: "ask" });
    assert.ok(rules.some((rule) => rule.action === "read" && rule.effect === "allow"));
    // Plan mode's edit rules come last, so they win over the mode's.
    assert.deepEqual(rules.slice(-3), plan.permissions.slice(2));
    // Outside plan mode only the denials are kept.
    assert.deepEqual(sessionRules("full-access", plan, false), [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "deny" },
    ]);
  });

  it("replaces 1harness's rules on a session and keeps the ones OpenCode added", () => {
    const grant = {
      action: "external_directory",
      resource: "/srv/data/*",
      effect: "allow",
    } as const;
    const current = [...sessionRules("full-access", plan, false), grant];
    const merged = mergeRules(current, sessionRules("supervised", plan, true), [plan]);
    assert.deepEqual(merged, [...sessionRules("supervised", plan, true), grant]);
  });

  it("names models by provider, with their variants as efforts", () => {
    const models: OcModel[] = [
      {
        id: "gpt-6.1-terra",
        providerID: "openai",
        name: "GPT-6.1 Terra",
        enabled: true,
        capabilities: { input: ["text", "image"] },
        variants: [{ id: "low" }, { id: "high" }],
        limit: { context: 400_000 },
      },
      {
        id: "flux",
        providerID: "img",
        name: "Flux",
        type: "image",
        enabled: true,
        capabilities: { input: ["text"] },
        variants: [],
        limit: { context: 0 },
      },
    ];
    assert.deepEqual(modelOptions(models, "openai/gpt-6.1-terra"), [
      {
        id: "openai/gpt-6.1-terra",
        aliases: ["gpt-6.1-terra"],
        label: "GPT-6.1 Terra",
        description: "openai/gpt-6.1-terra",
        efforts: ["low", "high"],
        defaultEffort: null,
        isDefault: true,
      },
    ]);
    assert.equal(findModel(models, "gpt-6.1-terra")?.providerID, "openai");
    assert.equal(findModel(models, "nope"), undefined);
    // A bare ID two providers offer names neither, and a disabled model is not chosen.
    const both = [...models, { ...models[0]!, providerID: "openrouter" }];
    assert.equal(findModel(both, "gpt-6.1-terra"), undefined);
    assert.equal(findModel([{ ...models[0]!, enabled: false }], "openai/gpt-6.1-terra"), undefined);
  });
});
