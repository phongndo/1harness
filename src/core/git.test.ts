import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gitBranch } from "./git.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

describe("gitBranch", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "1harness-git-"));
    mkdirSync(join(root, "app", "src"), { recursive: true });
    git(join(root, "app"), "init", "-q", "-b", "main");
    writeFileSync(join(root, "app", "a"), "");
    git(join(root, "app"), "add", "a");
    git(join(root, "app"), "commit", "-q", "-m", "a");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("gives the branch from any folder in the repository", async () => {
    assert.equal(await gitBranch(join(root, "app", "src")), "main");
  });

  it("gives a worktree's own branch", async () => {
    git(join(root, "app"), "worktree", "add", "-q", "-b", "feat/x", join(root, "feat-x"));
    assert.equal(await gitBranch(join(root, "feat-x")), "feat/x");
  });

  it("gives a detached HEAD's short hash", async () => {
    const sha = git(join(root, "app"), "rev-parse", "HEAD");
    git(join(root, "app"), "worktree", "add", "-q", "--detach", join(root, "loose"));
    assert.equal(await gitBranch(join(root, "loose")), sha.slice(0, 7));
  });

  it("is null outside a repository", async () => {
    mkdirSync(join(root, "plain"));
    assert.equal(await gitBranch(join(root, "plain")), null);
  });
});
