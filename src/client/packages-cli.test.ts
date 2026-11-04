import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { packagesCommand } from "./packages-cli.ts";

let root: string;
let dirs: { configDir: string; stateDir: string; cwd: string };

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-packages-cli-"));
  dirs = { configDir: join(root, "config"), stateDir: join(root, "state"), cwd: root };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await packagesCommand(args, dirs, (text) => {
    out += text;
  });
  return { code, out };
}

describe("1harness packages", () => {
  it("installs, lists, and removes a package", async () => {
    const folder = join(root, "tools");
    mkdirSync(join(folder, "skills", "tidy"), { recursive: true });
    mkdirSync(join(folder, "extensions"), { recursive: true });
    writeFileSync(join(folder, "package.json"), '{ "name": "tools", "version": "2.0.0" }');
    writeFileSync(join(folder, "extensions", "a.ts"), "export default function () {}\n");
    writeFileSync(join(folder, "extensions", "b.ts"), "export default function () {}\n");
    writeFileSync(join(folder, "skills", "tidy", "SKILL.md"), "---\ndescription: T\n---\nT.");

    assert.match((await run()).out, /No packages/);

    const installed = await run("install", "./tools");
    assert.equal(installed.code, 0);
    assert.match(installed.out, /Installed tools \(2 extensions and skills\)/);
    assert.match(installed.out, /\/extensions reload/);

    assert.match((await run("ls")).out, /^tools 2\.0\.0 {2}2 extensions and skills {2}.*tools\n$/);
    const [listed] = JSON.parse((await run("--json")).out) as { source: string }[];
    assert.equal(listed?.source, folder);

    assert.match((await run("update", "tools")).out, /Updated tools/);

    const removed = await run("remove", "tools");
    assert.equal(removed.code, 0);
    assert.match(removed.out, /Removed /);
    assert.match((await run()).out, /No packages/);
  });

  it("shows its help, and fails on what it does not know", async () => {
    assert.match((await run("--help")).out, /Usage: 1harness packages/);
    assert.equal((await run("--help")).code, 0);
    assert.equal((await run("frobnicate")).code, 1);
    assert.equal((await run("install")).code, 1);
    assert.equal((await run("remove")).code, 1);
    assert.equal((await run("install", "a", "b")).code, 1);
  });

  it("says why a package cannot be read, and fails", async () => {
    mkdirSync(dirs.configDir, { recursive: true });
    writeFileSync(
      join(dirs.configDir, "packages.json"),
      JSON.stringify({ packages: ["npm:not-fetched@1.0.0"] }),
    );
    const { code, out } = await run();
    assert.equal(code, 1);
    assert.match(out, /npm:not-fetched@1\.0\.0: not fetched/);
    rmSync(join(dirs.configDir, "packages.json"));
  });
});
