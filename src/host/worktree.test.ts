import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import type { UserInput } from "../core/events.ts";
import { shortThreadId } from "../core/thread-id.ts";
import { registerDriver } from "../drivers/index.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { Store } from "../store/store.ts";
import { ScriptedSession, scriptedSettings } from "../testing/scripted.ts";
import { Host } from "./host.ts";
import type { ManagedThread } from "./manager.ts";
import { threadView } from "./orchestrator.ts";

/** A harness that does what an agent would: a message's `WRITE name` lines make files in its folder. */
class WritingSession extends ScriptedSession {
  override async startTurn(input: UserInput): Promise<void> {
    for (const [, name] of input.text.matchAll(/^WRITE (\S+)$/gm))
      writeFileSync(join(this.options.cwd, name!), `${name}\n`);
    return super.startTurn(input);
  }
}

interface TaskResult {
  threadId: string;
  status: string;
  worktree?: { path: string; branch: string };
}

let root: string;
let host: Host | null = null;
let unregister: (() => void)[] = [];
let count = 0;

/** Git as a person would run it in a folder, or the folder's repository. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A new folder, by its real path, as harnesses and git report it. */
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

const newDirs = (): Dirs => ({ state: folder(), config: folder() });

function startHost(dirs: Dirs, store: Store | null = null, retainClosedDays?: number): Host {
  host = new Host({
    version: "test",
    cwd: root,
    store,
    configDir: dirs.config,
    stateDir: dirs.state,
    idleCloseMs: 0,
    ...(retainClosedDays ? { retainClosedDays } : {}),
  });
  return host;
}

const parentIn = (cwd: string, title = "parent") =>
  host!.manager.create({ harness: "writing", settings: { ...scriptedSettings, cwd }, title });

async function delegate(
  parent: ManagedThread,
  input: Record<string, unknown>,
): Promise<TaskResult> {
  const tool = host!.orchestrator.tools.find((candidate) => candidate.name === "delegate_task")!;
  const output = await tool.execute({ task: "do it", ...input }, { thread: parent.thread });
  return JSON.parse(String(output)) as TaskResult;
}

const cwdOf = (id: string) => host!.manager.get(id)!.thread.info.cwd;
const forget = (threadId: string) => host!.call("tui", "thread.forget", { threadId });

/** Everything a delegation could have left in a repository and the state folder. */
function assertNothingLeft(repo: string, dirs: Dirs): void {
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  assert.equal(git(repo, "branch", "--list", "1h/*"), "");
  const worktrees = join(dirs.state, "worktrees");
  if (existsSync(worktrees)) assert.deepEqual(readdirSync(worktrees), []);
}

async function assertFails(repo: string, dirs: Dirs, why: RegExp): Promise<void> {
  const parent = await parentIn(repo);
  const threads = host!.manager.list().length;
  await assert.rejects(delegate(parent, { isolation: "worktree" }), (error: Error) => {
    assert.match(error.message, /^worktree_failed: /);
    assert.match(error.message, why);
    return true;
  });
  assert.equal(host!.manager.list().length, threads);
  assertNothingLeft(repo, dirs);
}

async function child(repo: string, dirs: Dirs, store: Store | null = null) {
  startHost(dirs, store);
  const parent = await parentIn(repo);
  const task = await delegate(parent, { isolation: "worktree" });
  return { parent, id: task.threadId, ...task.worktree! };
}

async function afterRetention(dirs: Dirs, file: string, check: () => Promise<void>) {
  const now = Date.now;
  const later = now() + 2 * 86_400_000;
  Date.now = () => later;
  try {
    startHost(dirs, Store.open(file), 1);
    await host!.start();
    await check();
  } finally {
    Date.now = now;
  }
}

