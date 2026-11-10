import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HarnessId, HarnessSession, SessionOptions } from "../core/events.ts";
import type { HarnessInfo } from "../protocol.ts";
import { errorMessage } from "../core/errors.ts";
import { AcpSession, type AcpAgentSpec } from "./acp/session.ts";
import { ClaudeSession, claudeSessionTitle } from "./claude/session.ts";
import { CodexSession } from "./codex/session.ts";
import { OpenCodeSession } from "./opencode/session.ts";

/** Finds an executable on PATH, as a shell would. */
export function findExecutable(name: string, path = process.env["PATH"] ?? ""): string | null {
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export interface DriverEnvironment {
  version: string;
  env?: NodeJS.ProcessEnv;
}

/** A harness 1harness can drive. Clients list these; nothing else names a harness. */
export interface DriverDefinition {
  id: HarnessId;
  label: string;
  /** Why the harness cannot run here, such as that it is not installed, or null when it can. */
  unavailable(env: NodeJS.ProcessEnv): string | null;
  /** The executable it runs, as the user would find it to check its version or sign in. */
  executable?(env: NodeJS.ProcessEnv): string | null;
  /** How to get it where it is not installed, as a person would be told. */
  install?: string;
  /** The variable that points 1harness at an install off PATH. */
  override?: string;
  /**
   * Asks the harness, through its own CLI, whether it is signed in. 1harness
   * never signs in for a harness; it says how to, in the harness's own words
   * where it has them. Without this, sign-in is unchecked.
   */
  signIn?(env: NodeJS.ProcessEnv): Promise<SignIn>;
  /**
   * Creates a session. Each runs the user's own install, so it behaves as it
   * does in that harness's terminal UI: same login, settings, MCP servers,
   * hooks, and project instructions.
   */
  create(options: SessionOptions, environment: DriverEnvironment): HarnessSession;
  /**
   * The name the harness gave one of its sessions for what it is doing, read
   * without starting it; null when it has given none.
   */
  sessionTitle?(cwd: string, native: string): Promise<string | null>;
}

/** What a harness says of its sign-in. */
export type SignIn =
  | { state: "ready" }
  /** It must be signed in before it can run; `detail` says how. */
  | { state: "signed-out"; detail: string }
  /** It may run; `detail` says what is not known, if anything. */
  | { state: "unchecked"; detail: string | null };

const registry = new Map<HarnessId, DriverDefinition>();

/** Adds a driver, replacing one with the same ID. Returns a function that removes it. */
export function registerDriver(driver: DriverDefinition): () => void {
  registry.set(driver.id, driver);
  return () => {
    if (registry.get(driver.id) === driver) registry.delete(driver.id);
  };
}

/**
 * A harness's executable: a path as given, else the one `variable` names, else
 * `command` on PATH. `unavailable` says why there is none; `find` throws it.
 */
function executable(
  label: string,
  command: string,
  variable?: string,
): Pick<DriverDefinition, "unavailable"> & {
  executable(env: NodeJS.ProcessEnv): string | null;
  find(environment: DriverEnvironment): string;
} {
  const lookup = (env: NodeJS.ProcessEnv) =>
    command.includes("/")
      ? command
      : ((variable ? env[variable] : undefined) ?? findExecutable(command, env["PATH"]));
  const missing = `${label} is not installed: no \`${command}\` on PATH${variable ? ` (set ${variable})` : ""}`;
  return {
    unavailable: (env) => (lookup(env) ? null : missing),
    executable: lookup,
    find: (environment) => {
      const found = lookup(environment.env ?? process.env);
      if (!found) throw new Error(missing);
      return found;
    },
  };
}

// Status commands answer at once; one that hangs, such as on a prompt, is not waited on.
const ASK_TIMEOUT_MS = 5_000;

/** Runs a harness's own command to ask about it: what it printed, and how it exited. */
function ask(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      path,
      args,
      { env, timeout: ASK_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== "number")
          reject(error.killed ? new Error(`\`${args.join(" ")}\` did not answer`) : error);
        else
          resolve({ code: typeof code === "number" ? code : 0, output: stdout + stderr, stdout });
      },
    );
    child.stdin?.end();
  });
}

function firstLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? null
  );
}

/** A sign-in check that runs `args` on the harness's executable and reads what it says. */
function asking(
  find: (env: NodeJS.ProcessEnv) => string | null,
  args: string[],
  read: (answer: { code: number; output: string; stdout: string }) => SignIn,
): (env: NodeJS.ProcessEnv) => Promise<SignIn> {
  return async (env) => {
    const path = find(env);
    if (!path) return { state: "unchecked", detail: null };
    return read(await ask(path, args, env));
  };
}

/** JSON a harness printed, or null when it printed something else. */
function json(text: string): Record<string, unknown> | unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown> | unknown[])
      : null;
  } catch {
    return null;
  }
}

