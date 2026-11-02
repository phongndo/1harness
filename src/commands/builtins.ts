import type { McpAction, McpServer, ModelOption } from "../core/events.ts";
import type { HarnessInfo, ThreadListing } from "../protocol.ts";
import { looksLikeThreadId, shortThreadId } from "../core/thread-id.ts";
import { errorMessage } from "../core/thread.ts";
import { EFFORT_DESCRIPTIONS, HARNESS_STATES, MODE_DESCRIPTIONS } from "../core/wording.ts";
import {
  completion,
  liveSession,
  type CommandContext,
  type CommandDefinition,
  type Completions,
  type PickEntry,
} from "./registry.ts";
import { describeMcpServer, mcpListReport, mcpServerReport } from "./reports.ts";

const MCP_ACTIONS: Record<McpAction, { description: string; progress: string }> = {
  login: { description: "sign in to a server", progress: "Signing in to" },
  reconnect: { description: "reconnect a server", progress: "Reconnecting" },
  enable: { description: "turn a server on", progress: "Enabling" },
  disable: { description: "turn a server off", progress: "Disabling" },
};

function isMcpAction(action: string): action is McpAction {
  return Object.hasOwn(MCP_ACTIONS, action);
}

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

/**
 * A list a completion offers, kept for the thread; none while the thread is
 * parked, whose harness is not started just to complete a word.
 */
function listed<T>(context: CommandContext, key: string, load: () => Promise<T[]>): T[] {
  return context.thread?.parked ? [] : context.lookup(key, load);
}