/** A folder with an extension and an MCP server of its own, and hosts that trust it or not. */
async function project(trust: boolean) {
  const repo = newRepo();
  mkdirSync(join(repo, ".1harness", "extensions"), { recursive: true });
  writeFileSync(
    join(repo, ".1harness", "mcp.json"),
    JSON.stringify({ mcpServers: { project: { command: "true" } } }),
  );
  writeFileSync(join(repo, ".1harness", "extensions", "own.mjs"), "export default () => {};\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "project");
  const dirs = newDirs();
  if (trust) {
    const owner = new ExtensionHost({
      cwd: repo,
      configDir: dirs.config,
      stateDir: dirs.state,
      commands: null,
      ui: null,
    });
    await owner.trustProject();
    await owner.close();
  }
  const trustList = () =>
    JSON.parse(readFileSync(join(dirs.state, "trusted.json"), "utf8")) as { folders: string[] };
  return { repo, dirs, file: join(dirs.state, "store.db"), trustList };
}

const hasProject = (id: string) =>
  host!.manager.extensionsOf(id)!.extensions.some((extension) => extension.scope === "project");

async function restart(dirs: Dirs, file: string): Promise<void> {
  await host!.shutdown();
  startHost(dirs, Store.open(file));
  await host!.start();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-worktree-"));
  unregister = [
    registerDriver({
      id: "writing",
      label: "Writing",
      unavailable: () => null,
      create: (options) => new WritingSession(options),
    }),
    registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) =>
        Object.assign(new WritingSession(options), {
          start: () => Promise.reject(new Error("the harness would not start")),
        }),
    }),
  ];
});

afterEach(async () => {
  await host?.shutdown();
  host = null;
});

after(() => {
  for (const undo of unregister) undo();
  rmSync(root, { recursive: true, force: true });
});

describe("where delegate_task puts a task", () => {
  it("makes a worktree when asked, on a branch of its own", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    startHost(dirs);
    const parent = await parentIn(repo);
    const task = await delegate(parent, { isolation: "worktree" });
    const expected = join(dirs.state, "worktrees", task.threadId);
    assert.deepEqual(task.worktree, {
      path: expected,
      branch: `1h/${shortThreadId(task.threadId)}`,
    });
    assert.equal(cwdOf(task.threadId), expected);
    assert.equal(git(expected, "branch", "--show-current"), task.worktree!.branch);
    assert.deepEqual(threadView(host!.manager.get(task.threadId)!).worktree, task.worktree);
    const session = host!.manager.get(task.threadId)!.thread.session as unknown as ScriptedSession;
    assert.match(session.prompts[0]!, new RegExp(`on branch ${task.worktree!.branch}`));
    // A sandbox can refuse the repository's shared git folder, which is outside the worktree.
    assert.match(
      session.prompts[0]!,
      /If a sandbox stops git from committing, do not work around it/,
    );
  });

  it("stays in the caller's folder unless asked, whatever the role", async () => {
    const repo = newRepo();
    startHost(newDirs());
    const parent = await parentIn(repo);
    for (const role of [
      undefined,
      "implementation",
      "research",
      "review",
      "design",
      "test",
      "general",
    ]) {
      const task = await delegate(parent, role ? { role } : {});
      assert.equal(task.worktree, undefined, role);
      assert.equal(cwdOf(task.threadId), repo, role);
      assert.equal(threadView(host!.manager.get(task.threadId)!).worktree, undefined);
    }
    assert.equal(git(repo, "branch", "--list", "1h/*"), "");
  });

  it("stays in the caller's folder outside a repository", async () => {
    const plain = folder();
    startHost(newDirs());
    const task = await delegate(await parentIn(plain), {});
    assert.equal(task.worktree, undefined);
    assert.equal(cwdOf(task.threadId), plain);
  });

  it("takes the choice it is given, for any role", async () => {
    const repo = newRepo();
    startHost(newDirs());
    const parent = await parentIn(repo);
    const shared = await delegate(parent, { isolation: "shared" });
    assert.equal(shared.worktree, undefined);
    assert.equal(cwdOf(shared.threadId), repo);
    const own = await delegate(parent, { role: "review", isolation: "worktree" });
    assert.ok(own.worktree);
    assert.equal(cwdOf(own.threadId), own.worktree.path);
  });

  it("refuses an explicit worktree outside a repository, and an unknown isolation", async () => {
    const plain = folder();
    startHost(newDirs());
    const parent = await parentIn(plain);
    const threads = host!.manager.list().length;
    await assert.rejects(delegate(parent, { isolation: "worktree" }), /^Error: invalid_request/);
    await assert.rejects(delegate(parent, { isolation: "cloud" }), /^Error: invalid_request/);
    assert.equal(host!.manager.list().length, threads);
  });

  it("starts from the caller's HEAD, without its uncommitted changes", async () => {
    const repo = newRepo();
    startHost(newDirs());
    const parent = await parentIn(repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "second");
    writeFileSync(join(repo, "README"), "changed\n");
    writeFileSync(join(repo, "untracked"), "new\n");
    const { worktree } = await delegate(parent, { isolation: "worktree" });
    assert.equal(git(worktree!.path, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(worktree!.path, "README"), "utf8"), "first\n");
    assert.equal(existsSync(join(worktree!.path, "untracked")), false);
  });

  it("keeps parallel children apart, and out of the caller's folder", async () => {
    const repo = newRepo();
    startHost(newDirs());
    const parent = await parentIn(repo);
    const [a, b] = await Promise.all(
      ["a", "b"].map((name) =>
        delegate(parent, { isolation: "worktree", task: `WRITE ${name}\nnow` }),
      ),
    );
    assert.notEqual(a!.worktree!.path, b!.worktree!.path);
    assert.notEqual(a!.worktree!.branch, b!.worktree!.branch);
    assert.equal(a!.status, "completed");
    assert.equal(b!.status, "completed");
    assert.ok(existsSync(join(a!.worktree!.path, "a")));
    assert.equal(existsSync(join(a!.worktree!.path, "b")), false);
    assert.ok(existsSync(join(b!.worktree!.path, "b")));
    assert.equal(existsSync(join(b!.worktree!.path, "a")), false);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  it("tells a parent that did not wait where the work is", async () => {
    const repo = newRepo();
    startHost(newDirs());
    const parent = await parentIn(repo);
    const task = await delegate(parent, { isolation: "worktree", wait: false });
    assert.ok(task.worktree);
    const session = parent.thread.session as unknown as ScriptedSession;
    const deadline = Date.now() + 2000;
    while (session.prompts.length === 0 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 2));
    assert.ok(session.prompts[0]?.includes(task.worktree.path));
    assert.ok(session.prompts[0]?.includes(task.worktree.branch));
  });
});

