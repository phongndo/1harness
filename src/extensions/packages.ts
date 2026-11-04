// A package bundles extensions and skills so they can be installed as one, from
// npm, git, or a folder. It runs with the user's permissions, as anything in
// ~/.config/1harness/extensions does, and installing it is what trusts it.
//
// `packages.json` in the config folder says what is installed, so it can be kept
// with the user's dotfiles. What was fetched lives in the state folder, one
// folder a source; a folder source stays where it is and is read in place.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "../core/errors.ts";

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** Extension modules in a folder: module files, and folders with an `index` module. */
export function findExtensions(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder).toSorted();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(folder, name);
    if (MODULE_EXTENSIONS.has(extname(name)) && !name.endsWith(".d.ts")) {
      found.push(path);
      continue;
    }
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
    const index = [...MODULE_EXTENSIONS]
      .map((extension) => join(path, `index${extension}`))
      .find((candidate) => existsSync(candidate));
    if (index) found.push(index);
  }
  return found;
}

export type PackageSource =
  | { kind: "npm"; spec: string }
  | { kind: "git"; url: string; ref: string | null }
  | { kind: "folder"; path: string };

/** A git source with no scheme, as in `git:github.com/you/tools`, is fetched over https. */
function gitUrl(text: string): string {
  return /^(https?|ssh|git|file):\/\//.test(text) || /^[^/]+@[^/]+:/.test(text)
    ? text
    : `https://${text}`;
}

/** Splits `url@ref`; an `@` before the last `/` is a user name, as in `git@host:you/tools`. */
function splitRef(text: string): { url: string; ref: string | null } {
  const at = text.lastIndexOf("@");
  if (at <= text.lastIndexOf("/")) return { url: text, ref: null };
  return { url: text.slice(0, at), ref: text.slice(at + 1) || null };
}

/** Reads what the user typed: `npm:name@version`, `git:host/you/tools@ref`, an https URL, or a path. */
export function parseSource(text: string, cwd: string = process.cwd()): PackageSource {
  const source = text.trim();
  if (source === "") throw new Error("name a package: npm:…, git:…, or a folder");
  const invalid = () => new Error(`${source} is not a package source`);
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    // It goes on npm's command line, where a leading dash would read as an option.
    if (spec === "" || spec.startsWith("-")) throw invalid();
    return { kind: "npm", spec };
  }
  if (source.startsWith("git:") || /^https?:\/\//.test(source)) {
    const { url, ref } = splitRef(source.replace(/^git:/, ""));
    if (url === "" || url.startsWith("-") || ref?.startsWith("-")) throw invalid();
    return { kind: "git", url: gitUrl(url), ref };
  }
  return { kind: "folder", path: resolve(cwd, source) };
}

/** A source as `packages.json` keeps it, which reads back as the same source. */
export function sourceText(source: PackageSource): string {
  if (source.kind === "npm") return `npm:${source.spec}`;
  if (source.kind === "git") return `git:${source.url}${source.ref ? `@${source.ref}` : ""}`;
  return source.path;
}

function packagesFile(configDir: string): string {
  return join(configDir, "packages.json");
}

/** The sources `packages.json` names. A broken file names none, and says so. */
function readSources(configDir: string): { sources: string[]; warning: string | null } {
  const file = packagesFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sources: [], warning: null };
    return { sources: [], warning: `${file}: ${errorMessage(error)}` };
  }
  try {
    const packages = (JSON.parse(text) as { packages?: unknown }).packages;
    if (packages === undefined) return { sources: [], warning: null };
    if (!Array.isArray(packages) || packages.some((entry) => typeof entry !== "string"))
      throw new Error("packages must be a list of sources");
    return { sources: packages as string[], warning: null };
  } catch (error) {
    return { sources: [], warning: `${file}: ${errorMessage(error)}` };
  }
}

function writeSources(configDir: string, sources: readonly string[]): void {
  mkdirSync(configDir, { recursive: true });
  const file = packagesFile(configDir);
  // Written beside it and moved over it, so a crash never leaves half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ packages: sources }, null, 2)}\n`);
  renameSync(temporary, file);
}

/** Where a fetched source lives. */
function installFolder(stateDir: string, source: string): string {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return join(stateDir, "packages", key);
}

/** The folder a source's package is read from. */
function packageFolder(stateDir: string, source: PackageSource): string {
  return source.kind === "folder" ? source.path : installFolder(stateDir, sourceText(source));
}

/** What a package offers, read from its `package.json` or its folders. */
export interface PackageContents {
  name: string;
  version: string | null;
  /** Modules to load, and the name each goes by where its file's would say nothing. */
  extensions: { path: string; name?: string }[];
  /** Folders of skills, each skill a folder with a `SKILL.md`. */
  skills: string[];
}

