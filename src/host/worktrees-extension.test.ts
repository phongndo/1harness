import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { registerDriver } from "../drivers/index.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { Store } from "../store/store.ts";
import { registerScripted, ScriptedSession, scriptedSettings } from "../testing/scripted.ts";
import { Host } from "./host.ts";
import type { ManagedThread } from "./manager.ts";

// Worktrees are the proof of the extension API: everything here goes through what
// any extension has, against real git, with nothing in core that knows of them.

const EXTENSION = resolve(import.meta.dirname, "../../examples/extensions/worktrees.ts");

interface Task {
  threadId: string;
  status: string;
  worktree: { path: string; branch: string };
}

interface Listed {
  path: string;
  branch: string;
  state: string;
  kept: string | null;
}

let root: string;
let host: Host | null = null;
let person: HostClient;
let undo: (() => void)[] = [];
let count = 0;
const previousState = process.env["XDG_STATE_HOME"];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function folder(): string {
  const path = join(root, `folder-${++count}`);
  mkdirSync(path);
  return realpathSync(path);
}

function newRepo(): string {
  const repo = folder();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README"), "first\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

interface Dirs {
  state: string;
  config: string;
}

function startHost(cwd: string, dirs: Dirs, store: Store | null = null): Host {
  host = new Host({
    version: "test",
    cwd,
    store,
    configDir: dirs.config,
    stateDir: dirs.state,
    idleCloseMs: 0,
  });
  person = new HostClient(
    new LocalConnection(host, `person-${++count}`, { owns: false }),
    { cwd, version: "test", extensions: [] },
    `person-${count}`,
  );
  return host;
}

const parentIn = (cwd: string) =>
  host!.manager.create({
    harness: "scripted",
    settings: { ...scriptedSettings, cwd },
    title: "parent",
  });

const toolOf = (thread: ManagedThread, name: string) => {
  const found = host!.manager.extensionsOf(thread.id)?.tools.get(name);
  assert.ok(found, `no tool ${name}`);
  return found.tool;
};

async function inWorktree(
  parent: ManagedThread,
  input: Record<string, unknown> = {},
): Promise<Task> {
  const output = await toolOf(parent, "delegate_in_worktree").execute(
    { task: "do it", ...input },
    { thread: parent.thread },
  );
  return JSON.parse(String(output)) as Task;
}

const worktrees = async (clean = false) =>
  (await person.call("operations.call", { name: "worktrees", input: { clean } }))
    .result as Listed[];

const close = (threadId: string) => host!.manager.close(threadId);

function assertNothingLeft(repo: string): void {
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert.equal(git(repo, "branch", "--list", "1h/*"), "");
}

/** A config folder the extension was copied to, as a user installs it, so restarts keep it. */
function dirsNew(): Dirs {
  const dirs = { state: folder(), config: folder() };
  mkdirSync(join(dirs.config, "extensions"));
  copyFileSync(EXTENSION, join(dirs.config, "extensions", "worktrees.ts"));
  return dirs;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-worktrees-"));
  undo = [
    registerScripted(),
    registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) =>
        Object.assign(new ScriptedSession(options), {
          start: () => Promise.reject(new Error("the harness would not start")),
        }),
    }),
  ];
});

beforeEach(() => {
  process.env["XDG_STATE_HOME"] = folder();
});

afterEach(async () => {
  await host?.shutdown();
  host = null;
});

after(() => {
  if (previousState === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = previousState;
  for (const stop of undo) stop();
  rmSync(root, { recursive: true, force: true });
});

describe("delegating in a worktree", () => {
  it("is a choice: delegate_task stays in the caller's folder", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const parent = await parentIn(repo);
    const tool = host!.orchestrator.tools.find((entry) => entry.name === "delegate_task")!;
    const { threadId } = JSON.parse(
      String(
        await tool.execute({ task: "do it", role: "implementation" }, { thread: parent.thread }),
      ),
    ) as Task;
    assert.equal(host!.manager.get(threadId)!.thread.info.cwd, repo);
  });

  it("gives no agent a way to choose a folder", async () => {
    const repo = newRepo();
    const elsewhere = folder();
    startHost(repo, dirsNew());
    const parent = await parentIn(repo);
    const tool = host!.orchestrator.tools.find((entry) => entry.name === "delegate_task")!;
    assert.equal("cwd" in (tool.inputSchema["properties"] as object), false);
    const { threadId } = JSON.parse(
      String(await tool.execute({ task: "do it", cwd: elsewhere }, { thread: parent.thread })),
    ) as Task;
    assert.equal(host!.manager.get(threadId)!.thread.info.cwd, repo);
    const direct = await inWorktree(parent, { cwd: elsewhere });
    assert.equal(host!.manager.get(direct.threadId)!.thread.info.cwd, direct.worktree.path);
  });

  it("starts from the caller's HEAD, without its uncommitted changes, and briefs the agent", async () => {
    const repo = newRepo();
    writeFileSync(join(repo, "README"), "changed\n");
    writeFileSync(join(repo, "new"), "new\n");
    startHost(repo, dirsNew());
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    assert.equal(host!.manager.get(threadId)!.thread.info.cwd, worktree.path);
    assert.equal(git(worktree.path, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
    assert.equal(git(worktree.path, "branch", "--show-current"), worktree.branch);
    assert.equal(readFileSync(join(worktree.path, "README"), "utf8"), "first\n");
    assert.equal(existsSync(join(worktree.path, "new")), false);
    const brief = host!.manager.get(threadId)!.runs[0]!.input;
    assert.match(brief, /^do it\n/);
    assert.match(brief, /do not work around it/);
  });

  it("keeps parallel children apart, and out of the caller's folder", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const parent = await parentIn(repo);
    const tasks = await Promise.all([inWorktree(parent), inWorktree(parent), inWorktree(parent)]);
    assert.equal(new Set(tasks.map(({ worktree }) => worktree.path)).size, 3);
    assert.equal(new Set(tasks.map(({ worktree }) => worktree.branch)).size, 3);
    assert.equal(git(repo, "branch", "--show-current"), "main");
  });

  it("returns at once when asked to, with the worktree's place", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const task = await inWorktree(await parentIn(repo), { wait: false });
    assert.equal(existsSync(task.worktree.path), true);
  });
});

