import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import type { CommandContext, Report } from "../commands/registry.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { Host } from "./host.ts";

let root: string;
let host: Host;
let unregister: () => void;
let made = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-context-"));
  unregister = registerScripted();
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  config: string;
  state: string;
  cwd: string;
  person: HostClient;
}

function setup(options: { settings?: object; modules?: string[] } = {}): Setup {
  const dir = join(root, String(++made));
  const config = join(dir, "config");
  const state = join(dir, "state");
  const cwd = join(dir, "work");
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ harness: "scripted", ...options.settings }),
  );
  host = new Host({
    version: "test",
    cwd,
    configDir: config,
    stateDir: state,
    idleCloseMs: 0,
    store: null,
    extensions: options.modules ?? [],
  });
  const person = new HostClient(
    new LocalConnection(host, `person-${made}`, { owns: false }),
    { cwd, version: "test", extensions: options.modules ?? [] },
    `person-${made}`,
  );
  return { config, state, cwd, person };
}

async function toolNames(config: { url: string; headers: Record<string, string> }) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...config.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

const op = async (person: HostClient, name: string, input: Record<string, unknown>) =>
  (await person.call("operations.call", { name, input })).result as Record<string, unknown>;

describe("thread_context", () => {
  it("says what 1harness adds to a thread, in tokens it can only estimate", async () => {
    const { person, cwd } = setup();
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    const found = (await op(person, "thread_context", { threadId: thread.id })) as {
      harness: string;
      tools: { name: string; source: string; tokens: number; offered: boolean }[];
      toolTokens: number;
      servers: string[];
      handoffTokens: number;
    };
    assert.equal(found.harness, "scripted");
    const delegate = found.tools.find((tool) => tool.name === "delegate_task");
    assert.equal(delegate?.source, "1harness");
    assert.ok((delegate?.tokens ?? 0) > 50);
    assert.equal(delegate?.offered, true);
    assert.equal(
      found.toolTokens,
      found.tools.reduce((sum, tool) => sum + tool.tokens, 0),
    );
    assert.deepEqual(found.servers, ["1harness"]);
    assert.equal(found.handoffTokens, 0);
  });

  it("is not a tool for agents in threads, which would add to what it measures", async () => {
    setup();
    const grant = await host.tools.grant();
    assert.ok(grant && grant.config.type === "http");
    const names = await toolNames(grant.config);
    grant.revoke();
    assert.equal(names.includes("thread_context"), false);
    assert.equal(names.includes("tools_set"), false);
    assert.ok(names.includes("delegate_task"));
  });
});

describe("turning tools off", () => {
  it("keeps one tool from sessions, in settings.json, and can bring it back", async () => {
    const { person, config } = setup();
    await op(person, "tools_set", { enabled: false, tool: "delegate_task" });
    assert.deepEqual(
      (JSON.parse(readFileSync(join(config, "settings.json"), "utf8")) as Record<string, unknown>)[
        "disabledTools"
      ],
      ["delegate_task"],
    );
    // Other settings stay.
    assert.equal(
      (JSON.parse(readFileSync(join(config, "settings.json"), "utf8")) as Record<string, unknown>)[
        "harness"
      ],
      "scripted",
    );
    let grant = await host.tools.grant();
    assert.ok(grant && grant.config.type === "http");
    let names = await toolNames(grant.config);
    assert.equal(names.includes("delegate_task"), false);
    assert.ok(names.includes("thread_read"));
    grant.revoke();

    await op(person, "tools_set", { enabled: true, tool: "delegate_task" });
    grant = await host.tools.grant();
    assert.ok(grant && grant.config.type === "http");
    names = await toolNames(grant.config);
    assert.ok(names.includes("delegate_task"));
    grant.revoke();
  });

  it("with all of them off, sessions get no 1harness server at all", async () => {
    const { person, cwd } = setup();
    await op(person, "tools_set", { enabled: false });
    assert.equal(await host.tools.grant(), null);
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    const found = (await op(person, "thread_context", { threadId: thread.id })) as {
      servers: string[];
      toolTokens: number;
    };
    assert.deepEqual(found.servers, []);
    assert.equal(found.toolTokens, 0);
    // One tool cannot come back while all are off, since the setting cannot say so.
    await assert.rejects(
      op(person, "tools_set", { enabled: true, tool: "thread_read" }),
      /every tool is off/,
    );
    await op(person, "tools_set", { enabled: true });
    assert.ok(await host.tools.grant());
  });

  it("is for people alone, not agents outside 1harness", async () => {
    const { cwd } = setup();
    const outside = new HostClient(
      new LocalConnection(host, "outside", { owns: false }),
      { cwd, version: "test", extensions: [], agent: true },
      "outside",
    );
    await outside.call("client.hello", {
      cwd,
      version: "test",
      extensions: [],
      agent: true,
    } as never);
    await assert.rejects(op(outside, "tools_set", { enabled: false }), /not_allowed|for people/);
  });
});

function context(person: HostClient, id: string | null) {
  const reports: Report[] = [];
  const notices: string[] = [];
  const value = {
    thread: id ? { id } : null,
    ui: {
      report: (report: Report) => reports.push(report),
      notify: (_level: string, text: string) => notices.push(text),
    },
    runOperation: async (name: string, input: Record<string, unknown>) =>
      (await person.call("operations.call", { name, input })).result,
  } as unknown as CommandContext;
  return { value, reports, notices };
}

describe("/context", () => {
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === "context")!;

  it("reports the tools and servers, and needs a thread", async () => {
    const { person, cwd } = setup();
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    const { value, reports } = context(person, thread.id);
    assert.equal(command.available?.(value), true);
    assert.equal(command.available?.(context(person, null).value), false);
    await command.run(value, "");
    const text = (reports[0]?.lines ?? [])
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n");
    assert.match(text, /^Tools {2}\d+ of \d+, ~[\d,]+ tokens/);
    assert.match(text, /delegate_task +1harness, ~\d+/);
    assert.match(text, /MCP servers {2}1harness/);
    assert.match(text, /Waiting handoff {2}none/);
    assert.match(text, /not counted/);
  });

  it("turns tools off and on, and refuses other words", async () => {
    const { person, cwd, config } = setup();
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    const { value, notices, reports } = context(person, thread.id);
    const saved = () =>
      (JSON.parse(readFileSync(join(config, "settings.json"), "utf8")) as Record<string, unknown>)[
        "disabledTools"
      ];
    await command.run(value, "off delegate_task");
    assert.deepEqual(saved(), ["delegate_task"]);
    assert.match(notices[0] ?? "", /delegate_task not offered from now on; \/reload/);
    await command.run(value, "");
    const text = (reports[0]?.lines ?? [])
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n");
    assert.match(text, /delegate_task +1harness, off/);
    await command.run(value, "on");
    assert.deepEqual(saved(), []);
    await assert.rejects(Promise.resolve(command.run(value, "sideways")), /Usage: \/context/);
  });
});