function listOfStrings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`"1harness".${field} must be a list of paths`);
  return value as string[];
}

/** A path a manifest names, which must stay inside its package. */
function inside(folder: string, path: string): string {
  const full = resolve(folder, path);
  const from = relative(folder, full);
  if (from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from))
    throw new Error(`${path} is outside the package`);
  return full;
}

/**
 * Reads a package: `"1harness": { "extensions": [...], "skills": [...] }` in its
 * `package.json`, else its `extensions/` and `skills/` folders. An `extensions`
 * entry is a module or a folder of them.
 */
export function readPackage(folder: string): PackageContents {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`package.json: ${errorMessage(error)}`, { cause: error });
  }
  const name = typeof manifest["name"] === "string" ? manifest["name"] : basename(folder);
  const version = typeof manifest["version"] === "string" ? manifest["version"] : null;
  const declared = manifest["1harness"] as Record<string, unknown> | undefined;
  const modules = declared
    ? listOfStrings(declared["extensions"], "extensions").map((path) => inside(folder, path))
    : [join(folder, "extensions")];
  const skills = declared
    ? listOfStrings(declared["skills"], "skills").map((path) => inside(folder, path))
    : [join(folder, "skills")];
  // `@you/tools` as one word, for a name that becomes a file's name.
  const plain = name.replace(/^@/, "").replaceAll("/", "-");
  const extensions = modules.flatMap((path) =>
    statSync(path, { throwIfNoEntry: false })?.isDirectory()
      ? findExtensions(path).map((module) => ({ path: module }))
      : existsSync(path)
        ? [{ path }]
        : [],
  );
  return {
    name,
    version,
    // A lone `index` module has no name of its own but its folder's, often just `extensions`.
    extensions: extensions.map((entry) =>
      basename(entry.path, extname(entry.path)) === "index" ? { ...entry, name: plain } : entry,
    ),
    skills: skills.filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory()),
  };
}

/** Each installed package, with what it offers or why it cannot be read. */
export interface InstalledPackage {
  source: string;
  folder: string;
  contents: PackageContents | null;
  error: string | null;
}

export function installedPackages(
  configDir: string,
  stateDir: string,
): { packages: InstalledPackage[]; warnings: string[] } {
  const { sources, warning } = readSources(configDir);
  const packages = sources.map((source): InstalledPackage => {
    try {
      const folder = packageFolder(stateDir, parseSource(source, configDir));
      if (!existsSync(folder))
        return {
          source,
          folder,
          contents: null,
          error: "not fetched; `1harness packages update` fetches it",
        };
      return { source, folder, contents: readPackage(folder), error: null };
    } catch (error) {
      return { source, folder: "", contents: null, error: errorMessage(error) };
    }
  });
  return {
    packages,
    warnings: [
      ...(warning ? [warning] : []),
      ...packages.flatMap((entry) =>
        entry.error ? [`Package ${entry.source}: ${entry.error}`] : [],
      ),
    ],
  };
}

/** Runs a program without a shell, and returns what it printed. */
export type Runner = (command: string, args: string[], cwd: string) => Promise<string>;

const run: Runner = (command, args, cwd) =>
  new Promise((done, fail) => {
    execFile(
      command,
      args,
      { cwd, timeout: FETCH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          done(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          fail(new Error(`${command} is not installed, and fetching this package needs it`));
          return;
        }
        const said = stderr.trim().split("\n").slice(-3).join(" ");
        fail(new Error(`${command} ${args[0]} failed${said ? `: ${said}` : ""}`));
      },
    );
  });

/**
 * Fetches a source into `target`, a folder that does not exist yet. An npm
 * package is unpacked rather than installed under `node_modules`, where Node
 * refuses to strip the types from an extension written in TypeScript. No
 * install scripts run: a package's code runs when 1harness loads it, not before.
 */
