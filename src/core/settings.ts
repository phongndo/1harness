import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_MODE, RUNTIME_MODES, isRuntimeMode, type RuntimeMode } from "./events.ts";

/** What the user sets in `settings.json` in the config folder. */
export interface Settings {
  /**
   * The harness 1harness starts when none is named, which ctrl+s in a harness
   * pick sets; without one, it starts the harness used last.
   */
  harness: string | null;
  /** The mode new threads start in; 1harness's default when unset. */
  mode: RuntimeMode | null;
  /** How many days a closed thread is kept; null keeps them all. Pinned ones are always kept. */
  retainClosedDays: number | null;
  /**
   * The most an agent outside 1harness, using `1harness mcp` or the server's
   * `/mcp`, may start a thread in or act on; `DEFAULT_AGENT_MODE` when unset.
   */
  agentMode: RuntimeMode | null;
}

/** What agents outside 1harness may start and act on unless settings say otherwise. */
export const DEFAULT_AGENT_MODE: RuntimeMode = "auto";

export function settingsFile(configDir: string): string {
  return join(configDir, "settings.json");
}

/**
 * Reads `settings.json`. A missing file is no settings. One that cannot be
 * read or holds a bad value is a warning, and threads start in the narrowest
 * mode until it is fixed, since it may have been meant to narrow them.
 */
export function loadSettings(configDir: string): { settings: Settings; warnings: string[] } {
  const file = settingsFile(configDir);
  // A broken file keeps every thread, since it may have meant to keep more.
  const broken = (problem: string) => ({
    settings: {
      harness: null,
      mode: "supervised" as const,
      retainClosedDays: null,
      agentMode: "supervised" as const,
    },
    warnings: [`${file}: ${problem}; threads start in supervised until it is fixed`],
  });
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        settings: { harness: null, mode: null, retainClosedDays: null, agentMode: null },
        warnings: [],
      };
    return broken((error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return broken((error as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return broken("settings must be a JSON object");
  const values = parsed as Record<string, unknown>;
  const mode = values["mode"];
  if (mode !== undefined && mode !== null && !isRuntimeMode(mode))
    return broken(`mode must be one of: ${RUNTIME_MODES.join(", ")}`);
  const agentMode = values["agentMode"];
  if (agentMode !== undefined && agentMode !== null && !isRuntimeMode(agentMode))
    return broken(`agentMode must be one of: ${RUNTIME_MODES.join(", ")}`);
  const warnings: string[] = [];
  const named = values["harness"];
  let harness: string | null = null;
  if (typeof named === "string" && named !== "") harness = named;
  else if (named !== undefined && named !== null)
    warnings.push(`${file}: harness must be a harness's name, such as codex; 1harness asks`);
  const retain = values["retainClosedDays"];
  let retainClosedDays: number | null = null;
  if (typeof retain === "number" && Number.isFinite(retain) && retain > 0)
    retainClosedDays = retain;
  else if (retain !== undefined && retain !== null)
    warnings.push(`${file}: retainClosedDays must be a number of days; closed threads are kept`);
  return {
    settings: {
      harness,
      mode: isRuntimeMode(mode) ? mode : null,
      retainClosedDays,
      agentMode: isRuntimeMode(agentMode) ? agentMode : null,
    },
    warnings,
  };
}

/**
 * The harness used last, kept in the state folder, as the harness to start
 * when the user set no default. Null when none was kept or it cannot be read.
 */
export function loadLastHarness(stateDir: string): string | null {
  try {
    return readFileSync(join(stateDir, "last-harness"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function saveLastHarness(stateDir: string, harness: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "last-harness"), `${harness}\n`);
}

/**
 * Sets keys in `settings.json`, keeping the rest of it as written. A file that
 * cannot be read as a JSON object is left alone, since rewriting it would lose
 * what the user meant by it.
 */
export function saveSettings(configDir: string, changes: Partial<Settings>): void {
  const file = settingsFile(configDir);
  let values: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== null) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`${file}: settings must be a JSON object`);
    values = parsed as Record<string, unknown>;
  }
  mkdirSync(configDir, { recursive: true });
  // Written beside it and moved over it, so a crash never leaves half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...values, ...changes }, null, 2)}\n`);
  renameSync(temporary, file);
}

/** The harness 1harness starts when none is named: the user's default, else the one used last. */
export function defaultHarness(settings: Settings, stateDir: string): string | null {
  return settings.harness ?? loadLastHarness(stateDir);
}

/** The mode a person's new thread starts in when none is named. */
export function defaultMode(settings: Settings): RuntimeMode {
  return settings.mode ?? DEFAULT_RUNTIME_MODE;
}
