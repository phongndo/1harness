import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { CommandRegistry } from "../commands/registry.ts";
import { ExtensionHost } from "./host.ts";
import {
  installedPackages,
  installPackage,
  parseSource,
  readPackage,
  removePackage,
  sourceText,
  updatePackages,
  type Runner,
} from "./packages.ts";

let root: string;
let dirs: { configDir: string; stateDir: string; cwd: string };
let made = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-packages-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const dir = join(root, String(++made));
  dirs = { configDir: join(dir, "config"), stateDir: join(dir, "state"), cwd: dir };
  mkdirSync(dir);
});

const EXTENSION = `export default function (api: import("1harness/extension").ExtensionAPI) {
  api.registerCommand({ name: "hello", description: "says hello", group: "Tools", run() {} });
}
`;
const failing: Runner = async () => {
  throw new Error("the network is down");
};
const SKILL = "---\nname: tidy\ndescription: Tidies a file\n---\nTidy it.\n";

/** A package in a folder, written in TypeScript as extensions usually are. */
function write(files: Record<string, string>): string {
  const folder = join(dirs.cwd, `package-${++made}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
  return folder;
}

const TOOLS = {
  "package.json": JSON.stringify({ name: "@you/tools", version: "1.2.0", type: "module" }),
  "extensions/hello.ts": EXTENSION,
  "skills/tidy/SKILL.md": SKILL,
};

describe("parseSource", () => {
  it("reads npm, git, and folder sources, and keeps them so they read back", () => {
    const cases: [string, ReturnType<typeof parseSource>, string][] = [
      ["npm:@you/tools@1.2.0", { kind: "npm", spec: "@you/tools@1.2.0" }, "npm:@you/tools@1.2.0"],
      [
        "git:github.com/you/tools@v1",
        { kind: "git", url: "https://github.com/you/tools", ref: "v1" },
        "git:https://github.com/you/tools@v1",
      ],
      [
        "https://github.com/you/tools",
        { kind: "git", url: "https://github.com/you/tools", ref: null },
        "git:https://github.com/you/tools",
      ],
      [
        "git:git@github.com:you/tools",
        { kind: "git", url: "git@github.com:you/tools", ref: null },
        "git:git@github.com:you/tools",
      ],
      ["./tools", { kind: "folder", path: "/work/tools" }, "/work/tools"],
    ];
    for (const [text, parsed, kept] of cases) {
      assert.deepEqual(parseSource(text, "/work"), parsed);
      assert.equal(sourceText(parsed), kept);
      assert.deepEqual(parseSource(kept, "/elsewhere"), parsed);
    }
  });

  it("refuses what would read as a program's option", () => {
    assert.throws(() => parseSource("npm:--registry=http://evil"), /not a package source/);
    assert.throws(() => parseSource("git:--upload-pack=evil"), /not a package source/);
    assert.throws(() => parseSource("git:github.com/you/tools@--detach"), /not a package source/);
    assert.throws(() => parseSource("npm:"), /not a package source/);
    assert.throws(() => parseSource("  "), /name a package/);
  });
});

describe("readPackage", () => {
  it("finds extensions and skills in their folders", () => {
    const folder = write(TOOLS);
    const contents = readPackage(folder);
    assert.equal(contents.name, "@you/tools");
    assert.equal(contents.version, "1.2.0");
    assert.deepEqual(contents.extensions, [{ path: join(folder, "extensions", "hello.ts") }]);
    assert.deepEqual(contents.skills, [join(folder, "skills")]);
  });

  it("takes what package.json declares instead, and names a lone index module for its package", () => {
    const folder = write({
      "package.json": JSON.stringify({
        name: "@you/tools",
        "1harness": { extensions: ["./src/index.ts"], skills: ["./guides"] },
      }),
      "src/index.ts": EXTENSION,
      "extensions/ignored.ts": EXTENSION,
      "guides/tidy/SKILL.md": SKILL,
    });
    const contents = readPackage(folder);
    assert.deepEqual(contents.extensions, [
      { path: join(folder, "src", "index.ts"), name: "you-tools" },
    ]);
    assert.deepEqual(contents.skills, [join(folder, "guides")]);
  });

  it("refuses a path outside the package", () => {
    const folder = write({
      "package.json": JSON.stringify({ "1harness": { extensions: ["../../secret.ts"] } }),
    });
    assert.throws(() => readPackage(folder), /outside the package/);
  });
});

describe("installing", () => {
  it("reads a folder where it is, and removing it leaves its files", async () => {
    const folder = write(TOOLS);
    const { source, contents } = await installPackage(folder, dirs);
    assert.equal(source, folder);
    assert.equal(contents.name, "@you/tools");
    assert.deepEqual(JSON.parse(readFileSync(join(dirs.configDir, "packages.json"), "utf8")), {
      packages: [folder],
    });
    // Installing it again adds nothing.
    await installPackage(folder, dirs);
    assert.equal(installedPackages(dirs.configDir, dirs.stateDir).packages.length, 1);

    assert.deepEqual(removePackage("@you/tools", dirs), [folder]);
    assert.equal(existsSync(folder), true);
    assert.equal(installedPackages(dirs.configDir, dirs.stateDir).packages.length, 0);
  });

  it("refuses a folder with nothing to offer, and writes nothing", async () => {
    const folder = write({ "package.json": "{}" });
    await assert.rejects(installPackage(folder, dirs), /no extensions or skills/);
    assert.equal(existsSync(join(dirs.configDir, "packages.json")), false);
  });

  it("will not rewrite a packages.json it cannot read", async () => {
    mkdirSync(dirs.configDir, { recursive: true });
    writeFileSync(join(dirs.configDir, "packages.json"), "{ broken");
    await assert.rejects(installPackage(write(TOOLS), dirs), /packages\.json/);
    assert.equal(readFileSync(join(dirs.configDir, "packages.json"), "utf8"), "{ broken");
    assert.throws(() => removePackage("x", dirs), /packages\.json/);
  });

  it("unpacks an npm package outside node_modules, so its TypeScript can load", async () => {
    // npm pack takes a folder as readily as a registry's name, so no network is needed.
    const folder = write(TOOLS);
    const { contents } = await installPackage(`npm:${folder}`, dirs);
    const [module] = contents.extensions;
    assert.ok(module);
    assert.ok(module.path.startsWith(join(dirs.stateDir, "packages")));
    assert.equal(module.path.includes("node_modules"), false);

    const commands = new CommandRegistry();
    const host = new ExtensionHost({
      cwd: dirs.cwd,
      configDir: dirs.configDir,
      stateDir: dirs.stateDir,
      commands,
      ui: null,
    });
    await host.loadAll();
    assert.deepEqual(
      host.extensions.map(({ name, scope, error }) => ({ name, scope, error })),
      [{ name: "hello", scope: "package", error: null }],
    );
    assert.ok(commands.find("hello"));
    assert.deepEqual(
      host.skills.map((skill) => skill.name),
      ["tidy"],
    );
    await host.close();

    removePackage(`npm:${folder}`, dirs);
    assert.equal(existsSync(module.path), false);
  });

  it("clones a git package at its ref, and update stays on a pinned one", async () => {
    const repository = write(TOOLS);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd: repository, stdio: "pipe" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "first");
    git("tag", "v1");
    writeFileSync(join(repository, "extensions", "newer.ts"), EXTENSION);
    git("add", ".");
    git("commit", "-qm", "second");

    const source = `git:file://${repository}@v1`;
    const { contents } = await installPackage(source, dirs);
    assert.equal(contents.extensions.length, 1);
    const [updated] = await updatePackages("@you/tools", dirs);
    assert.equal(updated?.error, null);
    assert.equal(updated?.contents?.extensions.length, 1);

    // Without a pin, update moves on.
    const unpinned = await installPackage(`git:file://${repository}`, dirs);
    assert.equal(unpinned.contents.extensions.length, 2);
  });

  it("fetches what packages.json names and this machine has not, as with dotfiles", async () => {
    const folder = write(TOOLS);
    mkdirSync(dirs.configDir, { recursive: true });
    const source = `npm:${folder}`;
    writeFileSync(join(dirs.configDir, "packages.json"), JSON.stringify({ packages: [source] }));
    const fresh = installedPackages(dirs.configDir, dirs.stateDir);
    assert.match(fresh.warnings[0] ?? "", /not fetched/);
    const [result] = await updatePackages(undefined, dirs);
    assert.equal(result?.error, null);
    assert.deepEqual(installedPackages(dirs.configDir, dirs.stateDir).warnings, []);
  });

  it("keeps what was installed when fetching again fails", async () => {
    const folder = write(TOOLS);
    const source = `npm:${folder}`;
    await installPackage(source, dirs);
    const [result] = await updatePackages(source, dirs, failing);
    assert.match(result?.error ?? "", /network is down/);
    const { packages } = installedPackages(dirs.configDir, dirs.stateDir);
    assert.equal(packages[0]?.contents?.name, "@you/tools");
    assert.equal(packages[0]?.error, null);
  });

  it("runs no install scripts, and installs dependencies without them", async () => {
    const folder = write({
      ...TOOLS,
      "package.json": JSON.stringify({
        name: "scripted",
        version: "1.0.0",
        scripts: { postinstall: "touch pwned" },
        dependencies: { left: "1.0.0" },
      }),
    });
    const calls: string[][] = [];
    const runner: Runner = async (command, args, cwd) => {
      calls.push([command, ...args]);
      if (command === "npm" && args[0] === "pack") {
        execFileSync("npm", ["pack", folder, "--pack-destination", cwd, "--ignore-scripts"], {
          stdio: "pipe",
        });
      } else if (command === "tar") {
        execFileSync(command, args, { cwd, stdio: "pipe" });
      }
      return "";
    };
    await installPackage(`npm:${folder}`, dirs, runner);
    const npm = calls.filter(([command]) => command === "npm");
    assert.equal(npm.length, 2);
    assert.ok(npm.every((call) => call.includes("--ignore-scripts")));
    assert.ok(npm[1]?.includes("--omit=dev"));
  });

  it("says when nothing matches a remove or an update", async () => {
    assert.throws(() => removePackage("nothing", dirs), /no package nothing/);
    await assert.rejects(updatePackages("nothing", dirs), /no package nothing/);
    assert.deepEqual(await updatePackages(undefined, dirs), []);
  });
});
