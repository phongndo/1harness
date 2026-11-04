import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { Host } from "./host.ts";

let root: string;
let host: Host;
let unregister: () => void;
let made = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-skills-host-"));
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

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Never saw ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
};

function withSkill(config: string): void {
  mkdirSync(join(config, "skills", "tidy"), { recursive: true });
  writeFileSync(
    join(config, "skills", "tidy", "SKILL.md"),
    "---\ndescription: Tidies a file\n---\nTidy it.\n",
  );
}

describe("skills", () => {
  it("go to agents through a tool only once there are any, and to people through /skill", async () => {
    const empty = setup();
    const none = await empty.person.call("skills.list", { threadId: null });
    assert.deepEqual(none, []);
    const quiet = await empty.person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd: empty.cwd },
    });
    assert.equal(host.manager.extensionsOf(quiet.id)?.tools.has("skill_read"), false);
    await host.shutdown();

    const dir = join(root, String(++made));
    const config = join(dir, "config");
    const cwd = join(dir, "work");
    mkdirSync(config, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    withSkill(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ harness: "scripted" }));
    host = new Host({
      version: "test",
      cwd,
      configDir: config,
      stateDir: join(dir, "state"),
      idleCloseMs: 0,
      store: null,
    });
    const person = new HostClient(
      new LocalConnection(host, "p", { owns: false }),
      { cwd, version: "test", extensions: [] },
      "p",
    );
    assert.deepEqual(await person.call("skills.list", { threadId: null }), [
      { name: "tidy", description: "Tidies a file" },
    ]);
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    assert.equal(
      host.manager.extensionsOf(thread.id)?.tools.get("skill_read")?.extension,
      "1harness",
    );

    await person.call("commands.run", {
      threadId: thread.id,
      name: "skill",
      args: "tidy the parser",
    });
    await until(() => (host.manager.get(thread.id)?.runs.length ?? 0) > 0, "the skill's turn");
    const input = host.manager.get(thread.id)!.runs[0]!.input;
    assert.match(input, /^<skill name="tidy"/);
    assert.match(input, /Tidy it\./);
    assert.ok(input.endsWith("the parser"));
    await assert.rejects(
      person.call("commands.run", { threadId: thread.id, name: "skill", args: "nope" }),
      /No skill nope/,
    );
  });
});