/** An answer a check could not read, as from a version that says it another way. */
function unreadable(label: string, command: string, output: string): SignIn {
  const said = firstLine(output);
  return {
    state: "unchecked",
    detail: `\`${command}\` did not say whether ${label} is signed in${said ? `: ${said}` : ""}`,
  };
}

// A harness that was ready stays so for a while; one that was not is asked again each time,
// so signing in shows on the next look.
const READY_FOR_MS = 5 * 60_000;

interface Known {
  info: HarnessInfo;
  at: number;
  asking: Promise<HarnessInfo> | null;
}

const known = new WeakMap<DriverDefinition, Known>();

/** Whether a harness is installed, without asking it anything. */
function installed(driver: DriverDefinition, env: NodeJS.ProcessEnv): HarnessInfo {
  const reason = driver.unavailable(env);
  const base = {
    id: driver.id,
    label: driver.label,
    path: driver.executable?.(env) ?? null,
    ...(driver.override ? { override: driver.override } : {}),
  };
  return reason
    ? {
        ...base,
        state: "missing",
        detail: driver.install ?? reason,
        unavailable: reason,
        path: null,
      }
    : { ...base, state: "unchecked", detail: null, unavailable: null };
}

/**
 * What is known of a harness without waiting: its last check's answer, unless
 * it was installed or removed since, else only whether it is installed.
 */
export function harnessInfo(driver: DriverDefinition, env: NodeJS.ProcessEnv): HarnessInfo {
  const now = installed(driver, env);
  const last = known.get(driver)?.info;
  return last && now.state !== "missing" && last.state !== "missing" && last.path === now.path
    ? last
    : now;
}

/**
 * Asks a harness whether it is installed and signed in, as `harnessInfo` then
 * reports. `force` asks one that was ready too, as after it failed.
 */
export function checkHarness(
  driver: DriverDefinition,
  env: NodeJS.ProcessEnv,
  force = false,
): Promise<HarnessInfo> {
  const entry = known.get(driver);
  if (entry?.asking) return entry.asking;
  const now = installed(driver, env);
  const fresh = !force && entry !== undefined && Date.now() - entry.at < READY_FOR_MS;
  if (fresh && entry.info.state === "ready" && entry.info.path === now.path)
    return Promise.resolve(entry.info);
  const signIn = driver.signIn;
  if (now.state === "missing" || !signIn) {
    known.set(driver, { info: now, at: Date.now(), asking: null });
    return Promise.resolve(now);
  }
  const pending = signIn(env)
    .catch((error: unknown): SignIn => ({
      state: "unchecked",
      detail: `could not ask ${driver.label} whether it is signed in: ${errorMessage(error)}`,
    }))
    .then((answer): HarnessInfo => {
      const info: HarnessInfo = {
        ...now,
        state: answer.state,
        detail: answer.state === "ready" ? null : answer.detail,
        unavailable:
          answer.state === "signed-out"
            ? `${driver.label} is not signed in: ${answer.detail}`
            : null,
      };
      known.set(driver, { info, at: Date.now(), asking: null });
      return info;
    });
  known.set(driver, { info: entry?.info ?? now, at: entry?.at ?? 0, asking: pending });
  return pending;
}

/**
 * A driver for an agent that speaks the Agent Client Protocol, such as fx or
 * any agent in the ACP registry: one generic driver, configured per agent.
 */
export function acpDriver(
  spec: AcpAgentSpec,
  extra: Pick<DriverDefinition, "signIn" | "install"> = {},
): DriverDefinition {
  const { unavailable, executable: locate, find } = executable(spec.label, spec.command);
  return {
    id: spec.id,
    label: spec.label,
    unavailable,
    executable: locate,
    ...extra,
    create: (options, environment) =>
      new AcpSession({ ...spec, command: find(environment) }, options, environment.version),
  };
}

/**
 * Registers the ACP agents in `agents.json` in the config folder:
 * `{ "agents": { "id": { "label", "command", "args", "env" } } }`. Returns
 * problems with the file, one per skipped agent.
 */
