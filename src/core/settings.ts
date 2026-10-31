import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_MODES, isRuntimeMode, type RuntimeMode } from "./events.ts";

/** What the user sets in `settings.json` in the config folder. */
export interface Settings {
  /** The mode new threads start in; 1harness's default when unset. */
  mode: RuntimeMode | null;
}

/**
 * Reads `settings.json`. A missing file is no settings. One that cannot be
 * read or holds a bad value is a warning, and threads start in the narrowest
 * mode until it is fixed, since it may have been meant to narrow them.
 */
export function loadSettings(configDir: string): { settings: Settings; warnings: string[] } {
  const file = join(configDir, "settings.json");
  const broken = (problem: string) => ({
    settings: { mode: "supervised" as const },
    warnings: [`${file}: ${problem}; threads start in supervised until it is fixed`],
  });
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { settings: { mode: null }, warnings: [] };
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
  const mode = (parsed as Record<string, unknown>)["mode"];
  if (mode === undefined || mode === null) return { settings: { mode: null }, warnings: [] };
  if (!isRuntimeMode(mode)) return broken(`mode must be one of: ${RUNTIME_MODES.join(", ")}`);
  return { settings: { mode }, warnings: [] };
}
