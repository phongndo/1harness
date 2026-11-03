import type { ApprovalAction, ToolPolicy } from "./events.ts";
import { record, text } from "./values.ts";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

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
  const reason = await policy({ tool, input, action: toolAction(tool, input) });
  return reason ? denyHookOutput(reason) : {};
}