describe("a delegation whose worktree cannot be made", () => {
  it("fails when git refuses the branch, leaving nothing", async () => {
    const repo = newRepo();
    // A branch named 1h leaves no room for branches under 1h/.
    git(repo, "branch", "1h");
    const dirs = newDirs();
    startHost(dirs);
    await assertFails(repo, dirs, /1h\//);
  });

  it("undoes a worktree whose post-checkout hook fails, which git leaves behind", async () => {
    const repo = newRepo();
    const hook = join(repo, ".git", "hooks", "post-checkout");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const dirs = newDirs();
    startHost(dirs);
    await assertFails(repo, dirs, /hook refused/);
  });

  it("fails in a repository with no commit, leaving nothing", async () => {
    const repo = folder();
    git(repo, "init", "-q", "-b", "main");
    const dirs = newDirs();
    startHost(dirs);
    const parent = await parentIn(repo);
    await assert.rejects(delegate(parent, { isolation: "worktree" }), /no commit/);
    assert.equal(git(repo, "branch", "--list", "1h/*"), "");
    assert.equal(existsSync(join(dirs.state, "worktrees")), false);
  });

  it("fails when the state folder has no room for it", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    writeFileSync(join(dirs.state, "worktrees"), "in the way");
    startHost(dirs);
    const parent = await parentIn(repo);
    await assert.rejects(delegate(parent, { isolation: "worktree" }), /^Error: worktree_failed/);
    assert.equal(git(repo, "branch", "--list", "1h/*"), "");
  });

  it("gives the worktree back when the harness cannot start", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    startHost(dirs);
    const parent = await parentIn(repo);
    await assert.rejects(
      delegate(parent, { isolation: "worktree", harness: "broken" }),
      /would not start/,
    );
    assertNothingLeft(repo, dirs);
    const failed = host!.manager.list().find((thread) => thread.harness === "broken");
    assert.equal(failed?.worktree, null);
  });
});

