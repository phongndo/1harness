import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ScriptedSession } from "../testing/scripted.ts";
import {
  checkHarness,
  findDriver,
  harnessInfo,
  type DriverDefinition,
  type SignIn,
} from "./index.ts";

let root: string;
let made = 0;
// Enough for the fakes' shell; no harness is installed here.
const SYSTEM = "/usr/bin:/bin";

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-drivers-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for a harness's CLI, in a folder of its own so each is a new
 * install: it prints `stdout` and exits with `code`, whatever it is asked.
 */
function fake(name: string, stdout: string, code = 0): { dir: string; path: string } {
  const dir = join(root, String(++made));
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

function registered(id: string): DriverDefinition {
  const found = findDriver(id);
  assert.ok(found, `${id} is registered`);
  return found;
}

describe("each harness's sign-in, asked of its own CLI", () => {
  it("reads Claude Code's auth status", async () => {
    const claude = registered("claude");
    const ask = async (stdout: string, code = 0) =>
      checkHarness(claude, {
        PATH: SYSTEM,
        ONEHARNESS_CLAUDE_PATH: fake("claude", stdout, code).path,
      });
    assert.equal((await ask('{ "loggedIn": true, "authMethod": "claude.ai" }')).state, "ready");
    const out = await ask('{ "loggedIn": false, "apiProvider": "firstParty" }', 1);
    assert.equal(out.state, "signed-out");
    assert.equal(out.detail, "run `claude auth login` to sign in");
    assert.equal(
      out.unavailable,
      "Claude Code is not signed in: run `claude auth login` to sign in",
    );
    // Bedrock and the like sign in with their cloud's credentials, not Claude's.
    assert.equal((await ask('{ "loggedIn": false, "apiProvider": "bedrock" }', 1)).state, "ready");
    const old = await ask("error: unknown command 'auth'", 1);
    assert.equal(old.state, "unchecked");
    assert.equal(old.unavailable, null);
    assert.match(old.detail ?? "", /`claude auth status` did not say .*: error: unknown command/);
  });

  it("reads Codex's login status", async () => {
    const codex = registered("codex");
    const ask = async (stdout: string, code = 0) =>
      checkHarness(codex, {
        PATH: SYSTEM,
        ONEHARNESS_CODEX_PATH: fake("codex", stdout, code).path,
      });
    assert.equal((await ask("Logged in using ChatGPT")).state, "ready");
    const out = await ask("Not logged in", 1);
    assert.equal(out.state, "signed-out");
    assert.equal(out.detail, "run `codex login` to sign in");
    assert.equal((await ask("Error loading configuration", 1)).state, "unchecked");
  });

  it("reads OpenCode's providers, and does not call none signed in a failure", async () => {
    const opencode = registered("opencode");
    const ask = async (stdout: string) =>
      checkHarness(opencode, {
        PATH: SYSTEM,
        ONEHARNESS_OPENCODE_PATH: fake("opencode", stdout).path,
      });
    assert.equal((await ask('[{ "id": "openai", "connections": [] }]')).state, "ready");
    const none = await ask("[]");
    assert.equal(none.state, "unchecked");
    assert.equal(none.unavailable, null);
    assert.match(none.detail ?? "", /only its free models may run; `opencode auth login` adds one/);
  });

  it("reads fx's status, in its own words", async () => {
    const fx = registered("fx");
    const ask = async (stdout: string) =>
      checkHarness(fx, { PATH: `${fake("fx", stdout).dir}:${SYSTEM}` });
    assert.equal((await ask('{ "auth": "Codex subscription" }')).state, "ready");
    const out = await ask('{ "auth": "missing", "auth_help": "Run fx login to sign in." }');
    assert.equal(out.state, "signed-out");
    assert.equal(out.detail, "Run fx login to sign in.");
  });

  it("says a harness with no executable is not installed, without asking it", async () => {
    const info = await checkHarness(registered("codex"), { PATH: "" });
    assert.equal(info.state, "missing");
    assert.equal(info.path, null);
    assert.match(info.unavailable ?? "", /Codex is not installed: no `codex` on PATH/);
  });
});

/** A harness whose sign-in check answers what `answers` gives, counting the times it is asked. */
function counted(answers: () => Promise<SignIn>): {
  driver: DriverDefinition;
  asked: () => number;
} {
  let asked = 0;
  return {
    driver: {
      id: "counted",
      label: "Counted",
      unavailable: () => null,
      executable: () => "/bin/counted",
      signIn: () => {
        asked++;
        return answers();
      },
      create: (options) => new ScriptedSession(options),
    },
    asked: () => asked,
  };
}

describe("checkHarness", () => {
  it("asks a ready harness again only when forced, and any other every time", async () => {
    let answer: SignIn = { state: "signed-out", detail: "run `counted login`" };
    const { driver, asked } = counted(async () => answer);
    assert.equal(harnessInfo(driver, {}).state, "unchecked", "before any check");
    assert.equal((await checkHarness(driver, {})).state, "signed-out");
    assert.equal((await checkHarness(driver, {})).state, "signed-out");
    assert.equal(asked(), 2);
    answer = { state: "ready" };
    assert.equal((await checkHarness(driver, {})).state, "ready");
    assert.equal((await checkHarness(driver, {})).state, "ready");
    assert.equal(asked(), 3);
    assert.equal(harnessInfo(driver, {}).state, "ready", "the last answer, without asking");
    answer = { state: "signed-out", detail: "run `counted login`" };
    assert.equal((await checkHarness(driver, {}, true)).state, "signed-out");
    assert.equal(asked(), 4);
  });

  it("asks once for checks made together", async () => {
    let answer!: (signIn: SignIn) => void;
    const { driver, asked } = counted(() => new Promise((resolve) => (answer = resolve)));
    const both = Promise.all([checkHarness(driver, {}), checkHarness(driver, {})]);
    answer({ state: "ready" });
    assert.deepEqual(
      (await both).map((info) => info.state),
      ["ready", "ready"],
    );
    assert.equal(asked(), 1);
  });

  it("says why it could not ask, and lets the harness run", async () => {
    const { driver } = counted(async () => {
      throw new Error("spawn EACCES");
    });
    const info = await checkHarness(driver, {});
    assert.equal(info.state, "unchecked");
    assert.equal(info.unavailable, null);
    assert.equal(info.detail, "could not ask Counted whether it is signed in: spawn EACCES");
  });
});
