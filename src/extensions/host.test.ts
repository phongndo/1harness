import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { CommandRegistry, type CommandUI } from "../commands/registry.ts";
import { AsyncQueue } from "../core/async-queue.ts";
import type {
  ApprovalRequest,
  HarnessEvent,
  HarnessSession,
  RequestResponse,
  UserInput,
} from "../core/events.ts";
import { Thread } from "../core/thread.ts";
import { ExtensionHost } from "./host.ts";

class FakeSession {
  readonly capabilities = {
    steer: false,
    planMode: false,
    runtimeModes: [],
    images: false,
    nativeSlashCommands: false,
    mcpActions: [],
  };
  readonly info = { harness: "fake", threadId: "t", cwd: "/", model: null, effort: null };
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly turns: string[] = [];
  readonly responses: [string, RequestResponse][] = [];
  async start(): Promise<void> {}
  async startTurn(input: UserInput): Promise<void> {
    this.turns.push(input.text);
  }
  async respond(id: string, response: RequestResponse): Promise<void> {
    this.responses.push([id, response]);
  }
  async close(): Promise<void> {
    this.events.end();
  }
}

function approval(command: string): ApprovalRequest {
  return {
    kind: "approval",
    id: `r-${command}`,
    title: "Run?",
    detail: "",
    action: { type: "command", command, cwd: null },
    options: [
      { id: "yes", label: "Yes", effect: "allow" },
      { id: "no", label: "No", effect: "deny" },
    ],
    defaultOptionId: "yes",
  };
}

const settle = () => new Promise((done) => setTimeout(done, 20));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "1harness-ext-"));
  const notices: string[] = [];
  const ui = {
    notify: (_level: string, text: string) => notices.push(text),
  } as unknown as CommandUI;
  const commands = new CommandRegistry();
  const host = new ExtensionHost({
    cwd: join(root, "project"),
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    commands,
    ui,
  });
  return { root, notices, commands, host };
}

const tool = (name: string) =>
  ({
    type: "item.completed",
    item: {
      kind: "tool_call",
      id: name,
      tool: name,
      server: null,
      category: "other",
      summary: "",
      output: "",
      status: "completed",
    },
  }) as HarnessEvent;

const skill = (folder: string, name: string, description: string) => {
  mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, name, "SKILL.md"), `---\ndescription: ${description}\n---\nBody.`);
};

