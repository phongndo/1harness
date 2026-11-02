import { JsonRpcPeer, RpcError } from "../drivers/jsonrpc.ts";
import { HOSTED_ENV, OUTSIDE_INSTRUCTIONS, mcpReply, type McpEndpoint } from "../operations/mcp.ts";
import type { HostClient } from "./client.ts";

export const MCP_HELP = `Usage: 1harness mcp

Serves 1harness's operations as an MCP server over stdio, for agents that
1harness does not run: add it to Claude Code, Codex, Cursor, Zed, or Claude
Desktop as a stdio server running \`1harness mcp\`. Through it an agent starts
threads on any harness, follows them by cursor, steers, and moves them.

It acts on no thread allowed more than "agentMode" in settings.json (auto by
default), and only people answer approvals or raise a thread's mode. Inside a
thread 1harness runs, it serves nothing: that session already has these tools
as its \`1harness\` server. -S names another machine's server.
`;

const HOSTED_INSTRUCTIONS =
  "This session runs in 1harness and has its tools on the 1harness server already; this one serves nothing.";

export interface BridgeOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  version: string;
  env: NodeJS.ProcessEnv;
  /** Connects to the server as an agent, on the first call that needs it. */
  connect: () => Promise<HostClient>;
}

/** `1harness mcp`: serves until stdin ends, then leaves the server. */
export async function mcpBridge(options: BridgeOptions): Promise<void> {
  const hosted = options.env[HOSTED_ENV] === "1";
  const held: { client: Promise<HostClient> | null } = { client: null };
  const connected = () => (held.client ??= options.connect());
  const endpoint: McpEndpoint = {
    version: options.version,
    instructions: hosted ? HOSTED_INSTRUCTIONS : OUTSIDE_INSTRUCTIONS,
    tools: async () => (hosted ? [] : (await connected()).call("operations.list", {})),
    call: async (name, input) =>
      (await (await connected()).call("operations.call", { name, input })).result,
  };
  const peer = new JsonRpcPeer(options.input, (line) => options.output.write(line), {
    name: "MCP client",
    jsonrpc: true,
  });
  peer.onRequest(async (method, params, id) => {
    const reply = (await mcpReply(
      { id, method, params: (params ?? {}) as Record<string, unknown> },
      endpoint,
    )) as { result?: unknown; error?: { code: number; message: string } };
    if (reply.error) throw new RpcError(reply.error.code, reply.error.message);
    return reply.result;
  });
  peer.onError((error) => process.stderr.write(`1harness mcp: ${String(error)}\n`));
  await new Promise<void>((resolve) => {
    options.input.on("end", resolve);
    options.input.on("close", resolve);
  });
  await held.client?.then((client) => client.close()).catch(() => {});
}