async function fetchSource(source: PackageSource, target: string, runner: Runner): Promise<void> {
  if (source.kind === "npm") {
    const work = `${target}.pack`;
    mkdirSync(work, { recursive: true });
    try {
      await runner(
        "npm",
        ["pack", source.spec, "--pack-destination", work, "--ignore-scripts"],
        work,
      );
      const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
      if (!tarball) throw new Error(`npm pack left no file for ${source.spec}`);
      await runner("tar", ["-xzf", join(work, tarball), "-C", work], work);
      renameSync(join(work, "package"), target);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else if (source.kind === "git") {
    await runner("git", ["clone", "--quiet", "--", source.url, target], resolve(target, ".."));
    if (source.ref) await runner("git", ["checkout", "--quiet", "--detach", source.ref], target);
  }
}

/** Installs what a fetched package imports, unless it brought it or needs none. */
async function installDependencies(folder: string, runner: Runner): Promise<void> {
  let manifest: { dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return;
  }
  if (Object.keys(manifest.dependencies ?? {}).length === 0) return;
  await runner(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    folder,
  );
}

/** Fetches a source and swaps it in, so a failure leaves what was installed as it was. */
async function refresh(
  source: PackageSource,
  stateDir: string,
  runner: Runner,
): Promise<PackageContents> {
  if (source.kind === "folder") {
    if (!statSync(source.path, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`${source.path} is not a folder`);
    return checked(source.path, sourceText(source));
  }
  const folder = packageFolder(stateDir, source);
  mkdirSync(join(stateDir, "packages"), { recursive: true });
  const work = mkdtempSync(`${folder}.`);
  const fresh = join(work, "package");
  try {
    await fetchSource(source, fresh, runner);
    await installDependencies(fresh, runner);
    const contents = checked(fresh, sourceText(source));
    rmSync(folder, { recursive: true, force: true });
    renameSync(fresh, folder);
    return contents;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function checked(folder: string, source: string): PackageContents {
  const contents = readPackage(folder);
  if (contents.extensions.length === 0 && contents.skills.length === 0)
    throw new Error(`${source} has no extensions or skills`);
  return contents;
}

/** Installs a package, or fetches it again if it is installed, and adds it to `packages.json`. */
export async function installPackage(
  text: string,
  dirs: { configDir: string; stateDir: string; cwd?: string },
  runner: Runner = run,
): Promise<{ source: string; contents: PackageContents }> {
  const { sources, warning } = readSources(dirs.configDir);
  // Rewriting a file that cannot be read would lose what it holds.
  if (warning) throw new Error(warning);
  const source = parseSource(text, dirs.cwd);
  const contents = await refresh(source, dirs.stateDir, runner);
  const saved = sourceText(source);
  if (!sources.includes(saved)) writeSources(dirs.configDir, [...sources, saved]);
  return { source: saved, contents };
}

/** The installed packages `query` names, by source or by package name; all with no query. */
function matching(
  query: string | undefined,
  dirs: { configDir: string; stateDir: string; cwd?: string },
): InstalledPackage[] {
  const { packages } = installedPackages(dirs.configDir, dirs.stateDir);
  if (query === undefined) return packages;
  let typed: string | null = null;
  try {
    typed = sourceText(parseSource(query, dirs.cwd));
  } catch {
    // Not a source; it may still be a package's name.
  }
  return packages.filter(
    (entry) => entry.source === query || entry.source === typed || entry.contents?.name === query,
  );
}

/** Removes a package and what was fetched for it; a folder source's own files stay. */
export function removePackage(
  query: string,
  dirs: { configDir: string; stateDir: string; cwd?: string },
): string[] {
  const { sources, warning } = readSources(dirs.configDir);
  if (warning) throw new Error(warning);
  const found = matching(query, dirs);
  if (found.length === 0) throw new Error(`no package ${query}; \`1harness packages\` lists them`);
  const gone = new Set(found.map((entry) => entry.source));
  writeSources(
    dirs.configDir,
    sources.filter((source) => !gone.has(source)),
  );
  for (const source of gone) {
    const parsed = parseSource(source, dirs.configDir);
    if (parsed.kind !== "folder")
      rmSync(installFolder(dirs.stateDir, source), { recursive: true, force: true });
  }
  return [...gone];
}

/**
 * Fetches packages again: one named, or all of them. A pinned version or ref
 * stays where it is pinned; what it fetches also brings back a package that
 * `packages.json` names and this machine has not fetched yet.
 */
export async function updatePackages(
  query: string | undefined,
  dirs: { configDir: string; stateDir: string; cwd?: string },
  runner: Runner = run,
): Promise<{ source: string; error: string | null; contents: PackageContents | null }[]> {
  const found = matching(query, dirs);
  if (query !== undefined && found.length === 0)
    throw new Error(`no package ${query}; \`1harness packages\` lists them`);
  const results = [];
  for (const entry of found) {
    try {
      const contents = await refresh(
        parseSource(entry.source, dirs.configDir),
        dirs.stateDir,
        runner,
      );
      results.push({ source: entry.source, error: null, contents });
    } catch (error) {
      results.push({ source: entry.source, error: errorMessage(error), contents: null });
    }
  }
  return results;
}
