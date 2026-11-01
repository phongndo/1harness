import type { McpAction, McpServer, ModelOption, ThreadSummary } from "../core/events.ts";
import type { ThreadListing } from "../protocol.ts";
import { errorMessage } from "../core/thread.ts";
import { MODE_DESCRIPTIONS } from "../core/wording.ts";
import {
  completion,
  liveSession,
  type CommandContext,
  type CommandDefinition,
  type Completions,
} from "./registry.ts";
import { describeMcpServer, mcpListReport, mcpServerReport } from "./reports.ts";

const MCP_ACTIONS: Record<McpAction, { description: string; progress: string }> = {
  login: { description: "sign in to a server", progress: "Signing in to" },
  reconnect: { description: "reconnect a server", progress: "Reconnecting" },
  enable: { description: "turn a server on", progress: "Enabling" },
  disable: { description: "turn a server off", progress: "Disabling" },
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchesModel(option: ModelOption, model: string | null | undefined): boolean {
  return (
    model !== null && model !== undefined && (option.id === model || option.aliases.includes(model))
  );
}

function models(context: CommandContext): Promise<ModelOption[]> {
  return context.fetch("models", () => listModels(context));
}

async function listModels(context: CommandContext): Promise<ModelOption[]> {
  const session = context.session();
  return session.listModels ? await session.listModels() : [];
}

/** The harness's own earlier threads in this folder, where it lists them. */
function nativeThreads(context: CommandContext): ThreadSummary[] {
  const session = liveSession(context);
  if (!session?.listThreads) return [];
  return context.lookup("threads", async () => (await session.listThreads?.()) ?? []);
}

/** 1harness's threads, this folder's first, newest first, without the one on screen. */
async function storedThreads(context: CommandContext): Promise<ThreadListing[]> {
  const cwd = context.info?.cwd;
  const all = await context.threads("recent");
  return all
    .filter((thread) => thread.id !== context.thread?.id && thread.parentId === null)
    .toSorted((a, b) => Number(b.cwd === cwd) - Number(a.cwd === cwd) || b.updatedAt - a.updatedAt);
}

function when(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

async function mcpServers(context: CommandContext): Promise<McpServer[]> {
  const servers = (await context.session().listMcpServers?.()) ?? [];
  return servers.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The model in use, or the harness's default. */
function currentModel(context: CommandContext, options: ModelOption[]): ModelOption | undefined {
  return (
    options.find((option) => matchesModel(option, context.info?.model)) ??
    options.find((option) => option.isDefault)
  );
}

const quit: CommandDefinition = {
  name: "quit",
  aliases: ["exit"],
  description: "exit (also ctrl+d)",
  group: "General",
  run: (context) => context.exit(),
};

/** Every harness, with the current one marked. */
function harnessCompletions(context: CommandContext): Completions {
  return {
    start: 0,
    items: context
      .harnesses()
      .map((driver) =>
        completion(driver.id, driver.id === context.harness ? "current" : driver.label),
      ),
  };
}

/** The harness with this ID, or an error listing the ones there are. */
function namedHarness(context: CommandContext, name: string) {
  const all = context.harnesses();
  const driver = all.find((candidate) => candidate.id === name);
  if (!driver)
    throw new Error(`No harness named ${name}; try ${all.map((entry) => entry.id).join(", ")}`);
  return driver;
}

const newThread: CommandDefinition = {
  name: "new",
  usage: "[harness]",
  description: "start a new thread, on another harness if named",
  group: "Session",
  complete: harnessCompletions,
  run(context, args) {
    if (!args) return context.openThread();
    const driver = namedHarness(context, args);
    // Models and efforts are harness-specific, so another harness starts with its defaults.
    return context.openThread({ harness: driver.id, defaultModel: driver.id !== context.harness });
  },
};

const resume: CommandDefinition = {
  name: "resume",
  usage: "[id]",
  description: "open an earlier thread: 1harness's, such as t42, or the harness's own",
  group: "Session",
  complete: (context) => ({
    start: 0,
    items: [
      ...context
        .lookup("stored", () => storedThreads(context))
        .map((thread: ThreadListing) =>
          completion(thread.id, `${thread.harness} · ${oneLine(thread.title).slice(0, 50)}`),
        ),
      ...nativeThreads(context).map((thread) =>
        completion(thread.id, oneLine(thread.title).slice(0, 50)),
      ),
    ],
  }),
  async run(context, args) {
    if (args) {
      await context.openThread({ resume: args });
      return;
    }
    context.forget("stored");
    const stored = await storedThreads(context);
    const session = liveSession(context);
    const natives = session?.listThreads ? await session.listThreads().catch(() => []) : [];
    // A harness's thread a 1harness thread already runs is listed once, as 1harness's.
    const known = new Set(stored.map((thread) => thread.native));
    const own = natives.filter((thread) => !known.has(thread.id));
    if (stored.length === 0 && own.length === 0) {
      context.ui.notify("info", "No earlier threads in this folder.");
      return;
    }
    const cwd = context.info?.cwd;
    const harnessTab = context.harnesses().find((entry) => entry.id === context.harness)?.label;
    const choices = [
      ...stored.map((thread) => ({
        id: thread.id,
        label: oneLine(thread.title || thread.id).slice(0, 60),
        detail: `${thread.id} · ${thread.harness} · ${thread.status}${thread.cwd === cwd ? "" : ` · ${thread.cwd}`}`,
        tag: when(thread.updatedAt),
        group: "1harness",
      })),
      ...own.map((thread) => ({
        id: thread.id,
        label: oneLine(thread.title).slice(0, 60),
        detail: "",
        tag: when(thread.updatedAt),
        group: harnessTab ?? context.harness,
      })),
    ];
    const index = await context.ui.pick("Threads", choices, { filter: true, tabs: true });
    const id = index === null ? undefined : choices[index]?.id;
    if (id) await context.openThread({ resume: id });
  },
};

const harness: CommandDefinition = {
  name: "harness",
  usage: "[name] [fresh]",
  description: "move this thread to another harness, which picks up where it left off",
  group: "Session",
  complete(context, args) {
    const space = args.indexOf(" ");
    if (space === -1)
      return {
        start: 0,
        items: harnessCompletions(context).items.map((item) => ({ ...item, more: true })),
      };
    return {
      start: space + 1,
      items: [completion("fresh", "start it a new thread rather than resume its earlier one")],
    };
  },
  async run(context, args) {
    const all = context.harnesses();
    const [name = "", flag = ""] = args.split(/\s+/);
    if (flag && flag !== "fresh") throw new Error("Usage: /harness [name] [fresh]");
    const fresh = flag === "fresh";
    let chosen = name ? namedHarness(context, name) : undefined;
    if (!chosen) {
      const index = await context.ui.pick(
        "Harnesses",
        all.map((driver) => ({
          label: driver.id,
          detail: driver.unavailable ?? driver.label,
          tag: driver.id === context.harness ? "current" : "",
        })),
        {
          initial: Math.max(
            0,
            all.findIndex((driver) => driver.id === context.harness),
          ),
        },
      );
      chosen = index === null ? undefined : all[index];
    }
    if (!chosen) return;
    if (chosen.id === context.harness && liveSession(context) && !fresh) {
      context.ui.notify(
        "info",
        `Already on ${chosen.label}. /harness ${chosen.id} fresh starts it over with a handoff.`,
      );
      return;
    }
    await context.switchHarness(chosen.id, { fresh });
  },
};

const compact: CommandDefinition = {
  name: "compact",
  description: "compact the conversation context",
  group: "Session",
  available: (context) => liveSession(context)?.compact !== undefined,
  run: async (context) => {
    await context.session().compact?.();
  },
};

const unqueue: CommandDefinition = {
  name: "unqueue",
  description: "move the last queued message back into the editor",
  group: "Session",
  async run(context) {
    const message = await context.thread?.unqueue();
    if (message) context.ui.setInput(message.input.text);
  },
};

const model: CommandDefinition = {
  name: "model",
  usage: "[id]",
  description: "choose the model",
  group: "Model",
  available: (context) => liveSession(context)?.setModel !== undefined,
  complete: (context) => ({
    start: 0,
    items: context
      .lookup("models", () => listModels(context))
      .map((option: ModelOption) => completion(option.id, option.label)),
  }),
  async run(context, args) {
    const session = context.session();
    let chosen: string | null = args || null;
    if (!chosen) {
      const options = await models(context);
      const current = options.findIndex((option) => matchesModel(option, context.info?.model));
      const index = await context.ui.pick(
        "Models",
        options.map((option, position) => ({
          label: option.label,
          detail: option.description,
          tag: position === current ? "current" : "",
        })),
        { initial: Math.max(0, current), filter: true },
      );
      if (index === null) return;
      chosen = options[index]?.id ?? null;
    }
    await session.setModel?.(chosen);
    // An effort the new model lacks falls back to the model's default.
    const option = (await models(context)).find((candidate) => candidate.id === chosen);
    const effort = context.info?.effort;
    if (option && effort && option.efforts.length > 0 && !option.efforts.includes(effort)) {
      await session.setEffort?.(option.defaultEffort);
    }
    context.ui.notify("info", `Model: ${chosen ?? "default"}`);
  },
};

const effort: CommandDefinition = {
  name: "effort",
  usage: "[level]",
  description: "choose the reasoning effort",
  group: "Model",
  available: (context) => liveSession(context)?.setEffort !== undefined,
  complete(context) {
    const option = currentModel(
      context,
      context.lookup("models", () => listModels(context)),
    );
    return {
      start: 0,
      items: (option?.efforts ?? []).map((level) =>
        completion(level, level === option?.defaultEffort ? "default" : ""),
      ),
    };
  },
  async run(context, args) {
    const session = context.session();
    let chosen: string | null = args || null;
    if (!chosen) {
      const option = currentModel(context, await models(context));
      const efforts = option?.efforts ?? [];
      if (efforts.length === 0) {
        context.ui.notify("info", "This model has no effort levels to choose from.");
        return;
      }
      const current = efforts.indexOf(context.info?.effort ?? "");
      const index = await context.ui.pick(
        "Efforts",
        efforts.map((level, position) => ({
          label: level,
          detail: level === option?.defaultEffort ? "default" : "",
          tag: position === current ? "current" : "",
        })),
        { initial: Math.max(0, current) },
      );
      if (index === null) return;
      chosen = efforts[index] ?? null;
    }
    await session.setEffort?.(chosen);
    context.ui.notify("info", `Effort: ${chosen ?? "default"}`);
  },
};

const mode: CommandDefinition = {
  name: "mode",
  usage: "[mode]",
  description: "how much the agent may do without asking",
  group: "Permissions",
  available: (context) => (liveSession(context)?.capabilities.runtimeModes.length ?? 0) > 0,
  complete: (context) => ({
    start: 0,
    items: (liveSession(context)?.capabilities.runtimeModes ?? []).map((id) =>
      completion(id, MODE_DESCRIPTIONS[id]),
    ),
  }),
  async run(context, args) {
    const session = context.session();
    const modes = session.capabilities.runtimeModes;
    let chosen = modes.find((id) => id === args);
    if (!chosen) {
      const current = context.info ? modes.indexOf(context.info.runtimeMode) : -1;
      const index = await context.ui.pick(
        "Permission modes",
        modes.map((id, position) => ({
          label: id,
          detail: MODE_DESCRIPTIONS[id],
          tag: position === current ? "current" : "",
        })),
        { initial: Math.max(0, current) },
      );
      chosen = index === null ? undefined : modes[index];
    }
    if (!chosen) return;
    await session.setRuntimeMode(chosen);
    context.ui.notify("info", `Mode: ${chosen}`);
  },
};

const plan: CommandDefinition = {
  name: "plan",
  description: "toggle plan mode (also shift+tab)",
  group: "Permissions",
  available: (context) => liveSession(context)?.capabilities.planMode === true,
  async run(context) {
    const session = context.session();
    const next = session.info.interactionMode === "plan" ? "default" : "plan";
    await session.setInteractionMode(next);
    context.ui.notify("info", next === "plan" ? "Plan mode on" : "Plan mode off");
  },
};

/**
 * `/mcp [action] [server]`: lists servers, shows one, or acts on one. Server
 * names may hold spaces, so the name is everything after the action.
 */
const mcp: CommandDefinition = {
  name: "mcp",
  usage: "[show | login | reconnect | enable | disable] [server]",
  description: "list MCP servers, show one, or act on it",
  group: "Tools",
  available: (context) => liveSession(context)?.listMcpServers !== undefined,
  complete(context, args) {
    const space = args.indexOf(" ");
    if (space === -1) {
      const actions = liveSession(context)?.capabilities.mcpActions ?? [];
      return {
        start: 0,
        items: [
          completion("list", "every server and its state"),
          completion("show", "a server's tools and details", true),
          ...actions.map((action) => completion(action, MCP_ACTIONS[action].description, true)),
        ],
      };
    }
    const action = args.slice(0, space);
    if (action !== "show" && !(action in MCP_ACTIONS)) return null;
    return {
      start: space + 1,
      items: context
        .lookup("mcp", () => mcpServers(context))
        .map((server: McpServer) => completion(server.name, describeMcpServer(server))),
    };
  },
  async run(context, args) {
    const session = context.session();
    const [, action = "", rest = ""] = /^(\S*)\s*(.*)$/.exec(args) ?? [];
    context.forget("mcp");
    const servers = await context.fetch("mcp", () => mcpServers(context));
    if (action === "" || action === "list") {
      context.ui.report(mcpListReport(context.harness, servers, session.capabilities.mcpActions));
      return;
    }
    const known = action === "show" || action in MCP_ACTIONS;
    const name = known ? rest : args;
    if (!name && known) throw new Error(`Usage: /mcp ${action} NAME`);
    const server =
      servers.find((candidate) => candidate.name === name) ??
      servers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!server) throw new Error(`No MCP server named ${name}. Type /mcp to list them.`);
    if (!known || action === "show") {
      context.ui.report(mcpServerReport(server));
      return;
    }
    // Every harness says the same when it keeps an action to itself.
    if (!session.mcpAction || !session.capabilities.mcpActions.includes(action as McpAction))
      throw new Error(
        `${context.harness} does not let 1harness ${MCP_ACTIONS[action as McpAction].description}; do it in ${context.harness} itself`,
      );
    // Actions can take seconds, so a line says what is happening and then how it went.
    const settle = context.ui.progress(
      `${MCP_ACTIONS[action as McpAction].progress} ${server.name}…`,
    );
    try {
      const result = await session.mcpAction(action as McpAction, server.name);
      settle("info", result.url ? `${result.message}:\n${result.url}` : result.message);
    } catch (error) {
      settle("error", errorMessage(error));
    }
    context.forget("mcp");
  },
};

/** 1harness's own commands, registered like any extension's. */
export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  quit,
  newThread,
  resume,
  harness,
  compact,
  unqueue,
  model,
  effort,
  mode,
  plan,
  mcp,
];
