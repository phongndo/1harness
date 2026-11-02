import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HarnessId, HarnessSession, SessionOptions } from "../core/events.ts";
import { errorMessage } from "../core/thread.ts";
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
  /** Why the harness cannot run here, or null when it can. */
  unavailable(env: NodeJS.ProcessEnv): string | null;
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
): Pick<DriverDefinition, "unavailable"> & { find(environment: DriverEnvironment): string } {
  const lookup = (env: NodeJS.ProcessEnv) =>
    command.includes("/")
      ? command
      : ((variable ? env[variable] : undefined) ?? findExecutable(command, env["PATH"]));
  const missing = `${label} is not installed: no \`${command}\` on PATH${variable ? ` (set ${variable})` : ""}`;
  return {
    unavailable: (env) => (lookup(env) ? null : missing),
    find: (environment) => {
      const found = lookup(environment.env ?? process.env);
      if (!found) throw new Error(missing);
      return found;
    },
  };
}

/**
 * A driver for an agent that speaks the Agent Client Protocol, such as fx or
 * any agent in the ACP registry: one generic driver, configured per agent.
 */
export function acpDriver(spec: AcpAgentSpec): DriverDefinition {
  const { unavailable, find } = executable(spec.label, spec.command);
  return {
    id: spec.id,
    label: spec.label,
    unavailable,
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
  let parsed: { agents?: Record<string, Partial<AcpAgentSpec>> };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? []
      : [`${file}: ${errorMessage(error)}`];
  }
  const warnings: string[] = [];
  for (const [id, agent] of Object.entries(parsed.agents ?? {})) {
    if (typeof agent.command !== "string") {
      warnings.push(`${file}: ${id}: needs a command`);
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

registerDriver({
  id: "claude",
  label: "Claude Code",
  // Without an installed `claude`, the SDK runs the copy it bundles.
  unavailable: () => null,
  sessionTitle: claudeSessionTitle,
  create: (options, environment) => {
    const env = environment.env ?? process.env;
    return new ClaudeSession({
      ...options,
      executable: env["ONEHARNESS_CLAUDE_PATH"] ?? findExecutable("claude", env["PATH"]),
    });
  },
});

const codex = executable("Codex", "codex", "ONEHARNESS_CODEX_PATH");
registerDriver({
  id: "codex",
  label: "Codex",
  unavailable: codex.unavailable,
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
  unavailable: opencode.unavailable,
  create: (options, environment) =>
    new OpenCodeSession({ ...options, command: opencode.find(environment) }),
});

// fx speaks ACP through `fx acp`.
registerDriver(acpDriver({ id: "fx", label: "fx", command: "fx", args: ["acp"] }));
