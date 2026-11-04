import type { ApprovalAction, ToolPolicy } from "./events.ts";
import { record, text } from "./values.ts";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export const GATEWAY_SEARCH = "tool_search";
export const GATEWAY_READ = "tool_read";
export const GATEWAY_ACT = "tool_act";
/** The MCP server harnesses reach 1harness's tools on. */
export const TOOL_SERVER = "1harness";

/**
 * The tool a call through 1harness's gateway reaches, with its input, or null
 * for any other call. Everything that looks at a tool call goes through this,
 * so approvals, policies, and the transcript see the tool that really runs.
 */
export function gatewayCall(
  server: string | null,
  tool: string,
  input: unknown,
): { tool: string; input: unknown } | null {
  if (server !== TOOL_SERVER || (tool !== GATEWAY_READ && tool !== GATEWAY_ACT)) return null;
  const fields = record(input);
  const name = fields["name"];
  if (typeof name !== "string" || name === "") return null;
  return { tool: name, input: gatewayInput(fields["input"]) };
}

function gatewayInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Whether a harness's tool name is one of the gateway's two calls, whichever tool it reaches. */
export function isGatewayName(name: string): boolean {
  return new RegExp(`(^|[^a-z])(${GATEWAY_READ}|${GATEWAY_ACT})$`).test(name);
}

/**
 * What a tool call does, from the tool's name and input. Claude Code and
 * Codex both name tools this way in permission checks and hooks.
 */
export function toolAction(tool: string, input: unknown): ApprovalAction {
  const fields = record(input);
  if (tool === "Bash" && typeof fields["command"] === "string") {
    return { type: "command", command: fields["command"], cwd: null };
  }
  const path = fields["file_path"] ?? fields["notebook_path"];
  if (EDIT_TOOLS.has(tool) && typeof path === "string")
    return { type: "file_change", paths: [path] };
  const mcp = mcpTool(tool);
  const inner = mcp && gatewayCall(mcp.server, mcp.tool, input);
  if (mcp && inner)
    return { type: "tool", tool: inner.tool, server: mcp.server, input: inner.input };
  return { type: "tool", tool: mcp?.tool ?? tool, server: mcp?.server ?? null, input };
}

/** The server and tool an MCP tool's name joins, as in `mcp__docs__search`. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? [];
  return server && tool ? { server, tool } : null;
}

/** A PreToolUse hook's output, as Claude Code and Codex read it. */
export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** The hook output that blocks a call, telling the agent why. */
export function denyHookOutput(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** The output for a PreToolUse hook's input, as Claude Code and Codex send it, as a tool policy decides. */
export async function checkToolHook(
  policy: ToolPolicy | undefined,
  hook: unknown,
): Promise<HookOutput> {
  const fields = record(hook);
  if (!policy || fields["hook_event_name"] !== "PreToolUse") return {};
  const tool = text(fields["tool_name"]);
  const input = fields["tool_input"];
  const mcp = mcpTool(tool);
  const inner = mcp && gatewayCall(mcp.server, mcp.tool, input);
  const reason = await policy({
    tool: mcp && inner ? `mcp__${mcp.server}__${inner.tool}` : tool,
    input: inner ? inner.input : input,
    action: toolAction(tool, input),
  });
  return reason ? denyHookOutput(reason) : {};
}
