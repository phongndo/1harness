// Gives delegated agents git worktrees of their own, so agents writing at once
// cannot overwrite each other. Agents call `delegate_in_worktree`, which starts
// a task as `delegate_task` does, on a new branch from their HEAD.
//
//   /worktrees         list them, and whether a thread still works in each
//   /worktrees clean   remove those no open thread works in and that hold no work
//
// Removing is never forced: anything uncommitted, or any commit, keeps a worktree
// and its branch until you merge or delete them yourself. Ignored files do not
// count as work, as they do not for git, or every worktree that installed its
// dependencies would stay. A sandboxed agent may not be able to commit, since a
// worktree's git data is in the repository's `.git`; it is told to leave its
// changes in place and say so.
//
// Load it with `1harness -x examples/extensions/worktrees.ts`, or copy it to
// ~/.config/1harness/extensions/.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "1harness/extension";

const GIT_TIMEOUT_MS = 5 * 60_000;

interface Worktree {
  path: string;
  branch: string;
  /** The commit it started from, which tells an agent's commits from what it was given. */
  base: string;
  /** The repository's shared git folder, which outlives every worktree of it. */
  repo: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  // A server started from a git hook has these set, and they would aim git at that repository.
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) fail(new Error(stderr.trim() || error.message));
        else done(stdout.trim());
      },
    );
  });
}

/** Why a worktree stays, or null once it and its branch are gone. Unsure means it stays. */
async function release({ path, branch, base, repo }: Worktree): Promise<string | null> {
  try {
    const present = existsSync(path);
    if (present) {
      // Said outright, as settings could hide changes from this, and from git's own check.
      const status = await git(path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      if (status) return "it has uncommitted changes";
      if ((await git(path, ["rev-parse", "HEAD"])) !== base) return "it has commits";
    }
    const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(
      () => null,
    );
    if (tip !== null && tip !== base) return "its branch has commits";
    if (present) await git(repo, ["worktree", "remove", path]);
    else await git(repo, ["worktree", "prune"]);
    // Deleted only while it is still at `base`, in case it has moved since the check above.
    if (tip !== null) await git(repo, ["update-ref", "-d", `refs/heads/${branch}`, base]);
    return null;
  } catch (error) {
    return `git said: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function folder(): string {
  const path = join(
    process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"),
    "1harness",
    "worktrees",
  );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Harnesses report real paths, and in-use checks compare with those.
  return realpathSync(path);
}

export default function worktrees(api: ExtensionAPI): void {
  /** Ones being set up, which no thread works in yet. */
  const starting = new Set<string>();

  api.registerTool({
    name: "delegate_in_worktree",
    description:
      "Hands a task to another agent, as delegate_task does, in a git worktree and branch of its own, so agents writing at once cannot overwrite each other. Uncommitted changes do not come along. Takes delegate_task's input; the result names the worktree's path and branch, for you to review and merge.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to do, with the context it needs." },
        harness: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        title: { type: "string" },
        role: { type: "string" },
        wait: { type: "boolean" },
        timeoutSeconds: { type: "number" },
        runtimeMode: { type: "string" },
        plan: { type: "boolean" },
      },
      required: ["task"],
    },
    // Whoever loads this wants agents to reach for it, and they would not search for it.
    direct: true,
    execute: async (input, { thread, callId }) => {
      const { cwd } = thread.info;
      const repo = resolve(
        cwd,
        await git(cwd, ["rev-parse", "--git-common-dir"]).catch(() => {
          throw new Error(`${cwd} is not in a git repository`);
        }),
      );
      const base = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const id = randomBytes(4).toString("hex");
      const worktree = { path: join(folder(), id), branch: `1h/${id}`, base, repo };
      // Saved first, so that nothing a crash leaves behind goes unlisted.
      api.storage.set(id, worktree);
      starting.add(id);
      try {
        await git(cwd, ["worktree", "add", "-b", worktree.branch, worktree.path, base]);
        const brief = `${String(input["task"])}\n\nYou work in a git worktree of your own, on branch ${worktree.branch}, which the agent that gave you this reviews and merges. Commit your work there. If a sandbox stops git from committing, do not work around it: leave your changes in place and say so.`;
        const task = await api.delegate(
          thread,
          { ...input, task: brief },
          { cwd: worktree.path, ...(callId ? { callId } : {}) },
        );
        return JSON.stringify(
          { ...(task as object), worktree: { path: worktree.path, branch: worktree.branch } },
          null,
          2,
        );
      } catch (error) {
        // Nothing ran there. Git undoes its own failures but not a post-checkout hook's.
        if ((await release(worktree)) === null) api.storage.delete(id);
        throw error;
      } finally {
        starting.delete(id);
      }
    },
  });

  const list = async (clean: boolean) => {
    const { threads } = (await api.runOperation("thread_list")) as {
      threads: { cwd: string; status: string }[];
    };
    const used = new Set(threads.filter(({ status }) => status !== "closed").map(({ cwd }) => cwd));
    const entries = [];
    for (const id of api.storage.keys()) {
      const worktree = api.storage.get<Worktree>(id);
      if (!worktree) continue;
      const inUse = starting.has(id) || used.has(worktree.path);
      let state = inUse ? "in use" : "finished";
      let kept: string | null = null;
      if (clean && !inUse) {
        kept = await release(worktree);
        if (kept === null) {
          api.storage.delete(id);
          state = "removed";
        } else state = "kept";
      }
      entries.push({ path: worktree.path, branch: worktree.branch, state, kept });
    }
    return entries;
  };

  api.registerOperation({
    name: "worktrees",
    description:
      "Lists the worktrees delegated agents work in. With clean, removes those no open thread works in and that hold no work, and says why any others stay.",
    inputSchema: { type: "object", properties: { clean: { type: "boolean" } } },
    callers: ["user", "external"],
    run: (input) => list(input["clean"] === true),
  });

  api.registerCommand({
    name: "worktrees",
    usage: "[clean]",
    description: "list the worktrees delegated agents work in, or remove those done with",
    group: "Tools",
    run: async (context, args) => {
      const entries = await list(args.trim() === "clean");
      context.ui.report({
        title: "Worktrees",
        lines:
          entries.length > 0
            ? entries.map(({ branch, state, kept, path }) => [
                { text: `${branch}  `, tone: "strong" as const },
                { text: `${kept ? `kept: ${kept}` : state}  ${path}`, tone: "soft" as const },
              ])
            : [[{ text: "None", tone: "muted" as const }]],
      });
    },
  });
}