describe("when a thread with a worktree is forgotten", () => {
  it("removes a clean worktree and its branch", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const { id, path } = await child(repo, dirs);
    const result = await forget(id);
    assert.deepEqual(result, { forgotten: [id] });
    assert.equal(existsSync(path), false);
    assertNothingLeft(repo, dirs);
  });

  it("removes it though the main checkout has moved to another branch", async () => {
    const repo = newRepo();
    git(repo, "checkout", "-q", "-b", "feature");
    git(repo, "commit", "-q", "--allow-empty", "-m", "only on feature");
    const dirs = newDirs();
    const { id } = await child(repo, dirs);
    git(repo, "checkout", "-q", "main");
    assert.deepEqual(await forget(id), { forgotten: [id] });
    assertNothingLeft(repo, dirs);
  });

  it("removes the worktrees of the threads it started too", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const { parent } = await child(repo, dirs);
    const second = await delegate(parent, { isolation: "worktree" });
    const inner = await delegate(host!.manager.get(second.threadId)!, { isolation: "worktree" });
    const { forgotten } = await forget(parent.id);
    assert.equal(forgotten.length, 4);
    assert.ok(forgotten.includes(inner.threadId));
    assertNothingLeft(repo, dirs);
  });

  const keeps: [string, RegExp, (path: string) => void][] = [
    [
      "a change to a tracked file",
      /uncommitted/,
      (path) => writeFileSync(join(path, "README"), "changed\n"),
    ],
    [
      "a staged file",
      /uncommitted/,
      (path) => {
        writeFileSync(join(path, "staged"), "new\n");
        git(path, "add", "staged");
      },
    ],
    ["an untracked file", /uncommitted/, (path) => writeFileSync(join(path, "new"), "new\n")],
    [
      "an untracked file git is told not to show",
      /uncommitted/,
      (path) => {
        git(path, "config", "status.showUntrackedFiles", "no");
        writeFileSync(join(path, "hidden"), "new\n");
      },
    ],
    [
      "a commit on its branch",
      /commits/,
      (path) => {
        git(path, "commit", "-q", "--allow-empty", "-m", "work");
      },
    ],
    [
      "a commit on another branch",
      /commits/,
      (path) => {
        git(path, "checkout", "-q", "-b", "elsewhere");
        git(path, "commit", "-q", "--allow-empty", "-m", "work");
      },
    ],
    [
      "a commit on no branch",
      /commits/,
      (path) => {
        git(path, "checkout", "-q", "--detach");
        git(path, "commit", "-q", "--allow-empty", "-m", "work");
      },
    ],
    [
      "a commit on its branch while another is checked out",
      /commits/,
      (path) => {
        const branch = git(path, "branch", "--show-current");
        const start = git(path, "rev-parse", "HEAD");
        git(path, "commit", "-q", "--allow-empty", "-m", "work");
        git(path, "checkout", "-q", "--detach", start);
        assert.notEqual(git(path, "rev-parse", branch), start);
      },
    ],
  ];
  for (const [what, why, work] of keeps)
    it(`keeps a worktree with ${what}, and says so`, async () => {
      const repo = newRepo();
      const dirs = newDirs();
      const { id, path, branch } = await child(repo, dirs);
      work(path);
      const status = git(path, "status", "--porcelain", "--untracked-files=all");
      const head = git(path, "rev-parse", "HEAD");
      const tip = git(repo, "rev-parse", branch);
      const { forgotten, keptWorktrees } = await forget(id);
      assert.deepEqual(forgotten, [id]);
      assert.equal(keptWorktrees?.length, 1);
      assert.equal(keptWorktrees![0]!.threadId, id);
      assert.equal(keptWorktrees![0]!.path, path);
      assert.equal(keptWorktrees![0]!.branch, branch);
      assert.match(keptWorktrees![0]!.reason, why);
      // All of it is still there, untouched.
      assert.equal(git(path, "status", "--porcelain", "--untracked-files=all"), status);
      assert.equal(git(path, "rev-parse", "HEAD"), head);
      assert.equal(git(repo, "rev-parse", branch), tip);
      assert.ok(git(repo, "worktree", "list").includes(path));
    });

  it("keeps a worktree another thread still works in", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const { id, path } = await child(repo, dirs);
    // Opened there by hand, as a fork of the thread would be.
    await parentIn(path, "by hand");
    const { keptWorktrees } = await forget(id);
    assert.match(keptWorktrees![0]!.reason, /works there too/);
    assert.ok(existsSync(path));
  });

  it("is not stopped by a worktree someone already removed", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const { id, path } = await child(repo, dirs);
    git(repo, "worktree", "remove", path);
    assert.deepEqual(await forget(id), { forgotten: [id] });
    assertNothingLeft(repo, dirs);
  });

  it("keeps the branch of a worktree someone removed once it has commits", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const { id, path, branch } = await child(repo, dirs);
    git(path, "commit", "-q", "--allow-empty", "-m", "work");
    const tip = git(path, "rev-parse", "HEAD");
    git(repo, "worktree", "remove", path);
    const { keptWorktrees } = await forget(id);
    assert.match(keptWorktrees![0]!.reason, /commits/);
    assert.equal(git(repo, "rev-parse", branch), tip);
  });

  describe("by retention", () => {
    it("removes a clean worktree with its thread", async () => {
      const repo = newRepo();
      const dirs = newDirs();
      const file = join(dirs.state, "store.db");
      const { parent, id, path } = await child(repo, dirs, Store.open(file));
      await host!.call("tui", "thread.close", { threadId: parent.id });
      await host!.shutdown();
      await afterRetention(dirs, file, async () => {
        assert.equal(existsSync(path), false);
        assertNothingLeft(repo, dirs);
        await assert.rejects(forget(id), /No thread/);
      });
    });

    for (const [what, work] of [
      ["uncommitted changes", (path: string) => writeFileSync(join(path, "new"), "new\n")],
      ["commits", (path: string) => git(path, "commit", "-q", "--allow-empty", "-m", "work")],
    ] as const)
      it(`keeps a worktree with ${what}, its thread to say where, and says so`, async () => {
        const said = mock.method(console, "error", () => {});
        try {
          const repo = newRepo();
          const dirs = newDirs();
          const file = join(dirs.state, "store.db");
          const { parent, id, path, branch } = await child(repo, dirs, Store.open(file));
          work(path);
          await host!.call("tui", "thread.close", { threadId: parent.id });
          await host!.shutdown();
          await afterRetention(dirs, file, async () => {
            assert.ok(existsSync(path));
            assert.ok(git(repo, "rev-parse", branch));
            const listed = await host!.call("tui", "threads.list", { scope: "recent" });
            assert.ok(listed.some((thread) => thread.id === id));
            const line = String(said.mock.calls.at(-1)?.arguments[0]);
            assert.ok(line.includes(path));
            assert.ok(line.includes(branch));
          });
        } finally {
          said.mock.restore();
        }
      });
  });
});

