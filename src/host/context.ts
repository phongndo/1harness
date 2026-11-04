// What 1harness itself puts in a thread's context, shown rather than hidden, and
// how to take its tools back out. The harness's own prompt and tools are its
// business and are not counted.

import { saveSettings, type Settings } from "../core/settings.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import type { Tools, ToolServer } from "../extensions/tool-server.ts";
import { required, text } from "../operations/input.ts";
import { OperationError, type Operation } from "../operations/operation.ts";
import type { ThreadManager } from "./manager.ts";
import type { Scope } from "./scope.ts";

/** A rough count, at about four characters to a token, since each model counts its own way. */
function tokens(written: string): number {
  return Math.ceil(written.length / 4);
}

function toolTokens(tool: ToolDefinition): number {
  const { name, description, inputSchema } = tool;
  return tokens(JSON.stringify({ name, description, inputSchema }));
}

export interface ContextAccess {
  readonly manager: ThreadManager;
  readonly scope: Scope;
  /** The tools every session gets. */
  shared(): ReadonlyMap<string, { tool: ToolDefinition }>;
  /** What a session sees by name, and what it reaches through the gateway. */
  exposure(own: Tools | undefined): ReturnType<ToolServer["exposure"]>;
  settings(): Settings;
  configDir(): string;
}

/** `thread_context`, which says what goes in, and `tools_set`, which changes it. */
export function contextOperations(access: ContextAccess): Operation[] {
  return [
    {
      name: "thread_context",
      description:
        "Says what 1harness itself adds to a thread's context: the tools it offers by name, those agents find with tool_search, the MCP servers it adds, and any handoff waiting to go with the next message. Tokens are estimates; the harness's own prompt is not counted.",
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string", description: "A thread's ID." } },
        required: ["threadId"],
      },
      effect: "read",
      callers: ["user", "external"],
      run: (input, { caller }) => {
        const { id, harness } = access.scope.readable(caller, required(input, "threadId"));
        const own = access.manager.extensionsOf(id)?.tools;
        const { advertised, onDemand } = access.exposure(own ? () => own : undefined);
        const named = [...advertised.keys(), ...onDemand.keys()];
        const listed = [
          ...[...access.shared()].map(([name, { tool }]) => ({ name, source: "1harness", tool })),
          // A folder's tool of the same name loses to 1harness's own, as sessions see them.
          ...[...(own ?? [])]
            .filter(([name]) => !access.shared().has(name))
            .map(([name, { extension, tool }]) => ({ name, source: extension, tool })),
          // The gateway's own, which are only ever advertised.
          ...[...advertised]
            .filter(([name]) => !access.shared().has(name) && !own?.has(name))
            .map(([name, { tool }]) => ({ name, source: "1harness", tool })),
        ];
        const tools = listed.map(({ name, source, tool }) => ({
          name,
          source,
          tokens: toolTokens(tool),
          offered: named.includes(name),
          onDemand: onDemand.has(name),
        }));
        const sum = (keep: (tool: (typeof tools)[number]) => boolean) =>
          tools.reduce((total, tool) => total + (keep(tool) ? tool.tokens : 0), 0);
        const live = access.manager.get(id);
        const waiting = live?.thread.handoff ?? null;
        const forked = live?.forkContext ?? null;
        return {
          threadId: id,
          harness,
          tools,
          // What every turn pays for, and what stays out of context until a search brings it in.
          toolTokens: sum((tool) => tool.offered && !tool.onDemand),
          onDemandTokens: sum((tool) => tool.onDemand),
          servers: access.manager.serversOf(id),
          handoffTokens: waiting ? tokens(waiting) : 0,
          forkTokens: forked ? tokens(forked) : 0,
        };
      },
    },
    {
      name: "tools_set",
      description:
        "Offers or stops offering 1harness's tools to the agents in its threads: one by name, or all of them with no name. Sessions see the change once they start again, as with /reload.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          tool: { type: "string", description: "The tool; all of them when left out." },
        },
        required: ["enabled"],
      },
      effect: "act",
      callers: ["user"],
      run: (input) => {
        const enabled = input["enabled"];
        if (typeof enabled !== "boolean")
          throw new OperationError("invalid_request", "enabled must be true or false");
        const name = text(input, "tool");
        const current = access.settings().disabledTools;
        let disabledTools: string[];
        if (!name) disabledTools = enabled ? [] : ["*"];
        else if (!enabled) disabledTools = [...new Set([...current, name])];
        else if (current.includes("*"))
          throw new OperationError(
            "invalid_request",
            "every tool is off; turn them all on first, then turn off the ones you do not want",
          );
        else disabledTools = current.filter((entry) => entry !== name);
        saveSettings(access.configDir(), { disabledTools });
        return { disabledTools };
      },
    },
  ];
}
