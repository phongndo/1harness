#!/usr/bin/env node
import { errorMessage } from "./core/errors.ts";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  isRuntimeMode,
  type HarnessId,
  type RuntimeMode,
  type SessionOptions,
} from "./core/events.ts";
import { HostClient } from "./client/client.ts";
import { LocalConnection, newClientId } from "./client/connection.ts";
import { SocketConnection } from "./client/socket.ts";
import { configDir, socketFile, stateDir, storeFile } from "./core/paths.ts";
import {
  loadLastHarness,
  loadSettings,
  saveLastHarness,
  saveSettings,
  settingsFile,
} from "./core/settings.ts";
import { drivers, registerConfiguredAgents } from "./drivers/index.ts";
import { Host } from "./host/host.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { serverCommand } from "./server/cli.ts";
import { ensureServer } from "./server/lifecycle.ts";
import { harnessesCommand } from "./client/harnesses-cli.ts";
import { hostsCommand, whoami } from "./client/hosts-cli.ts";
import { loadHosts, resolveServer } from "./client/hosts.ts";
import { threadsCommand } from "./client/threads-cli.ts";
import { ACP_HELP, serveAcp } from "./client/acp-agent.ts";
import { MCP_HELP, mcpBridge } from "./client/mcp-bridge.ts";
import { opCommand } from "./client/ops-cli.ts";
import { watch } from "./client/watch.ts";
import { Store, StoreLocked } from "./store/store.ts";
import { App, type ServerInfo } from "./tui/app.ts";

const labels = drivers().map((driver) => driver.label);
const help = `1harness
One terminal UI for ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}` : labels.join("")}.

Usage: 1harness [options] [prompt]
       1harness server <command>   run, start, stop, or check the server
       1harness harnesses          say which harnesses are ready, need signing in, or are missing
       1harness threads [words]    list this folder's threads, or search them; show <id> prints one
       1harness watch              report every thread's status to the terminal (OSC 7501)
       1harness op [name] [k=v…]   list what 1harness can do, or do it: open, steer, or move threads
       1harness mcp                serve that to agents 1harness does not run, as an MCP server
       1harness acp                be an Agent Client Protocol agent for editors, over every harness
       1harness hosts <command>    name servers on other machines, for -S
       1harness whoami             who the server takes you to be

Threads run in the 1harness server, which keeps them working after the
terminal quits; it starts in the background when none is running.

