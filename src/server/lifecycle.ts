import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serverHello, type ServerTarget } from "../client/socket.ts";
import { configDir, serverLog, socketFile, storeFile } from "../core/paths.ts";
import { loadSettings } from "../core/settings.ts";
import { errorMessage } from "../core/thread.ts";
import { registerConfiguredAgents } from "../drivers/index.ts";
import { Host } from "../host/host.ts";
import type { ServerHello } from "../protocol.ts";
import { Store, StoreLocked } from "../store/store.ts";
import { HostServer } from "./http.ts";
import { listen } from "./listeners.ts";

/** How long an autostarted server stays once nobody is connected and nothing is working. */
export const IDLE_EXIT_MS = 10_000;
/** How long a client waits for a server it started to answer. */
const START_TIMEOUT_MS = 15_000;
/** The longest socket path the kernel takes, without its final NUL. */
const MAX_SOCKET_BYTES = 103;
/** A log bigger than this is set aside when a server starts. */
const LOG_BYTES = 5 * 1024 * 1024;

export interface RunOptions {
  version: string;
  socket?: string;
  /** Started by a client: it stops once idle, and says so in its log. */
  autostarted: boolean;
  idleExitMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Listeners beyond the socket, such as `tailnet://:7330`; each decides who
   * may call. Set up by `listeners` in the server's own module.
   */
  extraListen?: string[];
  log?: (line: string) => void;
}

/** A server that is running, and what stops it. */
export interface RunningServer {
  hello: ServerHello;
  /** Resolves once the server has stopped, however it stopped. */
  stopped: Promise<void>;
  stop(): Promise<void>;
}

/** Whether a server answers on the socket. */
export async function answering(socket: string): Promise<ServerHello | null> {
  try {
    return await serverHello({ socket }, 1_000);
  } catch {
    return null;
  }
}

/**
 * Runs the server in this process until it is stopped: it takes the store's
 * lock, brings its threads back parked, and listens on the socket, or on the
 * one systemd passes in `LISTEN_FDS`. Returns null when a server is running
 * already, which is not an error.
 */
export async function runServer(options: RunOptions): Promise<RunningServer | null> {
  const env = options.env ?? process.env;
  const socket = options.socket ?? socketFile(env);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // The kernel takes socket paths of at most 107 bytes.
  if (Buffer.byteLength(socket) > MAX_SOCKET_BYTES)
    throw new Error(
      `${socket} is too long for a socket (${Buffer.byteLength(socket)} bytes; at most ${MAX_SOCKET_BYTES}); set ONEHARNESS_SOCKET to a shorter path`,
    );
  // systemd hands over the socket it listens on, as file descriptor 3.
  const inherited = env["LISTEN_FDS"] === "1" && Number(env["LISTEN_PID"]) === process.pid;
  if (!inherited) {
    const running = await answering(socket);
    if (running) {
      log(`1harness ${running.version} is already running (pid ${running.pid}) on ${socket}`);
      return null;
    }
  }
  let store: Store;
  try {
    store = Store.open(storeFile(env));
  } catch (error) {
    if (error instanceof StoreLocked) {
      const running = await answering(socket);
      if (running) return null;
      throw new Error(
        `${errorMessage(error)}: a 1harness started with ONEHARNESS_AUTOSTART=0 keeps its threads; quit it first`,
        { cause: error },
      );
    }
    throw error;
  }
  const { warnings: settingsWarnings } = loadSettings(configDir(env));
  const warnings = [...settingsWarnings, ...registerConfiguredAgents(configDir(env))];
  for (const warning of warnings) log(`warning: ${warning}`);
  const host = new Host({ version: options.version, cwd: homedir(), store, warnings, env });
  await host.start();

  let idleSince: number | null = null;
  const server = new HostServer(host, {
    version: options.version,
    autostarted: options.autostarted,
    onActivity: () => {
      idleSince = null;
    },
  });
  let ownSocket = false;
  if (inherited) await server.listen({ fd: 3 });
  else {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    // A socket left by a server that died: nothing answers on it.
    if (existsSync(socket)) unlinkSync(socket);
    await server.listen({ path: socket });
    chmodSync(socket, 0o600);
    ownSocket = true;
  }
  for (const listener of options.extraListen ?? []) log(await listen(server, listener));

  let stopping: Promise<void> | null = null;
  let finished!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const idleTimer = setInterval(() => {
    if (!options.autostarted) return;
    const idle = server.streaming === 0 && host.clients === 0 && !host.busy;
    if (!idle) {
      idleSince = null;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= (options.idleExitMs ?? IDLE_EXIT_MS)) {
      log("Nobody is connected and nothing is working; stopping.");
      void stop();
    }
  }, 1_000);
  idleTimer.unref();
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(idleTimer);
      for (const signal of SIGNALS) process.off(signal, onSignal);
      await server.close();
      await host.shutdown();
      if (ownSocket && existsSync(socket)) unlinkSync(socket);
      finished();
    })();
    return stopping;
  };
  const onSignal = () => void stop();
  for (const signal of SIGNALS) process.on(signal, onSignal);
  log(
    `1harness ${options.version} listening on ${inherited ? "the socket systemd passed" : socket} (pid ${process.pid})`,
  );
  return {
    hello: {
      name: "1harness",
      version: options.version,
      protocol: 1,
      minProtocol: 1,
      pid: process.pid,
      startedAt: Date.now(),
      autostarted: options.autostarted,
      store: host.storePath,
      identity: null,
    },
    stopped,
    stop,
  };
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Sets an old log aside once it grows large. */
function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
}

/**
 * Starts a server in the background, detached from this terminal, with the
 * caller's environment, so harnesses on its `PATH` are found. `autostarted`
 * makes it stop once idle.
 */
export function spawnServer(options: {
  autostarted: boolean;
  env?: NodeJS.ProcessEnv;
  args?: string[];
}): number {
  const env = options.env ?? process.env;
  const file = serverLog(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  rotate(file);
  const out = openSync(file, "a", 0o600);
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)).replace(
    /\.ts$/,
    import.meta.url.endsWith(".ts") ? ".ts" : ".js",
  );
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      cli,
      "server",
      "run",
      ...(options.autostarted ? ["--autostarted"] : []),
      ...(options.args ?? []),
    ],
    { detached: true, stdio: ["ignore", out, out], env, cwd: homedir() },
  );
  child.unref();
  closeSync(out);
  return child.pid ?? 0;
}

/**
 * Finds the server, starting one in the background when `autostart` allows
 * and nothing answers; resolves once it answers.
 */
export async function ensureServer(options: {
  target: ServerTarget;
  autostart: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ServerHello> {
  const target = options.target;
  try {
    // A service manager may start the server on this first connection.
    return await serverHello(target, 5_000);
  } catch (error) {
    if (!options.autostart || !("socket" in target)) throw error;
  }
  spawnServer({ autostarted: true, ...(options.env ? { env: options.env } : {}) });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const hello = await answering(target.socket);
    if (hello) return hello;
  }
  throw new Error(
    `The 1harness server did not start; see ${serverLog(options.env ?? process.env)}`,
  );
}
