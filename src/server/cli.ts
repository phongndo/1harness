import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { parseArgs } from "node:util";
import { serverHello } from "../client/socket.ts";
import { serverLog, socketFile } from "../core/paths.ts";
import { answering, runServer, spawnServer } from "./lifecycle.ts";

export const SERVER_HELP = `Usage: 1harness server <command>

Runs the 1harness server, which keeps threads and their harnesses working
while no terminal is open. Any 1harness command starts one when none is
running, and that one stops once it has sat idle for a few seconds; one
started with \`server start\` or by a service manager keeps running.

Commands:
  run                 run in the foreground, as a service manager or container does
    --autostarted       stop once idle, as one a client started does
    --extra-listen <a>  also listen on <a>, such as tailnet://:7330 (repeatable)
  start               start in the background, unless one is running
  status              say whether one is running, and where
  logs [--follow]     show what a background server wrote
  stop                stop it; its threads keep their place for the next one
  install             set up a user service that keeps one running (systemd or launchd)
  uninstall           remove that service

Environment:
  ONEHARNESS_SOCKET     the socket (default: $XDG_RUNTIME_DIR/1harness/server.sock)
  ONEHARNESS_AUTOSTART  0 runs 1harness in one process, with no server
`;

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function uptime(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** `1harness server …`; resolves with the exit status. */
export async function serverCommand(args: string[], version: string): Promise<number> {
  const [command = "status", ...rest] = args;
  const socket = socketFile();
  switch (command) {
    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: {
          autostarted: { type: "boolean" },
          "idle-exit": { type: "string" },
          "extra-listen": { type: "string", multiple: true },
        },
      });
      const idle =
        values["idle-exit"] === undefined ? undefined : Number(values["idle-exit"]) * 1000;
      const running = await runServer({
        version,
        socket,
        autostarted: values.autostarted === true,
        ...(idle !== undefined && Number.isFinite(idle) ? { idleExitMs: idle } : {}),
        extraListen: values["extra-listen"] ?? [],
        log: (text) => process.stderr.write(`${new Date().toISOString()} ${text}\n`),
      });
      if (running) await running.stopped;
      return 0;
    }
    case "start": {
      const running = await answering(socket);
      if (running) {
        line(`1harness ${running.version} is running (pid ${running.pid}) on ${socket}`);
        return 0;
      }
      spawnServer({ autostarted: false, args: rest });
      const up = await waitFor(async () => (await answering(socket)) !== null, 15_000);
      if (!up) {
        line(`The server did not start; see ${serverLog()}`);
        return 1;
      }
      const hello = await serverHello({ socket });
      line(`1harness ${hello.version} started (pid ${hello.pid}) on ${socket}`);
      return 0;
    }
    case "status": {
      const hello = await answering(socket);
      if (!hello) {
        line(`No 1harness server is running on ${socket}`);
        return 1;
      }
      line(
        `1harness ${hello.version} (protocol ${hello.protocol}), pid ${hello.pid}, up ${uptime(hello.startedAt)}`,
      );
      line(`socket  ${socket}`);
      line(`store   ${hello.store ?? "none"}`);
      line(hello.autostarted ? "started by a client; stops once idle" : "started to keep running");
      return 0;
    }
    case "logs": {
      const { values } = parseArgs({
        args: rest,
        options: { follow: { type: "boolean", short: "f" } },
      });
      const file = serverLog();
      if (!existsSync(file)) {
        line(`No log at ${file}; a server writes one when it runs in the background.`);
        return values.follow ? 0 : 1;
      }
      process.stdout.write(readFileSync(file));
      if (!values.follow) return 0;
      let offset = statSync(file).size;
      await new Promise<void>(() => {
        watch(file, () => {
          const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
          if (size < offset) offset = 0;
          if (size === offset) return;
          createReadStream(file, { start: offset, end: size - 1 }).pipe(process.stdout, {
            end: false,
          });
          offset = size;
        });
      });
      return 0;
    }
    case "stop": {
      const hello = await answering(socket);
      if (!hello) {
        line("No 1harness server is running.");
        return 0;
      }
      process.kill(hello.pid, "SIGTERM");
      const gone = await waitFor(async () => (await answering(socket)) === null, 20_000);
      line(gone ? `Stopped 1harness (pid ${hello.pid})` : `pid ${hello.pid} is still stopping`);
      return gone ? 0 : 1;
    }
    case "install":
    case "uninstall": {
      const { install, uninstall } = await import("./service.ts");
      return command === "install" ? install(rest) : uninstall();
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(SERVER_HELP);
      return 0;
    default:
      process.stderr.write(`1harness: no server command ${command}\n\n${SERVER_HELP}`);
      return 2;
  }
}