Options:
  -H, --harness <name>   ${drivers()
    .map((driver) => driver.id)
    .join(", ")} (default: "harness" in
                         ~/.config/1harness/settings.json, which ctrl+s in a harness pick
                         sets, else the one used last; the first run asks)
  -m, --model <id>       model to use (default: the harness's default)
  -e, --effort <level>   reasoning effort
      --mode <mode>      supervised, auto-edit, auto, or full-access (default: "mode"
                         in ~/.config/1harness/settings.json, else ${DEFAULT_RUNTIME_MODE})
      --plan             start in plan mode
  -C, --cwd <dir>        working folder (default: current folder; on another
                         machine's server, its home)
  -S, --server <name>    use another server: a name from \`1harness hosts\`, host:port,
                         or a socket path (default: ONEHARNESS_SERVER, else this machine's)
  -r, --resume <id>      reopen a thread: 1harness's, such as 3f9c2a1b, or a harness's own
  -x, --extension <path> load an extension module (repeatable); others load from
                         ~/.config/1harness/extensions and a trusted .1harness/extensions
  -p, --print            run the prompt once without the UI and print the reply;
                         approvals are declined unless the mode allows the action
  -h, --help             show this help
  -v, --version          show the version

Environment:
  ONEHARNESS_AUTOSTART=0    run in this one process, with no server
  ONEHARNESS_SOCKET         the server's socket (default: $XDG_RUNTIME_DIR/1harness/server.sock)
  ONEHARNESS_SERVER         the server to use, as -S names one
  ONEHARNESS_CLAUDE_PATH    claude executable (default: claude on PATH)
  ONEHARNESS_CODEX_PATH     codex executable (default: codex on PATH)
  ONEHARNESS_OPENCODE_PATH  opencode executable (default: opencode on PATH)
`;

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find((entry) => entry === value);
  if (!match) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
  return match;
}

// The SDK warns that full access skips canUseTool; 1harness gates calls with a hook instead.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const options = rest[0] as { code?: string } | string | undefined;
  const code = typeof options === "object" ? options?.code : rest[1];
  if (code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

/**
 * Runs one prompt without the UI and prints the reply. Agents can delegate
 * here too; their tasks run in the background of this one prompt. Nobody can
 * answer approvals, so they are declined, whichever thread asks.
 */
async function print(
  harness: HarnessId,
  session: SessionOptions,
  prompt: string,
  version: string,
  extensions: string[],
): Promise<number> {
  // Modules named on the command line are where the shell is, not the thread's folder.
  const host = new Host({
    version,
    cwd: session.cwd,
    extensions: extensions.map((path) => resolve(path)),
    idleCloseMs: 0,
  });
  const client = "print";
  let rootId: string | null = null;
  let status = 1;
  let wrote = false;
  const declined = new Set<string>();
  const finished = new Promise<void>((done) => {
    host.subscribe((event) => {
      if (event.type === "notice" && event.level !== "info")
        process.stderr.write(`1harness: ${event.text}\n`);
      if (event.type === "thread") {
        for (const request of event.thread.requests) {
          const key = `${event.thread.id}\0${request.id}`;
          if (declined.has(key)) continue;
          declined.add(key);
          void host
            .call(client, "thread.respond", {
              threadId: event.thread.id,
              requestId: request.id,
              response: { kind: "cancel" },
            })
            .catch(() => {});
        }
        return;
      }
      if (event.type !== "entry" || event.threadId !== rootId) return;
      const entry = event.entry;
      switch (entry.type) {
        case "item":
          if (!entry.done) break;
          if (entry.item.kind === "assistant_message" && entry.item.text.trim() !== "") {
            process.stdout.write(`${wrote ? "\n" : ""}${entry.item.text.trim()}\n`);
            wrote = true;
          } else if (entry.item.kind === "notice" && entry.item.level !== "info") {
            process.stderr.write(`1harness: ${entry.item.text}\n`);
            // A message that could not start its turn ends the run.
            if (entry.item.level === "error" && entry.item.id.startsWith("error-")) done();
          }
          break;
        case "turn.ended":
          status = entry.status === "completed" ? 0 : 1;
          if (entry.error) process.stderr.write(`1harness: ${entry.error}\n`);
          done();
          break;
        case "session.ended":
          if (entry.error) process.stderr.write(`1harness: ${entry.error}\n`);
          done();
          break;
        default:
          break;
      }
    });
  });
  try {
    const root = await host.call(client, "thread.open", { harness, settings: session });
    rootId = root.id;
    await host.call(client, "thread.send", { threadId: root.id, text: prompt });
    await finished;
  } finally {
    await host.shutdown();
  }
  return status;
}

/**
 * Finds the server `spec` names, the local one when it names none, starting
 * a local one in the background when none answers.
 */
async function reach(spec: string | undefined) {
  const { target, label, local } = resolveServer(spec);
  // Only the local socket's server is started on demand; another machine's runs there.
  const autostart = local && "socket" in target && target.socket === socketFile();
  const hello = await ensureServer({ target, autostart });
  if (hello.minProtocol > PROTOCOL_VERSION || hello.protocol < PROTOCOL_VERSION)
    throw new Error(
      `${label} runs 1harness ${hello.version}, which this one cannot talk to${local ? "; stop it with `1harness server stop`" : ""}`,
    );
  // A local server that dies is started again, and picks up its threads parked.
  const revive = autostart ? () => ensureServer({ target, autostart: true, revive: true }) : null;
  return { target, label, local, hello, revive };
}

/**
 * A client of a server `reach` found. Extension modules are this machine's
 * files, so only a local server is given them.
 */
function socketClient(
  server: Awaited<ReturnType<typeof reach>>,
  options: { cwd: string; version: string; extensions: string[]; agent?: boolean },
): HostClient {
  const id = newClientId();
  return new HostClient(
    new SocketConnection(server.target, id, server.revive ? { revive: server.revive } : {}),
    { ...options, extensions: server.local ? options.extensions : [] },
    id,
  );
}

/** A client of the server `spec` names; it says hello when connected. */
async function connectClient(
  version: string,
  extensions: string[],
  spec: string | undefined,
  options: { agent?: boolean } = {},
): Promise<HostClient> {
  const server = await reach(spec);
  // On another machine, this folder is not there; threads start in its home.
  return socketClient(server, {
    cwd: server.local ? process.cwd() : "~",
    version,
    extensions,
    ...options,
  });
}

interface TerminalOptions {
  /** Null asks which, as on the first run. */
  harness: HarnessId | null;
  /** The harness settings.json names, which harness picks mark. */
  defaultHarness: HarnessId | null;
  session: SessionOptions;
  prompt: string | null;
  version: string;
  extensions: string[];
  warnings: string[];
  /** The server to use, as `-S` named it. */
  server: string | undefined;
  /** Whether `-C` named the folder, which on another machine is that machine's. */
  cwdGiven: string | undefined;
}

/**
 * Runs the terminal UI: through the 1harness server, started in the
 * background when none is running, so threads keep working after it quits;
 * or all in this process with ONEHARNESS_AUTOSTART=0.
 */
async function interactive(options: TerminalOptions): Promise<void> {
  const extensions = options.extensions.map((path) => resolve(path));
  const here = options.session.cwd;
  let server = options.server;
  let session = options.session;
  let prompt = options.prompt;
  let cwdGiven = options.cwdGiven;
  let warnings = options.warnings;
  // /connect ends one terminal session and starts the next on the server it chose.
  for (;;) {
    const next = await terminal({
      ...options,
      server,
      session,
      prompt,
      cwdGiven,
      warnings,
      extensions,
    });
    if (next === undefined) return;
    server = next || undefined;
    session = { ...session, cwd: here, resume: null };
    prompt = null;
    cwdGiven = undefined;
    warnings = [];
  }
}

/** One terminal session on one server; resolves with the server /connect chose next. */
async function terminal(options: TerminalOptions): Promise<string | undefined> {
  const { version, extensions } = options;
  let session = options.session;
  let client: HostClient;
  let server: ServerInfo;
  const warnings: string[] = [];
  const notes: string[] = [];
  if (process.env["ONEHARNESS_AUTOSTART"] === "0") {
    let store: Store | null = null;
    const hostWarnings = [...options.warnings];
    try {
      store = Store.open(storeFile());
    } catch (error) {
      // Another 1harness keeps the threads; this one keeps nothing, and leaves those alone.
      if (!(error instanceof StoreLocked)) throw error;
      hostWarnings.push(
        "Another 1harness is keeping threads, so this one keeps none of its own; they end when it exits.",
      );
    }
    const host = new Host({
      version,
      cwd: session.cwd,
      extensions,
      warnings: hostWarnings,
      store,
    });
    const id = newClientId();
    client = new HostClient(
      new LocalConnection(host, id, { owns: true }),
      { cwd: session.cwd, version, extensions },
      id,
    );
    server = {
      label: "local",
      local: true,
      inProcess: true,
      identity: null,
      address: "",
      pid: process.pid,
    };
  } else {
    const reached = await reach(options.server);
    const { target, label, local, hello } = reached;
    // The server reports problems with the config it read itself.
    if (hello.version !== version)
      warnings.push(
        local
          ? `The running server is 1harness ${hello.version}; \`1harness server stop\` lets the next one start as ${version}.`
          : `${label} runs 1harness ${hello.version}; this is ${version}.`,
      );
    if (!local) {
      // Folders and extension modules are the other machine's.
      session = { ...session, cwd: options.cwdGiven ?? "~" };
      if (extensions.length > 0)
        warnings.push(
          `Extensions named with -x load on this machine only; ${label} does not load them.`,
        );
      notes.push(`Connected to ${label}${hello.identity ? ` as ${hello.identity}` : ""}.`);
    }
    client = socketClient(reached, { cwd: session.cwd, version, extensions });
    server = {
      label,
      local,
      inProcess: false,
      identity: hello.identity,
      address: "socket" in target ? target.socket : target.url,
      pid: hello.pid,
    };
  }
  return new App({
    client,
    harness: options.harness,
    defaultHarness: options.defaultHarness,
    setDefault: (harness) => {
      saveSettings(configDir(), { harness });
      const file = settingsFile(configDir());
      const home = homedir() + sep;
      return file.startsWith(home) ? `~${sep}${file.slice(home.length)}` : file;
    },
    onHarness: (harness) => saveLastHarness(stateDir(), harness),
    session,
    version,
    prompt: options.prompt,
    warnings,
    notes,
    server,
    // Without a server, there is nowhere to move to.
    ...(server.inProcess
      ? {}
      : {
          connect: {
            hosts: () => loadHosts(),
            // A server that does not answer keeps the terminal where it is.
            check: async (spec: string) => {
              await reach(spec || undefined);
            },
          },
        }),
  }).run();
}

try {
  const version = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  const { args, server } = serverFlag(process.argv.slice(2));
  const [command, ...rest] = args;
  if (command === "server") {
    process.exitCode = await serverCommand(rest, version);
  } else if (command === "harnesses") {
    process.exitCode = await harnessesCommand(rest, () => connectClient(version, [], server), {
      chosen: loadSettings(configDir()).settings.harness,
      last: loadLastHarness(stateDir()),
    });
  } else if (command === "threads") {
    process.exitCode = await threadsCommand(rest, () => connectClient(version, [], server));
  } else if (command === "watch") {
    await watch(await connectClient(version, [], server), process.stdout);
  } else if (command === "op") {
    process.exitCode = await opCommand(rest, () => connectClient(version, [], server));
  } else if (command === "mcp") {
    if (rest.includes("-h") || rest.includes("--help")) process.stdout.write(MCP_HELP);
    else
      await mcpBridge({
        input: process.stdin,
        output: process.stdout,
        version,
        env: process.env,
        connect: async () => {
          const client = await connectClient(version, [], server, { agent: true });
          await client.connect();
          return client;
        },
      });
  } else if (command === "acp") {
    await acp(rest, server, version);
  } else if (command === "hosts") {
    process.exitCode = await hostsCommand(rest);
  } else if (command === "whoami") {
    process.exitCode = await whoami(server);
  } else {
    await main(args, server, version);
  }
} catch (error) {
  const message = errorMessage(error);
  process.stderr.write(`1harness: ${message}\n`);
  process.exitCode = 2;
}

/** `1harness acp`: an ACP agent over stdio until the editor closes it. */
async function acp(args: string[], server: string | undefined, version: string): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      harness: { type: "string", short: "H" },
      mode: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(ACP_HELP);
    return;
  }
  if (values.mode !== undefined && !isRuntimeMode(values.mode))
    throw new Error(`--mode must be one of: ${RUNTIME_MODES.join(", ")}`);
  const { settings } = loadSettings(configDir());
  // Agents from agents.json are harnesses too.
  registerConfiguredAgents(configDir());
  const client = await connectClient(version, [], server);
  await client.connect();
  await serveAcp({
    input: process.stdin,
    output: process.stdout,
    client,
    defaults: {
      harness: values.harness ?? settings.harness ?? loadLastHarness(stateDir()),
      mode: values.mode ?? settings.mode ?? DEFAULT_RUNTIME_MODE,
    },
    version,
  });
}