/** 1harness's threads, this folder's first, newest first, without the one on screen. */
async function storedThreads(context: CommandContext): Promise<ThreadListing[]> {
  const cwd = context.info?.cwd;
  const all = await context.threads("recent");
  return all
    .filter((thread) => thread.id !== context.thread?.id && thread.parentId === null)
    .toSorted((a, b) => Number(b.cwd === cwd) - Number(a.cwd === cwd) || b.updatedAt - a.updatedAt);
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

/** A harness as a pick lists it: where it stands, and what to do about that. */
export function harnessEntry(
  harness: HarnessInfo,
  current: string | null,
  chosen: string | null,
): PickEntry {
  const marks = [harness.id === current ? "current" : "", harness.id === chosen ? "default" : ""];
  // Ready goes without saying beside a mark.
  if (harness.state !== "ready" || !marks.some(Boolean)) marks.push(HARNESS_STATES[harness.state]);
  return {
    label: harness.id,
    detail: harness.detail ? `${harness.label} · ${harness.detail}` : harness.label,
    tag: marks.filter(Boolean).join(" · "),
  };
}

/** Every harness, with the current one marked, and those that cannot run saying why. */
function harnessCompletions(context: CommandContext): Completions {
  return {
    start: 0,
    items: context
      .harnesses()
      .map((harness) =>
        completion(
          harness.id,
          [
            harness.id === context.harness ? "current" : harness.label,
            harness.unavailable ? HARNESS_STATES[harness.state] : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
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
  usage: "[harness] [model] [effort]",
  description: "start a new thread, on a harness, model, and effort if named",
  group: "Threads",
  complete(context, args) {
    const words = args.split(" ");
    const start = args.length - (words.at(-1) ?? "").length;
    const [named = "", chosen = ""] = words;
    // A harness's models are known only while one of its threads runs.
    const options =
      named === context.harness ? listed(context, "models", () => listModels(context)) : [];
    switch (words.length) {
      case 1:
        return harnessCompletions(context);
      case 2:
        return { start, items: options.map((option) => completion(option.id, option.label)) };
      case 3: {
        const option = options.find((candidate) => matchesModel(candidate, chosen));
        const levels = option?.efforts ?? Object.keys(EFFORT_DESCRIPTIONS);
        return {
          start,
          items: levels.map((level) =>
            completion(
              level,
              [EFFORT_DESCRIPTIONS[level], level === option?.defaultEffort ? "default" : ""]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
        };
      }
      default:
        return null;
    }
  },
  run(context, args) {
    const words = args.split(/\s+/).filter(Boolean);
    if (words.length > 3) throw new Error("Usage: /new [harness] [model] [effort]");
    const [name, model = null, effort = null] = words;
    if (name === undefined) return context.openThread();
    const driver = namedHarness(context, name);
    // Models and efforts are harness-specific, so another harness starts with its defaults.
    if (model === null)
      return context.openThread({
        harness: driver.id,
        defaultModel: driver.id !== context.harness,
      });
    return context.openThread({ harness: driver.id, model, effort });
  },
};

const resume: CommandDefinition = {
  name: "resume",
  usage: "[id | words]",
  description: "pick up a thread, by its ID, or search what threads said (also ctrl+t)",
  group: "Threads",
  complete: (context) => ({
    start: 0,
    items: context
      .lookup("stored", () => storedThreads(context))
      .map((thread: ThreadListing) =>
        completion(
          shortThreadId(thread.id),
          `${oneLine(thread.title).slice(0, 50)} · ${[thread.harness, thread.model, thread.effort].filter(Boolean).join(" · ")}`,
        ),
      ),
  }),
  async run(context, args) {
    // An ID, 1harness's or the start of one, or a harness's own session's, opens that thread.
    if (looksLikeThreadId(args) || /^[\w-]{16,}$/.test(args)) {
      await context.openThread({ resume: args });
      return;
    }
    if (!context.ui.threads) {
      if (!args) throw new Error("Usage: /resume <id>");
      await context.openThread({ resume: args });
      return;
    }
    await context.ui.threads(args);
  },
};

const lineage: CommandDefinition = {
  name: "lineage",
  description: "watch the agents under this thread, and go in and out of them",
  group: "Threads",
  async run(context) {
    if (!context.ui.lineage) throw new Error("/lineage needs the terminal's thread list");
    await context.ui.lineage();
  },
};

const harness: CommandDefinition = {
  name: "harness",
  usage: "[name] [fresh]",
  description: "move this thread to another harness, which picks up where it left off",
  group: "Model",
  complete(context, args) {
    const space = args.indexOf(" ");
    // `fresh` may follow a harness, but need not, so enter on one runs the switch.
    if (space === -1) return harnessCompletions(context);
    return {
      start: space + 1,
      items: [completion("fresh", "start a new session there rather than resume its earlier one")],
    };
  },
  async run(context, args) {
    const [name = "", flag = ""] = args.split(/\s+/);
    // A pick shows where each stands now, such as one signed in since.
    const all = name ? context.harnesses() : await context.checkHarnesses();
    if (flag && flag !== "fresh") throw new Error("Usage: /harness [name] [fresh]");
    const fresh = flag === "fresh";
    let chosen = name ? namedHarness(context, name) : undefined;
    if (!chosen) {
      const index = await context.ui.pick(
        "Harnesses",
        all.map((driver) => harnessEntry(driver, context.harness, context.defaultHarness)),
        {
          initial: Math.max(
            0,
            all.findIndex((driver) => driver.id === context.harness),
          ),
          ...(context.setDefaultHarness
            ? {
                save: {
                  hint: "use and make default",
                  run: (row: number) => {
                    const picked = all[row];
                    if (picked) context.setDefaultHarness?.(picked.id);
                  },
                },
              }
            : {}),
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
  group: "Threads",
  available: (context) => liveSession(context)?.compact !== undefined,
  run: async (context) => {
    await context.session().compact?.();
  },
};

const unqueue: CommandDefinition = {
  name: "unqueue",
  description: "move the last queued message back into the editor",
  group: "Threads",
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
    items: listed(context, "models", () => listModels(context)).map((option: ModelOption) =>
      completion(option.id, option.label),
    ),
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
      listed(context, "models", () => listModels(context)),
    );
    return {
      start: 0,
      items: (option?.efforts ?? []).map((level) =>
        completion(
          level,
          [EFFORT_DESCRIPTIONS[level], level === option?.defaultEffort ? "default" : ""]
            .filter(Boolean)
            .join(" · "),
        ),
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
      // With none chosen, the model's default is the one in use.
      const current = efforts.indexOf(context.info?.effort ?? option?.defaultEffort ?? "");
      const index = await context.ui.pick(
        "Efforts",
        efforts.map((level, position) => ({
          label: level,
          detail: [EFFORT_DESCRIPTIONS[level], level === option?.defaultEffort ? "default" : ""]
            .filter(Boolean)
            .join(" · "),
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
    if (action !== "show" && !isMcpAction(action)) return null;
    return {
      start: space + 1,
      items: listed(context, "mcp", () => mcpServers(context)).map((server: McpServer) =>
        completion(server.name, describeMcpServer(server)),
      ),
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
    const known = action === "show" || isMcpAction(action);
    let name = known ? rest : args;
    if (!name && known) {
      // Without a name, the servers to choose from.
      if (servers.length === 0) throw new Error("No MCP servers");
      const index = await context.ui.pick(
        `MCP servers to ${isMcpAction(action) ? MCP_ACTIONS[action].description.replace(/ a server$/, "") : "show"}`,
        servers.map((server) => ({ label: server.name, detail: describeMcpServer(server) })),
        { filter: true },
      );
      const chosen = index === null ? undefined : servers[index];
      if (!chosen) return;
      name = chosen.name;
    }
    const server =
      servers.find((candidate) => candidate.name === name) ??
      servers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!server) throw new Error(`No MCP server named ${name}. Type /mcp to list them.`);
    if (!isMcpAction(action)) {
      context.ui.report(mcpServerReport(server));
      return;
    }
    // Every harness says the same when it keeps an action to itself.
    if (!session.mcpAction || !session.capabilities.mcpActions.includes(action))
      throw new Error(
        `${context.harness} does not let 1harness ${MCP_ACTIONS[action].description}; do it in ${context.harness} itself`,
      );
    // Actions can take seconds, so a line says what is happening and then how it went.
    const settle = context.ui.progress(`${MCP_ACTIONS[action].progress} ${server.name}…`);
    try {
      const result = await session.mcpAction(action, server.name);

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
  lineage,
  harness,
  compact,
  unqueue,
  model,
  effort,
  mode,
  plan,
  mcp,
];
