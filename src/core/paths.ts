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

/**
 * Where the server's socket goes: `$XDG_RUNTIME_DIR/1harness`, which only the
 * user can enter and which the system clears at logout, or a folder in the
 * state folder where there is no runtime folder, as on macOS.
 */
function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env["XDG_RUNTIME_DIR"];
  return runtime ? join(runtime, "1harness") : join(stateDir(env), "run");
}

/** The server's socket, unless `ONEHARNESS_SOCKET` names another. */
export function socketFile(env: NodeJS.ProcessEnv = process.env): string {
  return env["ONEHARNESS_SOCKET"] || join(runtimeDir(env), "server.sock");
}

/** Where a server started in the background writes what it has to say. */
export function serverLog(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "server.log");
}
