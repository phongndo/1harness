import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Long enough to check out a large repository; a hook may run as well. */
const GIT_TIMEOUT_MS = 5 * 60_000;

/** A git worktree 1harness made for one delegated thread. */
export interface Worktree {
  path: string;
  branch: string;
  /** The commit it started from, which tells an agent's commits from what it was given. */
  base: string;
  /** The repository's shared git folder, which outlives every worktree of it. */
  repo: string;
}

/** Set in a git hook, where they would aim every command here at the hook's repository. */
const HOOK_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

function git(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !HOOK_ENV.has(name)),
  );
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

/** Where a branch points, or null without one. */
function branchTip(repo: string, branch: string): Promise<string | null> {
  return git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
}

/** The shared git folder of the repository `cwd` is in, or null outside one. */
export function gitRepository(cwd: string): Promise<string | null> {
  return git(cwd, ["rev-parse", "--git-common-dir"]).then(
    (folder) => resolve(cwd, folder),
    () => null,
  );
}

/**
 * Makes a worktree at `path` on a new branch from `cwd`'s HEAD. When it fails,
 * nothing of it stays, and the error says why.
 */
export async function addWorktree(
  cwd: string,
  repo: string,
  path: string,
  branch: string,
): Promise<Worktree> {
  const base = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => {
    throw new Error(`${cwd} has no commit to start a branch from`);
  });
  // Another's, such as a kept worktree's with the same short ID, so undoing must not touch it.
  if ((await branchTip(repo, branch)) !== null) throw new Error(`${branch} already exists`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const worktree = { path, branch, base, repo };
  try {
    await git(cwd, ["worktree", "add", "-b", branch, path, base]);
  } catch (error) {
    // Git undoes its own failures, but not a post-checkout hook's: the worktree is finished by then.
    const left = await releaseWorktree(worktree);
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(left ? `${said} (${path} stays: ${left})` : said, { cause: error });
  }
  return worktree;
}

/**
 * Removes a worktree and its branch if they hold no work. Returns null once
 * they are gone, and otherwise why they stay, which is also the answer whenever
 * git cannot tell: an agent's work is worth more than the room it takes. Ignored
 * files do not count as work, as they do not for git, or every worktree that
 * ever installed its dependencies would stay.
 */
export async function releaseWorktree(worktree: Worktree): Promise<string | null> {
  const { path, branch, base, repo } = worktree;
  try {
    const present = existsSync(path);
    if (present) {
      // Said outright, as `status.showUntrackedFiles` could hide them, even from git's own check.
      const status = await git(path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      if (status) return "it has uncommitted changes";
      // An agent may have moved to another branch, or to no branch, and committed there.
      if ((await git(path, ["rev-parse", "HEAD"])) !== base) return "it has commits";
    }
    const tip = await branchTip(repo, branch);
    if (tip !== null && tip !== base) return "its branch has commits";
    // Never forced: git refuses what it finds unsafe, and that refusal is kept as the reason.
    await git(repo, ["worktree", "remove", path]).catch((error: unknown) => {
      if (present) throw error;
    });
    // Not `branch -d`, which asks whether HEAD of the main checkout has the commits and so
    // refuses a branch with nothing on it there. This deletes the branch only while it is at
    // `base`, however it may have moved since the check above.
    if (tip !== null) await git(repo, ["update-ref", "-d", `refs/heads/${branch}`, base]);
    return null;
  } catch (error) {
    return `git said: ${error instanceof Error ? error.message : String(error)}`;
  }
}