export function registerConfiguredAgents(configDir: string): string[] {
  const file = join(configDir, "agents.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? []
      : [`${file}: ${errorMessage(error)}`];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return [`${file}: agents.json must be a JSON object`];
  const agents = (parsed as { agents?: unknown }).agents;
  if (agents === undefined) return [];
  if (typeof agents !== "object" || agents === null || Array.isArray(agents))
    return [`${file}: agents must be a map of agent definitions`];
  const warnings: string[] = [];
  for (const [id, value] of Object.entries(agents)) {
    const agent = value as Partial<AcpAgentSpec> | null;
    if (typeof agent?.command !== "string" || !agent.command.trim()) {
      warnings.push(`${file}: ${id}: needs a command`);
      continue;
    }
    if (agent.label !== undefined && typeof agent.label !== "string") {
      warnings.push(`${file}: ${id}: label must be a string`);
      continue;
    }
    if (
      agent.args !== undefined &&
      (!Array.isArray(agent.args) || agent.args.some((arg) => typeof arg !== "string"))
    ) {
      warnings.push(`${file}: ${id}: args must be a list of strings`);
      continue;
    }
    if (
      agent.env !== undefined &&
      (typeof agent.env !== "object" ||
        agent.env === null ||
        Array.isArray(agent.env) ||
        Object.values(agent.env).some((entry) => typeof entry !== "string"))
    ) {
      warnings.push(`${file}: ${id}: env must map names to strings`);
      continue;
    }
    registerDriver(
      acpDriver({
        id,
        label: agent.label ?? id,
        command: agent.command,
        args: agent.args ?? [],
        ...(agent.env ? { env: agent.env } : {}),
      }),
    );
  }
  return warnings;
}

export function drivers(): DriverDefinition[] {
  return [...registry.values()];
}

export function findDriver(id: HarnessId): DriverDefinition | undefined {
  return registry.get(id);
}

/** A harness's name as people know it, such as `Claude Code`. */
export function harnessName(id: HarnessId): string {
  return registry.get(id)?.label ?? id;
}

export function createSession(
  harness: HarnessId,
  options: SessionOptions,
  environment: DriverEnvironment,
): HarnessSession {
  const driver = registry.get(harness);
  if (!driver) {
    throw new Error(
      `No harness named ${harness}; try ${drivers()
        .map((entry) => entry.id)
        .join(", ")}`,
    );
  }
  return driver.create(options, environment);
}

const claude = executable("Claude Code", "claude", "ONEHARNESS_CLAUDE_PATH");
registerDriver({
  id: "claude",
  label: "Claude Code",
  override: "ONEHARNESS_CLAUDE_PATH",
  install: "install with `npm i -g @anthropic-ai/claude-code`",
  unavailable: claude.unavailable,
  executable: claude.executable,
  signIn: asking(claude.executable, ["auth", "status", "--json"], ({ stdout, output }) => {
    const status = json(stdout);
    if (!status || Array.isArray(status))
      return unreadable("Claude Code", "claude auth status", output);
    // Bedrock, Vertex, and other providers sign in with their cloud's own credentials.
    const provider = status["apiProvider"];
    if (status["loggedIn"] === true || (typeof provider === "string" && provider !== "firstParty"))
      return { state: "ready" };
    return { state: "signed-out", detail: "run `claude auth login` to sign in" };
  }),
  sessionTitle: claudeSessionTitle,
  create: (options, environment) =>
    new ClaudeSession({ ...options, executable: claude.find(environment) }),
});

const codex = executable("Codex", "codex", "ONEHARNESS_CODEX_PATH");
registerDriver({
  id: "codex",
  label: "Codex",
  override: "ONEHARNESS_CODEX_PATH",
  install: "install with `npm i -g @openai/codex`",
  unavailable: codex.unavailable,
  executable: codex.executable,
  signIn: asking(codex.executable, ["login", "status"], ({ code, output }) => {
    if (code === 0) return { state: "ready" };
    if (/not logged in/i.test(output))
      return { state: "signed-out", detail: "run `codex login` to sign in" };
    return unreadable("Codex", "codex login status", output);
  }),
  create: (options, environment) =>
    new CodexSession({
      ...options,
      command: codex.find(environment),
      version: environment.version,
    }),
});

const opencode = executable("OpenCode", "opencode", "ONEHARNESS_OPENCODE_PATH");
registerDriver({
  id: "opencode",
  label: "OpenCode",
  override: "ONEHARNESS_OPENCODE_PATH",
  install: "install with `npm i -g opencode-ai`",
  unavailable: opencode.unavailable,
  executable: opencode.executable,
  signIn: asking(
    opencode.executable,
    ["auth", "list", "--format", "json"],
    ({ stdout, output }) => {
      const providers = json(stdout);
      if (!Array.isArray(providers)) return unreadable("OpenCode", "opencode auth list", output);
      if (providers.length > 0) return { state: "ready" };
      // Its free models run without signing in, and keys can come from the environment.
      return {
        state: "unchecked",
        detail:
          "no provider is signed in, so only its free models may run; `opencode auth login` adds one",
      };
    },
  ),
  create: (options, environment) =>
    new OpenCodeSession({ ...options, command: opencode.find(environment) }),
});

// fx speaks ACP through `fx acp`.
const fx = executable("fx", "fx");
registerDriver(
  acpDriver(
    { id: "fx", label: "fx", command: "fx", args: ["acp"] },
    {
      install: "install from https://github.com/vercel-labs/fx",
      signIn: asking(fx.executable, ["status", "--json"], ({ stdout, output }) => {
        const status = json(stdout);
        if (!status || Array.isArray(status)) return unreadable("fx", "fx status", output);
        if (status["auth"] !== "missing") return { state: "ready" };
        const help = status["auth_help"];
        return {
          state: "signed-out",
          detail: typeof help === "string" && help !== "" ? help : "run `fx login` to sign in",
        };
      }),
    },
  ),
);
