import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
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
});
