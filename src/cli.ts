#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  type HarnessId,
  type RuntimeMode,
  type SessionOptions,
} from "./core/events.ts";
import { mentionedImages } from "./core/files.ts";
import { configDir, stateDir } from "./core/paths.ts";
import { loadSettings } from "./core/settings.ts";
import { drivers, registerConfiguredAgents } from "./drivers/index.ts";
import type { ToolDefinition } from "./extensions/api.ts";
import { ExtensionHost } from "./extensions/host.ts";
import { ThreadManager } from "./host/manager.ts";
import { Orchestrator } from "./host/orchestrator.ts";
import { ToolServer } from "./extensions/tool-server.ts";
import { App } from "./tui/app.ts";

const labels = drivers().map((driver) => driver.label);
const help = `1harness
One terminal UI for ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}` : labels.join("")}.

Usage: 1harness [options] [prompt]

Options:
  -H, --harness <name>   ${drivers()
    .map((driver) => driver.id)
    .join(", ")} (default: claude)
  -m, --model <id>       model to use (default: the harness's default)
  -e, --effort <level>   reasoning effort
      --mode <mode>      supervised, auto-edit, auto, or full-access (default: "mode"
                         in ~/.config/1harness/settings.json, else ${DEFAULT_RUNTIME_MODE})
      --plan             start in plan mode
  -C, --cwd <dir>        working folder (default: current folder)
  -r, --resume <id>      resume a native thread or session
  -x, --extension <path> load an extension module (repeatable); others load from
                         ~/.config/1harness/extensions and a trusted .1harness/extensions
  -p, --print            run the prompt once without the UI and print the reply;
                         approvals are declined unless the mode allows the action
  -h, --help             show this help
  -v, --version          show the version

Environment:
  ONEHARNESS_CLAUDE_PATH    claude executable (default: claude on PATH, else the SDK's copy)
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

async function print(
  harness: HarnessId,
  session: SessionOptions,
  prompt: string,
  version: string,
  extensions: string[],
): Promise<number> {
  // Session extensions run here too, so their approval rules apply without the UI.
  const host = new ExtensionHost({
    cwd: session.cwd,
    configDir: configDir(),
    stateDir: stateDir(),
    commands: null,
    ui: null,
  });
  await host.loadAll(extensions);
  let orchestratorTools: ReadonlyMap<string, { tool: ToolDefinition }> = new Map();
  const tools = new ToolServer(() => new Map([...host.tools, ...orchestratorTools]), version);
  const manager = new ThreadManager({
    version,
    extensions: host,
    tools,
    onWarning: (text) => process.stderr.write(`1harness: ${text}\n`),
  });
  // Agents can delegate here too; their tasks run in the background of this one prompt.
  const orchestrator = new Orchestrator(manager);
  orchestratorTools = new Map(orchestrator.tools.map((tool) => [tool.name, { tool }]));
  let rootId: string | null = null;
  let status = 1;
  let wrote = false;
  const finished = new Promise<void>((done) => {
    manager.subscribe((update) => {
      if (update.type === "thread.created" && update.thread.origin === "user")
        rootId = update.thread.id;
      if (update.type !== "thread.event") return;
      const event = update.event;
      if (event.type === "request.opened") {
        // Nobody can answer, so the action is declined, whichever thread asked.
        void manager.get(update.threadId)?.thread.respond(event.request.id, { kind: "cancel" });
        return;
      }
      if (update.threadId !== rootId) return;
      switch (event.type) {
        case "item.completed":
          if (event.item.kind === "assistant_message" && event.item.text.trim() !== "") {
            process.stdout.write(`${wrote ? "\n" : ""}${event.item.text.trim()}\n`);
            wrote = true;
          } else if (event.item.kind === "notice" && event.item.level !== "info") {
            process.stderr.write(`1harness: ${event.item.text}\n`);
          }
          break;
        case "turn.ended":
          status = event.status === "completed" ? 0 : 1;
          if (event.error) process.stderr.write(`1harness: ${event.error}\n`);
          done();
          break;
        case "session.closed":
          if (event.error) process.stderr.write(`1harness: ${event.error}\n`);
          done();
          break;
        case "error":
          process.stderr.write(`1harness: ${event.message}\n`);
          done();
          break;
      }
    });
  });
  const root = await manager.create({ harness, settings: session });
  const thread = root.thread;
  const images = thread.session.capabilities.images ? mentionedImages(prompt, session.cwd) : [];
  thread.send(images.length > 0 ? { text: prompt, images } : { text: prompt });
  await finished;
  await manager.closeAll();
  await tools.close();
  await host.close();
  return status;
}

try {
  const { values, positionals } = parseArgs({
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
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  };

  if (values.help) {
    process.stdout.write(help);
  } else if (values.version) {
    process.stdout.write(`${manifest.version}\n`);
  } else {
    // Harnesses from agents.json and extensions register later, so an unknown
    // name fails when the session starts, listing the ones there are.
    const harness = values.harness ?? "claude";
    const { settings, warnings: settingsWarnings } = loadSettings(configDir());
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
      process.exitCode = await print(harness, session, prompt, manifest.version, extensions);
    } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "the interactive UI needs a terminal; use --print to run a prompt without one",
      );
    } else {
      await new App({
        harness,
        session,
        version: manifest.version,
        prompt,
        extensions,
        warnings,
      }).run();
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`1harness: ${message}\n`);
  process.exitCode = 2;
}