describe("across a restart", () => {
  it("keeps a thread's worktree, and working in it", async () => {
    const repo = newRepo();
    const dirs = newDirs();
    const file = join(dirs.state, "store.db");
    startHost(dirs, Store.open(file));
    const parent = await parentIn(repo);
    const task = await delegate(parent, { isolation: "worktree" });
    await host!.shutdown();

    startHost(dirs, Store.open(file));
    await host!.start();
    const restored = host!.manager.get(task.threadId)!;
    assert.deepEqual(threadView(restored).worktree, task.worktree);
    assert.equal(restored.thread.info.cwd, task.worktree!.path);

    // Still there once it has left memory for the store.
    await host!.call("tui", "thread.close", { threadId: parent.id });
    await new Promise((done) => setTimeout(done, 20));
    const stored = await host!.operations
      .find((operation) => operation.name === "thread_read")!
      .run({ threadId: task.threadId }, { caller: { kind: "user", clientId: "tui" } });
    assert.deepEqual((stored as { worktree: unknown }).worktree, task.worktree);
    await host!.shutdown();

    // And cleaned up by a host that did not make it.
    startHost(dirs, Store.open(file));
    assert.deepEqual(await forget(parent.id), { forgotten: [parent.id, task.threadId] });
    assertNothingLeft(repo, dirs);
  });
});

