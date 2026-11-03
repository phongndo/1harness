import type { ApprovalAction, ToolPolicy } from "./events.ts";
import { record } from "./values.ts";

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
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return { type: "tool", tool: mcp?.[2] ?? tool, server: mcp?.[1] ?? null, input };
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

/** A PreToolUse hook's output for a call, as a tool policy decides it. */
export async function policyHookOutput(
  policy: ToolPolicy,
  tool: string,
  input: unknown,
): Promise<HookOutput> {
  const reason = await policy({ tool, input, action: toolAction(tool, input) });
  return reason ? denyHookOutput(reason) : {};
}
