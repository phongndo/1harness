import { errorMessage } from "../core/errors.ts";
import type { Params, Result } from "../protocol.ts";
import { mcpContent, type OperationInfo } from "./operation.ts";

// The newest first; a client asking for another gets the newest.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** What an MCP server serves: operations as tools, whichever transport carries them. */
export interface McpEndpoint {
  version: string;
  instructions: string;
  tools(): OperationInfo[] | Promise<OperationInfo[]>;
  /** Runs a tool; throwing reports the error to the agent as the tool's result. */
  call(name: string, input: Record<string, unknown>, meta: Record<string, unknown>): unknown;
}

/** A request to the host, as a client of it makes one. */
type HostRequest = <M extends "operations.list" | "operations.call">(
  method: M,
  params: Params<M>,
) => Promise<Result<M>>;

/** The operations a client of the host may call, served as an MCP server's tools. */
export function operationsEndpoint(
  version: string,
  instructions: string,
  request: HostRequest,
): McpEndpoint {
  return {
    version,
    instructions,
    tools: () => request("operations.list", {}),
    call: async (name, input) => (await request("operations.call", { name, input })).result,
  };
}

export function mcpTool(operation: OperationInfo) {
  return {
    name: operation.name,
    description: operation.description,
    inputSchema: operation.inputSchema,
    ...(operation.effect === "read" ? { annotations: { readOnlyHint: true } } : {}),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reply to one MCP message, or null for a notification. */
export async function mcpReply(message: unknown, endpoint: McpEndpoint): Promise<unknown> {
  if (
    !object(message) ||
    typeof message["method"] !== "string" ||
    (message["jsonrpc"] !== undefined && message["jsonrpc"] !== "2.0")
  )
    return rpcError(null, -32600, "Invalid request");
  const id = message["id"];
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    !(typeof id === "number" && Number.isFinite(id))
  )
    return rpcError(null, -32600, "Invalid request ID");
  if (id === undefined || id === null) return null;
  const params = message["params"] === undefined ? {} : message["params"];
  if (!object(params)) return rpcError(id, -32602, "params must be a JSON object");
  try {
    return await reply(message["method"], id, params, endpoint);
  } catch (error) {
    return rpcError(id, -32603, errorMessage(error));
  }
}

async function reply(
  method: string,
  id: string | number,
  params: Record<string, unknown>,
  endpoint: McpEndpoint,
): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = String(params["protocolVersion"] ?? "");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "1harness", version: endpoint.version },
          instructions: endpoint.instructions,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: (await endpoint.tools()).map(mcpTool) } };
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string") return rpcError(id, -32602, "name must be a string");
      const input = params["arguments"] === undefined ? {} : params["arguments"];
      const meta = params["_meta"] === undefined ? {} : params["_meta"];
      if (!object(input) || !object(meta))
        return rpcError(id, -32602, "arguments and _meta must be JSON objects");
      if (!(await endpoint.tools()).some((tool) => tool.name === name))
        return rpcError(id, -32602, `No tool named ${name}`);
      try {
        return { jsonrpc: "2.0", id, result: mcpContent(await endpoint.call(name, input, meta)) };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: errorMessage(error) }], isError: true },
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Set in 1harness's own process, so harnesses it runs inherit it: a
 * `1harness mcp` they start serves nothing, since their session has the tools.
 */
export const HOSTED_ENV = "ONEHARNESS_HOSTED";

/** What an agent outside 1harness is told the server is for. */
export const OUTSIDE_INSTRUCTIONS =
  "1harness runs agents on Claude Code, Codex, OpenCode, and ACP harnesses in a server that outlives any terminal. Start work with thread_open, follow it with thread_events (keep its cursor) or thread_wait, and steer it with thread_send.";
