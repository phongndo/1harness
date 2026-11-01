import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_MODES, isRuntimeMode, type RuntimeMode } from "./events.ts";

/** What the user sets in `settings.json` in the config folder. */
export interface Settings {
  /** The mode new threads start in; 1harness's default when unset. */
  mode: RuntimeMode | null;
  /** How many days a closed thread is kept; null keeps them all. Pinned ones are always kept. */
  retainClosedDays: number | null;
}

/**
 * Reads `settings.json`. A missing file is no settings. One that cannot be
 * read or holds a bad value is a warning, and threads start in the narrowest
 * mode until it is fixed, since it may have been meant to narrow them.
 */
export function loadSettings(configDir: string): { settings: Settings; warnings: string[] } {
  const file = join(configDir, "settings.json");
  // A broken file keeps every thread, since it may have meant to keep more.
  const broken = (problem: string) => ({
    settings: { mode: "supervised" as const, retainClosedDays: null },
    warnings: [`${file}: ${problem}; threads start in supervised until it is fixed`],
  });
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { settings: { mode: null, retainClosedDays: null }, warnings: [] };
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
  const retain = values["retainClosedDays"];
  const warnings: string[] = [];
  let retainClosedDays: number | null = null;
  if (typeof retain === "number" && Number.isFinite(retain) && retain > 0)
    retainClosedDays = retain;
  else if (retain !== undefined && retain !== null)
    warnings.push(`${file}: retainClosedDays must be a number of days; closed threads are kept`);
  return { settings: { mode: isRuntimeMode(mode) ? mode : null, retainClosedDays }, warnings };
}
