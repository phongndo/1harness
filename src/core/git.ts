import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The branch checked out where `cwd` is, or the commit's short hash when HEAD
 * is detached; null outside a repository. It reads `.git` itself, since this
 * runs on every turn and the host may have no git installed.
 */
export async function gitBranch(cwd: string): Promise<string | null> {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const found = await gitDir(folder);
    if (found) {
      const head = await readFile(join(found, "HEAD"), "utf8").catch(() => null);
      if (head === null) return null;
      return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1] ?? head.trim().slice(0, 7);
    }
    if (dirname(folder) === folder) return null;
  }
}

/** The git folder for a checkout at `folder`: `.git`, or where a worktree's `.git` file points. */
async function gitDir(folder: string): Promise<string | null> {
  const dotGit = join(folder, ".git");
  const found = await stat(dotGit).catch(() => null);
  if (!found) return null;
  if (found.isDirectory()) return dotGit;
  const pointer = await readFile(dotGit, "utf8").catch(() => "");
  const target = /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim();
  return target ? resolve(folder, target) : null;
}
