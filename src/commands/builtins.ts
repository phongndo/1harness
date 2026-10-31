import type { McpAction, McpServer, ModelOption, ThreadSummary } from "../core/events.ts";
import { errorMessage } from "../core/thread.ts";
import { MODE_DESCRIPTIONS } from "../core/wording.ts";
import { drivers } from "../drivers/index.ts";
import {
  completion,
  liveSession,
  type CommandContext,
  type CommandDefinition,
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

function threads(context: CommandContext): ThreadSummary[] {
  return context.lookup("threads", async () => (await context.session().listThreads?.()) ?? []);
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

const newThread: CommandDefinition = {
  name: "new",
  description: "start a new thread",
  group: "Session",
  run: (context) => context.openThread(),
};

const resume: CommandDefinition = {
  name: "resume",
  usage: "[id]",
  description: "resume an earlier thread in this folder",
  group: "Session",
  available: (context) => liveSession(context)?.listThreads !== undefined,
  complete: (context) => ({
    start: 0,
    items: threads(context).map((thread) =>
      completion(thread.id, oneLine(thread.title).slice(0, 50)),
    ),
  }),
  async run(context, args) {
    let id = args || undefined;
    if (!id) {
      const list = (await context.session().listThreads?.()) ?? [];
      if (list.length === 0) {
        context.ui.notify("info", "No earlier threads in this folder.");
        return;
      }
      const index = await context.ui.pick(
        "Threads",
        list.map((thread) => ({
          label: oneLine(thread.title).slice(0, 60),
          tag: new Date(thread.updatedAt).toLocaleString(),
        })),
        { filter: true },
      );
      id = index === null ? undefined : list[index]?.id;
    }
    if (id) await context.openThread({ resume: id });
  },
};

const harness: CommandDefinition = {
  name: "harness",
  usage: "[name]",
  description: "switch harness in a new thread",
  group: "Session",
  complete: (context) => ({
    start: 0,
    items: drivers().map((driver) =>
      completion(driver.id, driver.id === context.harness ? "current" : driver.label),
    ),
  }),
  async run(context, args) {
    const all = drivers();
    let chosen = all.find((driver) => driver.id === args);
    if (!chosen) {
      const index = await context.ui.pick(
        "Harnesses",
        all.map((driver) => ({
          label: driver.id,
          detail: driver.unavailable(process.env) ?? driver.label,
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
    // Models and efforts are harness-specific, so the new thread uses its defaults.
    if (chosen) await context.openThread({ harness: chosen.id, defaultModel: true });
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

const stop: CommandDefinition = {
  name: "stop",
  description: "interrupt the running turn (also esc)",
  group: "Session",
  run: async (context) => {
    await context.thread?.interrupt();
  },
};

const unqueue: CommandDefinition = {
  name: "unqueue",
  description: "move the last queued message back into the editor",
  group: "Session",
  run(context) {
    const input = context.thread?.unqueue();
    if (input) context.ui.setInput(input.text);
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
  stop,
  unqueue,
  model,
  effort,
  mode,
  plan,
  mcp,
];
