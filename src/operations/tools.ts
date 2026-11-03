import type { ToolDefinition, ToolResult } from "../extensions/api.ts";
import { isContent, runOperation, type Operation } from "./operation.ts";

/** An operation as a tool on a session's `1harness` MCP server, called as the session's agent. */
export function agentTool(operation: Operation): ToolDefinition {
  return {
    name: operation.name,
    description: operation.description,
    inputSchema: operation.inputSchema,
    ...(operation.effect === "read" ? { readOnly: true } : {}),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await runOperation(operation, operation.name, input, {
        kind: "agent",
        thread: context.thread,
        callId: context.callId ?? null,
      });
      // JSON goes as text, which the tool server sends a string as.
      return typeof result === "string" || isContent(result)
        ? result
        : JSON.stringify(result ?? null, null, 2);
    },
  };
}

/** The operations agents in 1harness threads may call, as the tools their sessions get. */
export function agentTools(operations: readonly Operation[]): ToolDefinition[] {
  return operations.filter((operation) => operation.callers.includes("agent")).map(agentTool);
}

/** A tool only agents in 1harness threads call, such as an extension's, as an operation. */
export function toolOperation(tool: ToolDefinition): Operation {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: tool.readOnly ? "read" : "act",
    callers: ["agent"],
    run: (input, { caller }) => {
      if (caller.kind !== "agent")
        throw new Error(`${tool.name} is for agents in 1harness threads`);
      return tool.execute(input, {
        thread: caller.thread,
        ...(caller.callId ? { callId: caller.callId } : {}),
      });
    },
  };
}
