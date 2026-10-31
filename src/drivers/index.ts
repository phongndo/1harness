import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HarnessId, HarnessSession, SessionOptions } from "../core/events.ts";
import { errorMessage } from "../core/thread.ts";
import { AcpSession, type AcpAgentSpec } from "./acp/session.ts";
import { ClaudeSession } from "./claude/session.ts";
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
 * A driver for an agent that speaks the Agent Client Protocol, such as fx or
 * any agent in the ACP registry: one generic driver, configured per agent.
 */
export function acpDriver(spec: AcpAgentSpec): DriverDefinition {
  const command = (env: NodeJS.ProcessEnv) =>
    spec.command.includes("/") ? spec.command : findExecutable(spec.command, env["PATH"]);
  return {
    id: spec.id,
    label: spec.label,
    unavailable: (env) =>
      command(env) ? null : `${spec.label} is not installed: no \`${spec.command}\` on PATH`,
    create: (options, environment) => {
      const resolved = command(environment.env ?? process.env);
      if (!resolved)
        throw new Error(`${spec.label} is not installed: no \`${spec.command}\` on PATH`);
      return new AcpSession({ ...spec, command: resolved }, options, environment.version);
    },
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
  create: (options, environment) => {
    const env = environment.env ?? process.env;
    return new ClaudeSession({
      ...options,
      executable: env["ONEHARNESS_CLAUDE_PATH"] ?? findExecutable("claude", env["PATH"]),
    });
  },
});

registerDriver({
  id: "codex",
  label: "Codex",
  unavailable: (env) =>
    (env["ONEHARNESS_CODEX_PATH"] ?? findExecutable("codex", env["PATH"]))
      ? null
      : "Codex is not installed: no `codex` on PATH (set ONEHARNESS_CODEX_PATH)",
  create: (options, environment) => {
    const env = environment.env ?? process.env;
    const command = env["ONEHARNESS_CODEX_PATH"] ?? findExecutable("codex", env["PATH"]);
    if (!command)
      throw new Error("Codex is not installed: no `codex` on PATH (set ONEHARNESS_CODEX_PATH)");
    return new CodexSession({ ...options, command, version: environment.version });
  },
});

registerDriver({
  id: "opencode",
  label: "OpenCode",
  unavailable: (env) =>
    (env["ONEHARNESS_OPENCODE_PATH"] ?? findExecutable("opencode", env["PATH"]))
      ? null
      : "OpenCode is not installed: no `opencode` on PATH (set ONEHARNESS_OPENCODE_PATH)",
  create: (options, environment) => {
    const env = environment.env ?? process.env;
    const command = env["ONEHARNESS_OPENCODE_PATH"] ?? findExecutable("opencode", env["PATH"]);
    if (!command)
      throw new Error(
        "OpenCode is not installed: no `opencode` on PATH (set ONEHARNESS_OPENCODE_PATH)",
      );
    return new OpenCodeSession({ ...options, command });
  },
});

// fx speaks ACP through `fx acp`.
registerDriver(acpDriver({ id: "fx", label: "fx", command: "fx", args: ["acp"] }));