describe("a trusted folder's extensions and MCP servers", () => {
  it("reach a child in a worktree of a trusted folder, before and after a restart", async () => {
    const { repo, dirs, file, trustList } = await project(true);
    startHost(dirs, Store.open(file));
    const parent = await parentIn(repo);
    const { threadId, worktree } = await delegate(parent, { isolation: "worktree" });
    assert.ok(hasProject(threadId));
    assert.ok(host!.manager.extensionsOf(threadId)!.trusted);
    assert.ok(host!.manager.serversOf(threadId).includes("project"));

    await restart(dirs, file);
    assert.ok(hasProject(threadId));
    assert.ok(host!.manager.extensionsOf(threadId)!.trusted);
    await host!.manager.wake(threadId);
    assert.ok(host!.manager.serversOf(threadId).includes("project"));
    assert.equal(cwdOf(threadId), worktree!.path);
    // Inherited, not granted: the list names only the folder the user trusted.
    assert.deepEqual(trustList().folders, [repo]);
  });

  it("reach threads a worktree's thread started, in it or in one of their own", async () => {
    const { repo, dirs, file } = await project(true);
    startHost(dirs, Store.open(file));
    const first = await delegate(await parentIn(repo), { isolation: "worktree" });
    const inChild = host!.manager.get(first.threadId)!;
    const shared = await delegate(inChild, { isolation: "shared" });
    const nested = await delegate(inChild, { isolation: "worktree" });
    assert.equal(cwdOf(shared.threadId), first.worktree!.path);
    await restart(dirs, file);
    for (const id of [first.threadId, shared.threadId, nested.threadId])
      assert.ok(host!.manager.extensionsOf(id)!.trusted, id);
  });

  it("do not come from what an agent wrote in its worktree", async () => {
    const { repo, dirs, file } = await project(true);
    startHost(dirs, Store.open(file));
    const { threadId, worktree } = await delegate(await parentIn(repo), {
      isolation: "worktree",
    });
    writeFileSync(
      join(worktree!.path, ".1harness", "mcp.json"),
      JSON.stringify({ mcpServers: { planted: { command: "true" } } }),
    );
    await restart(dirs, file);
    await host!.manager.wake(threadId);
    const servers = host!.manager.serversOf(threadId);
    assert.ok(servers.includes("project"));
    assert.equal(servers.includes("planted"), false);
  });

  it("stay out of a child of a folder that is not trusted", async () => {
    const { repo, dirs, file } = await project(false);
    startHost(dirs, Store.open(file));
    const { threadId } = await delegate(await parentIn(repo), { isolation: "worktree" });
    const check = () => {
      assert.equal(hasProject(threadId), false);
      assert.equal(host!.manager.extensionsOf(threadId)!.trusted, false);
    };
    check();
    await restart(dirs, file);
    check();
    await host!.manager.wake(threadId);
    assert.equal(host!.manager.serversOf(threadId).includes("project"), false);
  });

  it("stay out of a thread opened by hand in 1harness's own worktree", async () => {
    const { repo, dirs, file } = await project(true);
    startHost(dirs, Store.open(file));
    const first = await delegate(await parentIn(repo), { isolation: "worktree" });
    const byHand = await parentIn(first.worktree!.path, "by hand");
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
    await byHand.thread.send({ text: "stay" });
    await new Promise((done) => setTimeout(done, 20));
    await restart(dirs, file);
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
  });

  it("stay out of a worktree of the trusted folder that 1harness did not make", async () => {
    const { repo, dirs, file } = await project(true);
    startHost(dirs, Store.open(file));
    const made = join(folder(), "by-hand");
    git(repo, "worktree", "add", "-q", "-b", "by-hand", made);
    const byHand = await parentIn(made, "by hand");
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
    // Nor when something started under a trusted thread claims that folder as its own.
    const parent = await parentIn(repo);
    const claimed = await host!.manager.create({
      harness: "writing",
      settings: { ...scriptedSettings, cwd: made },
      parentId: parent.id,
      title: "claims it",
    });
    await restart(dirs, file);
    assert.equal(host!.manager.extensionsOf(byHand.id)!.trusted, false);
    assert.equal(host!.manager.extensionsOf(claimed.id)!.trusted, false);
    git(repo, "worktree", "remove", made);
  });
});
