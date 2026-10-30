import type { ApprovalAction } from "./events.ts";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * What a tool call does, from the tool's name and input. Claude Code and
 * Codex both name tools this way in permission checks and hooks.
 */
export function toolAction(tool: string, input: unknown): ApprovalAction {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (tool === "Bash" && typeof fields["command"] === "string") {
    return { type: "command", command: fields["command"], cwd: null };
  }
  const path = fields["file_path"] ?? fields["notebook_path"];
  if (EDIT_TOOLS.has(tool) && typeof path === "string")
    return { type: "file_change", paths: [path] };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return { type: "tool", tool: mcp?.[2] ?? tool, server: mcp?.[1] ?? null, input };
}
