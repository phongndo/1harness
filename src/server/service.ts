import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, serverLog, socketFile } from "../core/paths.ts";
import { answering } from "./lifecycle.ts";

// A user service that keeps a 1harness server running: systemd user units on
// Linux, with socket activation, and a LaunchAgent on macOS. Harnesses are
// found on the PATH in server.env, which `install` writes from the shell it
// runs in, since a service starts with almost no environment.

const UNIT = "1harness";
const LABEL = "dev.1harness.server";

/** Variables a service needs from the user's shell: where harnesses are, and 1harness's own. */
const PASSED =
  /^(PATH|ONEHARNESS_(CLAUDE|CODEX|OPENCODE)_PATH|ONEHARNESS_SOCKET|XDG_(CONFIG|STATE)_HOME)$/;

/** The command that runs this 1harness's server. */
export function serverCommand(): string[] {
  const here = import.meta.url;
  const cli = fileURLToPath(new URL(here.endsWith(".ts") ? "../cli.ts" : "../cli.js", here));
  return [process.execPath, ...process.execArgv, cli, "server", "run"];
}

/** `server.env`: the variables from this shell a service gets. */
export function serverEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const lines = Object.entries(env)
    .filter(([name, value]) => PASSED.test(name) && value !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`);
  return `# Written by \`1harness server install\` from the shell it ran in.\n${lines.join("\n")}\n`;
}

/**
 * The systemd user units: a service, and a socket that starts it on the first
 * connection, on the path clients look for it.
 */
export function systemdUnits(
  command: string[],
  envFile: string,
  socket: string = socketFile(),
): { service: string; socket: string } {
  const quoted = command.map((part) => (/[\s"\\]/.test(part) ? JSON.stringify(part) : part));
  return {
    service: `[Unit]
Description=1harness server
Requires=${UNIT}.socket
After=${UNIT}.socket

[Service]
Type=simple
EnvironmentFile=-${envFile}
ExecStart=${quoted.join(" ")}
Restart=on-failure
RestartSec=5s
# Stopping parks every thread for the next start; give harnesses time to close.
TimeoutStopSec=30s

[Install]
WantedBy=default.target
`,
    socket: `[Unit]
Description=1harness server socket

[Socket]
ListenStream=${socket}
SocketMode=0600
DirectoryMode=0700

[Install]
WantedBy=sockets.target
`,
  };
}

function plistString(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The LaunchAgent, which keeps the server running from login. */
export function launchAgent(command: string[], env: Record<string, string>, log: string): string {
  const args = command.map((part) => `    <string>${plistString(part)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(
      ([name, value]) =>
        `    <key>${plistString(name)}</key>\n    <string>${plistString(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${plistString(log)}</string>
  <key>StandardErrorPath</key>
  <string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** A server a client started stops now, so the service's takes over. */
async function stopRunning(): Promise<void> {
  const running = await answering(socketFile());
  if (!running) return;
  process.kill(running.pid, "SIGTERM");
  for (let tries = 0; tries < 200 && (await answering(socketFile())); tries++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}

function systemdDir(): string {
  return join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "systemd", "user");
}

function launchAgentFile(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export async function install(args: string[]): Promise<number> {
  const print = args.includes("--print");
  const command = serverCommand();
  const envFile = join(configDir(), "server.env");
  if (process.platform === "darwin") {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => PASSED.test(entry[0]) && entry[1] !== undefined,
      ),
    );
    const plist = launchAgent(command, env, serverLog());
    if (print) {
      process.stdout.write(plist);
      return 0;
    }
    const file = launchAgentFile();
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(serverLog()), { recursive: true, mode: 0o700 });
    await stopRunning();
    if (existsSync(file)) {
      try {
        run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, file]);
      } catch {
        // Not loaded.
      }
    }
    writeFileSync(file, plist);
    run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, file]);
    say(`Installed ${file}; the server runs from login, with this shell's PATH.`);
    return 0;
  }
  if (process.platform !== "linux") {
    process.stderr.write("1harness: server install knows systemd and launchd only\n");
    return 1;
  }
  const units = systemdUnits(command, envFile);
  if (print) {
    process.stdout.write(`# ${UNIT}.service\n${units.service}\n# ${UNIT}.socket\n${units.socket}`);
    return 0;
  }
  const dir = systemdDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, serverEnvironment(), { mode: 0o600 });
  writeFileSync(join(dir, `${UNIT}.service`), units.service);
  writeFileSync(join(dir, `${UNIT}.socket`), units.socket);
  await stopRunning();
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${UNIT}.socket`]);
  run("systemctl", ["--user", "enable", `${UNIT}.service`]);
  run("systemctl", ["--user", "start", `${UNIT}.service`]);
  say(
    `Installed ${UNIT}.service and ${UNIT}.socket in ${dir}, with this shell's PATH in ${envFile}.`,
  );
  if (!existsSync(`/var/lib/systemd/linger/${process.env["USER"] ?? ""}`))
    say("To keep it running while you are logged out, run: loginctl enable-linger $USER");
  return 0;
}

export async function uninstall(): Promise<number> {
  if (process.platform === "darwin") {
    const file = launchAgentFile();
    if (existsSync(file)) {
      try {
        run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, file]);
      } catch {
        // Not loaded.
      }
      rmSync(file);
    }
    say("Removed the LaunchAgent; a server starts again when a client needs one.");
    return 0;
  }
  const dir = systemdDir();
  for (const unit of [`${UNIT}.socket`, `${UNIT}.service`]) {
    try {
      run("systemctl", ["--user", "disable", "--now", unit]);
    } catch {
      // Not enabled.
    }
    rmSync(join(dir, unit), { force: true });
  }
  try {
    run("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // No systemd.
  }
  say("Removed the user service; a server starts again when a client needs one.");
  return 0;
}