describe("a delegation that cannot start", () => {
  it("fails outside a repository, saying why", async () => {
    const plain = folder();
    startHost(plain, dirsNew());
    await assert.rejects(inWorktree(await parentIn(plain)), /not in a git repository/);
    assert.deepEqual(await worktrees(), []);
  });

  it("fails in a repository with no commit, leaving nothing", async () => {
    const repo = folder();
    git(repo, "init", "-q", "-b", "main");
    startHost(repo, dirsNew());
    await assert.rejects(inWorktree(await parentIn(repo)), /single revision/);
    assert.deepEqual(await worktrees(), []);
  });

  it("undoes a worktree whose post-checkout hook fails, which git leaves behind", async () => {
    const repo = newRepo();
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    startHost(repo, dirsNew());
    await assert.rejects(inWorktree(await parentIn(repo)), /Preparing worktree/);
    assertNothingLeft(repo);
    assert.deepEqual(await worktrees(), []);
  });

  it("gives the worktree back when the harness cannot start", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    await assert.rejects(
      inWorktree(await parentIn(repo), { harness: "broken" }),
      /would not start/,
    );
    assertNothingLeft(repo);
    assert.deepEqual(await worktrees(), []);
  });
});

describe("cleaning up", () => {
  it("leaves a worktree an open thread still works in", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { worktree } = await inWorktree(await parentIn(repo));
    const [entry] = await worktrees(true);
    assert.equal(entry!.state, "in use");
    assert.equal(existsSync(worktree.path), true);
  });

  it("leaves one while any other thread works there", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    const other = await parentIn(worktree.path);
    await close(threadId);
    assert.equal((await worktrees(true))[0]!.state, "in use");
    await close(other.id);
    assert.equal((await worktrees(true))[0]!.state, "removed");
  });

  it("removes a clean worktree and its branch once its thread closes", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { threadId } = await inWorktree(await parentIn(repo));
    await close(threadId);
    assert.equal((await worktrees(true))[0]!.state, "removed");
    assertNothingLeft(repo);
    assert.deepEqual(await worktrees(), []);
  });

  it("removes it though the main checkout has moved to another branch", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { threadId } = await inWorktree(await parentIn(repo));
    git(repo, "switch", "-q", "-c", "elsewhere");
    writeFileSync(join(repo, "more"), "more\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "more");
    await close(threadId);
    assert.equal((await worktrees(true))[0]!.state, "removed");
    assertNothingLeft(repo);
  });

  const work: [string, string, (path: string) => void][] = [
    ["an untracked file", "uncommitted", (path) => writeFileSync(join(path, "new"), "new\n")],
    ["a changed file", "uncommitted", (path) => writeFileSync(join(path, "README"), "changed\n")],
    [
      "untracked files git is set to hide",
      "uncommitted",
      (path) => {
        git(path, "config", "status.showUntrackedFiles", "no");
        writeFileSync(join(path, "hidden"), "hidden\n");
      },
    ],
    [
      "a commit",
      "commits",
      (path) => {
        writeFileSync(join(path, "new"), "new\n");
        git(path, "add", ".");
        git(path, "commit", "-q", "-m", "work");
      },
    ],
    [
      "a commit on its branch, checked out elsewhere",
      "commits",
      (path) => {
        writeFileSync(join(path, "new"), "new\n");
        git(path, "add", ".");
        git(path, "commit", "-q", "-m", "work");
        git(path, "checkout", "-q", "--detach", "HEAD~1");
      },
    ],
  ];
  for (const [what, reason, make] of work)
    it(`keeps a worktree with ${what}, and says so`, async () => {
      const repo = newRepo();
      startHost(repo, dirsNew());
      const { threadId, worktree } = await inWorktree(await parentIn(repo));
      make(worktree.path);
      await close(threadId);
      const [entry] = await worktrees(true);
      assert.equal(entry!.state, "kept");
      assert.match(entry!.kept!, new RegExp(reason));
      assert.equal(existsSync(worktree.path), true);
      assert.ok(git(repo, "branch", "--list", worktree.branch));
      assert.equal((await worktrees()).length, 1);
    });

  it("does not count ignored files as work, as git does not", async () => {
    const repo = newRepo();
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "ignore");
    startHost(repo, dirsNew());
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    mkdirSync(join(worktree.path, "node_modules"));
    writeFileSync(join(worktree.path, "node_modules", "dep"), "dep\n");
    await close(threadId);
    assert.equal((await worktrees(true))[0]!.state, "removed");
    assert.equal(existsSync(worktree.path), false);
  });

  it("is not stopped by a worktree someone already removed", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    await close(threadId);
    git(repo, "worktree", "remove", worktree.path);
    assert.equal((await worktrees(true))[0]!.state, "removed");
    assertNothingLeft(repo);
  });

  it("keeps the branch of a worktree someone removed once it has commits", async () => {
    const repo = newRepo();
    startHost(repo, dirsNew());
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    writeFileSync(join(worktree.path, "new"), "new\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-q", "-m", "work");
    await close(threadId);
    git(repo, "worktree", "remove", worktree.path);
    const [entry] = await worktrees(true);
    assert.match(entry!.kept!, /its branch has commits/);
    assert.ok(git(repo, "branch", "--list", worktree.branch));
  });

  it("reaches worktrees made from another folder, whose storage is its own object", async () => {
    const first = newRepo();
    const second = newRepo();
    const dirs = dirsNew();
    startHost(first, dirs);
    await inWorktree(await parentIn(first));
    await inWorktree(await parentIn(second));
    await inWorktree(await parentIn(first));
    assert.equal((await worktrees()).length, 3);
  });
});