describe("what extensions reach", () => {
  it("refuses a shortcut it cannot have, and the extension says so", async () => {
    const { root, notices, host, commands } = setup();
    try {
      mkdirSync(join(root, "config", "extensions"), { recursive: true });
      writeFileSync(
        join(root, "config", "extensions", "greedy.ts"),
        `export default function (api) {
          api.registerCommand({ name: "greedy", description: "", group: "T", shortcut: "ctrl+c", run() {} });
        }`,
      );
      await host.loadAll();
      assert.equal(host.extensions[0]?.error, "ctrl+c is already taken");
      assert.equal(commands.find("greedy"), undefined);
      assert.match(notices[0] ?? "", /greedy did not load/);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says operations are not available where nothing offers them", async () => {
    const { root, host } = setup();
    try {
      mkdirSync(join(root, "config", "extensions"), { recursive: true });
      writeFileSync(
        join(root, "config", "extensions", "caller.ts"),
        `export let call;
        export default function (api) { call = api.runOperation; }`,
      );
      await host.loadAll();
      const module = (await import(
        pathToFileURL(join(root, "config", "extensions", "caller.ts")).href
      )) as { call: (name: string) => Promise<unknown> };
      await assert.rejects(module.call("thread_list"), /not available here/);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives handlers the thread's ID, and lets renderers choose a tool call's line", async () => {
    const { root, notices, host } = setup();
    try {
      mkdirSync(join(root, "config", "extensions"), { recursive: true });
      writeFileSync(
        join(root, "config", "extensions", "drawn.ts"),
        `export default function (api) {
          api.registerToolRenderer((item) => {
            if (item.tool === "broken") throw new Error("no line");
            return undefined;
          });
          api.registerToolRenderer((item) => item.tool === "broken" || item.tool === "search" ? "Searched" : undefined);
          api.on("turn.ended", (_event, context) => api.storage.set("from", context.threadId));
        }`,
      );
      await host.loadAll();
      const session = new FakeSession();
      const thread = new Thread(session as unknown as HarnessSession);
      const seen: unknown[] = [];
      thread.subscribe((event) => {
        if (event.type === "item.completed") seen.push(event.item);
      });
      const detach = host.attach(thread, "thread-1");
      await thread.start();
      session.events.push(tool("search"));
      session.events.push(tool("broken"));
      session.events.push(tool("other"));
      session.events.push({ type: "turn.started", turnId: "t" });
      session.events.push({ type: "turn.ended", turnId: "t", status: "completed", error: null });
      await settle();
      const shown = (seen as { tool: string; display?: string }[]).map(
        ({ tool: name, display }) => [name, display],
      );
      assert.deepEqual(shown, [
        ["search", "Searched"],
        // One renderer failing leaves the call to the next, and says so.
        ["broken", "Searched"],
        ["other", undefined],
      ]);
      assert.ok(notices.some((notice) => /drawn failed: no line/.test(notice)));
      const stored = JSON.parse(
        readFileSync(join(root, "state", "extensions", "drawn.json"), "utf8"),
      ) as { from: string };
      assert.equal(stored.from, "thread-1");
      detach();
      await thread.close();
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a user's own skill over a package's, and skills from an untrusted folder out", async () => {
    const { root, host } = setup();
    try {
      skill(join(root, "config", "skills"), "tidy", "Mine");
      skill(join(root, "tools", "skills"), "tidy", "The package's");
      skill(join(root, "tools", "skills"), "sweep", "Sweeps");
      skill(join(root, "project", ".1harness", "skills"), "local", "The folder's");
      writeFileSync(
        join(root, "config", "packages.json"),
        JSON.stringify({ packages: [join(root, "tools")] }),
      );
      await host.loadAll();
      const offered = () => host.skills.map(({ name, description }) => [name, description]);
      assert.deepEqual(offered(), [
        ["tidy", "Mine"],
        ["sweep", "Sweeps"],
      ]);
      await host.trustProject();
      assert.deepEqual(offered(), [
        ["tidy", "Mine"],
        ["sweep", "Sweeps"],
        ["local", "The folder's"],
      ]);
      assert.equal(host.tools.get("skill_read")?.extension, "1harness");
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ExtensionHost", () => {
  it("loads an extension and connects its commands, storage, and handlers", async () => {
    const { root, notices, commands, host } = setup();
    try {
      const folder = join(root, "config", "extensions");
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "shout.ts"),
        `export default function (api) {
          api.storage.set("loaded", true);
          api.registerCommand({ name: "shout", description: "", group: "Fun", run() {} });
          api.onInput((input) => (input.text === "drop" ? null : { text: input.text.toUpperCase() }));
          api.on("turn.started", (event, context) => context.ui.notify("info", "started " + event.turnId));
          api.onRequest((request) => api.choose(request, "deny"));
        }`,
      );
      await host.loadAll();
      assert.deepEqual(
        host.extensions.map((extension) => [extension.name, extension.error]),
        [["shout", null]],
      );
      assert.ok(commands.find("shout"));

      const session = new FakeSession();
      const thread = new Thread(session as unknown as HarnessSession);
      host.attach(thread);
      const opened: string[] = [];
      thread.subscribe((event) => {
        if (event.type === "request.opened") opened.push(event.request.id);
      });
      await thread.start();
      thread.send({ text: "drop" });
      thread.send({ text: "hello" });
      await settle();
      assert.deepEqual(session.turns, ["HELLO"]);
      session.events.push({ type: "turn.started", turnId: "t1" });
      session.events.push({ type: "request.opened", request: approval("ls") });
      await settle();
      assert.deepEqual(notices, ["started t1"]);
      assert.deepEqual(session.responses, [["r-ls", { kind: "approval", optionId: "no" }]]);
      assert.deepEqual(opened, [], "an answered request never reaches clients");
      await thread.close();

      const stored = JSON.parse(
        readFileSync(join(root, "state", "extensions", "shout.json"), "utf8"),
      );
      assert.deepEqual(stored, { loaded: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for trust before loading a folder's own extensions", async () => {
    const { root, host } = setup();
    try {
      const folder = join(root, "project", ".1harness", "extensions");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "local.js"), "export default function () {}");
      await host.loadAll();
      assert.equal(host.extensions.length, 0);
      assert.equal(host.untrusted.length, 1);
      await host.trustProject();
      assert.deepEqual(
        host.extensions.map((extension) => extension.scope),
        ["project"],
      );
      assert.equal(host.untrusted.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the approval rules example on any harness's requests", async () => {
    const { root, host } = setup();
    try {
      await host.load({ path: resolve("examples/extensions/approval-rules.ts"), scope: "flag" });
      const session = new FakeSession();
      const thread = new Thread(session as unknown as HarnessSession);
      host.attach(thread);
      const opened: string[] = [];
      thread.subscribe((event) => {
        if (event.type === "request.opened") opened.push(event.request.id);
      });
      await thread.start();
      session.events.push({ type: "request.opened", request: approval("sudo rm -rf /") });
      session.events.push({ type: "request.opened", request: approval("ls") });
      await settle();
      const [[id, response] = []] = session.responses;
      assert.equal(id, "r-sudo rm -rf /");
      assert.equal(response?.kind, "decline", "the agent goes on without it");
      assert.deepEqual(opened, ["r-ls"], "a command no rule matches still asks");
      await thread.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a tool policy from the extensions that check tool calls", async () => {
    const { root, host } = setup();
    try {
      assert.equal(
        host.toolPolicy(() => null),
        undefined,
        "none without a checking extension",
      );
      await host.load({ path: resolve("examples/extensions/approval-rules.ts"), scope: "flag" });
      const thread = {} as Thread;
      const policy = host.toolPolicy(() => thread);
      assert.ok(policy);
      const check = (command: string) =>
        policy({
          tool: "Bash",
          input: { command },
          action: { type: "command", command, cwd: null },
        });
      assert.match((await check("sudo reboot")) ?? "", /blocks commands matching/);
      assert.equal(await check("ls"), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets an extension outside the repo import 1harness/extension", async () => {
    const { root, host } = setup();
    try {
      const folder = join(root, "config", "extensions");
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "outside.ts"),
        `import { choose } from "1harness/extension";
        export default function (api) { api.storage.set("choose", typeof choose); }`,
      );
      await host.loadAll();
      assert.equal(host.extensions[0]?.error, null);
      const stored = JSON.parse(
        readFileSync(join(root, "state", "extensions", "outside.json"), "utf8"),
      );
      assert.deepEqual(stored, { choose: "function" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reloads edited extensions, undoing what the old copy registered", async () => {
    const { root, commands, host } = setup();
    try {
      const folder = join(root, "config", "extensions");
      mkdirSync(folder, { recursive: true });
      const write = (command: string) =>
        writeFileSync(
          join(folder, "live.ts"),
          `export default function (api) {
            api.registerCommand({ name: "${command}", description: "", group: "Fun", run() {} });
            api.onUnload(() => api.storage.set("unloaded", "${command}"));
          }`,
        );
      write("first");
      await host.loadAll();
      assert.ok(commands.find("first"));
      write("second");
      await host.reload();
      assert.equal(commands.find("first"), undefined, "the old command is gone");
      assert.ok(commands.find("second"));
      assert.equal(host.extensions.length, 1);
      const stored = JSON.parse(
        readFileSync(join(root, "state", "extensions", "live.json"), "utf8"),
      );
      assert.equal(stored.unloaded, "first", "the old copy cleaned up");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers operations, serving the ones agents in threads may call as tools", async () => {
    const { root, host } = setup();
    try {
      const folder = join(root, "config", "extensions");
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "ops.ts"),
        `export default function (api) {
          const schema = { type: "object", properties: {} };
          api.registerOperation({ name: "everyone", description: "", inputSchema: schema,
            run: (_input, { caller }) => caller.kind });
          api.registerOperation({ name: "people", description: "", inputSchema: schema,
            effect: "read", callers: ["user"], run: () => "ok" });
          api.registerTool({ name: "tool", description: "", inputSchema: schema, execute: () => "t" });
        }`,
      );
      await host.loadAll();
      assert.equal(host.extensions[0]?.error, null);
      assert.deepEqual([...host.operations.keys()].toSorted(), ["everyone", "people", "tool"]);
      assert.deepEqual([...host.tools.keys()].toSorted(), ["everyone", "tool"]);
      const everyone = host.operations.get("everyone")!.operation;
      assert.deepEqual([everyone.effect, everyone.callers], ["act", ["user", "agent", "external"]]);
      assert.deepEqual(host.operations.get("tool")!.operation.callers, ["agent"]);
      assert.equal(
        await host.operations
          .get("everyone")!
          .operation.run({}, { caller: { kind: "user", clientId: "c" } }),
        "user",
      );
      assert.match(JSON.stringify(host.report()), /tool tool.*op everyone, op people/);
      await host.reload();
      assert.equal(host.operations.size, 3, "a reload registers them once");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