/**
 * Takes `-S`/`--server` out of the arguments, wherever it is, since every
 * command that talks to a server takes it; `ONEHARNESS_SERVER` is the default.
 */
function serverFlag(argv: string[]): { args: string[]; server: string | undefined } {
  const args: string[] = [];
  let server = process.env["ONEHARNESS_SERVER"] || undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      args.push(...argv.slice(index));
      break;
    }
    if (arg === "-S" || arg === "--server") {
      server = argv[++index];
      if (!server) throw new Error(`${arg} names a server`);
    } else if (arg.startsWith("--server=")) server = arg.slice("--server=".length);
    else args.push(arg);
  }
  return { args, server };
}

async function main(argv: string[], server: string | undefined, version: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: "string", short: "H" },
      model: { type: "string", short: "m" },
      effort: { type: "string", short: "e" },
      mode: { type: "string" },
      plan: { type: "boolean" },
      cwd: { type: "string", short: "C" },
      resume: { type: "string", short: "r" },
      extension: { type: "string", short: "x", multiple: true },
      print: { type: "boolean", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    process.stdout.write(help);
  } else if (values.version) {
    process.stdout.write(`${version}\n`);
  } else {
    const { settings, warnings: settingsWarnings } = loadSettings(configDir());
    // Harnesses from agents.json and extensions register later, so an unknown
    // name fails when the session starts, listing the ones there are. With no
    // default and none used before, the terminal asks; no harness is everyone's.
    const harness = values.harness ?? settings.harness ?? loadLastHarness(stateDir());
    const warnings = [...settingsWarnings, ...registerConfiguredAgents(configDir())];
    const session: SessionOptions = {
      cwd: resolve(values.cwd ?? process.cwd()),
      model: values.model ?? null,
      effort: values.effort ?? null,
      runtimeMode:
        choice<RuntimeMode>(values.mode, RUNTIME_MODES, "mode") ??
        settings.mode ??
        DEFAULT_RUNTIME_MODE,
      interactionMode: values.plan ? "plan" : "default",
      resume: values.resume ?? null,
    };
    const prompt = positionals.join(" ").trim() || null;
    const extensions = values.extension ?? [];

    // The terminal UI shows these itself; its screen would hide them on stderr.
    if (values.print || !process.stdin.isTTY || !process.stdout.isTTY)
      for (const warning of warnings) process.stderr.write(`1harness: ${warning}\n`);
    if (values.print) {
      if (!prompt) throw new Error("--print needs a prompt");
      if (!harness)
        throw new Error(
          "--print needs a harness: -H names one, and `1harness harnesses` says which are ready",
        );
      process.exitCode = await print(harness, session, prompt, version, extensions);
    } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "the interactive UI needs a terminal; use --print to run a prompt without one",
      );
    } else {
      await interactive({
        harness,
        defaultHarness: settings.harness,
        session,
        prompt,
        version,
        extensions,
        warnings,
        server,
        cwdGiven: values.cwd,
      });
    }
  }
}