async function project() {
  const repo = newRepo();
  mkdirSync(join(repo, ".1harness", "extensions"), { recursive: true });
  writeFileSync(
    join(repo, ".1harness", "mcp.json"),
    JSON.stringify({ mcpServers: { project: { command: "true" } } }),
  );
  writeFileSync(join(repo, ".1harness", "extensions", "own.mjs"), "export default () => {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "project");
  const dirs = dirsNew();
  const owner = new ExtensionHost({
    cwd: repo,
    configDir: dirs.config,
    stateDir: dirs.state,
    commands: null,
    ui: null,
  });
  await owner.trustProject();
  await owner.close();
  return { repo, dirs, file: join(dirs.state, "store.db") };
}

async function restart(repo: string, dirs: Dirs, file: string): Promise<void> {
  await host!.shutdown();
  startHost(repo, dirs, Store.open(file));
  await host!.start();
}

describe("a trusted folder's extensions and MCP servers", () => {
  it("reach a child in its worktree, before and after a restart, and list only the folder trusted", async () => {
    const { repo, dirs, file } = await project();
    startHost(repo, dirs, Store.open(file));
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    assert.ok(host!.manager.extensionsOf(threadId)!.trusted);
    assert.ok(host!.manager.serversOf(threadId).includes("project"));

    await restart(repo, dirs, file);
    assert.ok(host!.manager.extensionsOf(threadId)!.trusted);
    await host!.manager.wake(threadId);
    assert.ok(host!.manager.serversOf(threadId).includes("project"));
    assert.equal(host!.manager.get(threadId)!.thread.info.cwd, worktree.path);
    const { folders } = JSON.parse(readFileSync(join(dirs.state, "trusted.json"), "utf8")) as {
      folders: string[];
    };
    assert.deepEqual(folders, [repo]);
  });

  it("do not come from what an agent wrote in its worktree", async () => {
    const { repo, dirs, file } = await project();
    startHost(repo, dirs, Store.open(file));
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    writeFileSync(
      join(worktree.path, ".1harness", "mcp.json"),
      JSON.stringify({ mcpServers: { planted: { command: "true" } } }),
    );
    await restart(repo, dirs, file);
    await host!.manager.wake(threadId);
    const servers = host!.manager.serversOf(threadId);
    assert.ok(servers.includes("project"));
    assert.equal(servers.includes("planted"), false);
  });

  it("stay out of a thread opened by hand in a worktree", async () => {
    const { repo, dirs, file } = await project();
    startHost(repo, dirs, Store.open(file));
    const { worktree } = await inWorktree(await parentIn(repo));
    const byHand = await parentIn(worktree.path);
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
    await byHand.thread.send({ text: "stay" });
    await new Promise((done) => setTimeout(done, 20));
    await restart(repo, dirs, file);
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
  });

  it("keep a worktree in use across a restart, and clean it once the thread closes", async () => {
    const { repo, dirs, file } = await project();
    startHost(repo, dirs, Store.open(file));
    const { threadId, worktree } = await inWorktree(await parentIn(repo));
    await restart(repo, dirs, file);
    assert.equal((await worktrees(true))[0]!.state, "in use");
    assert.equal(existsSync(worktree.path), true);
    await host!.manager.close(threadId);
    assert.equal((await worktrees(true))[0]!.state, "removed");
    assertNothingLeft(repo);
    assert.deepEqual(
      readdirSync(join(process.env["XDG_STATE_HOME"]!, "1harness", "worktrees")),
      [],
    );
  });
});
