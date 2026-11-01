import { homedir } from "node:os";
import { join } from "node:path";

/** Where 1harness reads configuration the user writes: `$XDG_CONFIG_HOME/1harness`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "1harness");
}

/** Where 1harness keeps what it writes itself: `$XDG_STATE_HOME/1harness`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), "1harness");
}

/** Where 1harness keeps its threads across restarts. */
export function storeFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "1harness.db");
}
