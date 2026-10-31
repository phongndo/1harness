import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServerConfig } from "../core/events.ts";
import { errorMessage, type Thread } from "../core/thread.ts";
import type { ToolDefinition, ToolResult } from "./api.ts";

// The newest first; a client asking for another gets the newest.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A tool call that waits sends a comment this often, so HTTP idle timeouts leave it be.
const KEEPALIVE_MS = 15_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** One session's access: the server config to give the harness, and its thread once known. */
export interface ToolGrant {
  config: McpServerConfig;
  bind(thread: Thread): void;
  revoke(): void;
}

/**
 * Serves extensions' tools to every harness as one MCP server over streamable
 * HTTP on localhost. Each session gets its own bearer token, which also tells
 * a tool which thread called it.
 */
export class ToolServer {
  #tools: () => ReadonlyMap<string, { tool: ToolDefinition }>;
  #version: string;
  #server: Server | null = null;
  #url: Promise<string> | null = null;
  #grants = new Map<string, { thread: Thread | null }>();

  constructor(tools: () => ReadonlyMap<string, { tool: ToolDefinition }>, version: string) {
    this.#tools = tools;
    this.#version = version;
  }

  /** A grant for a new session, or null when no extension has a tool to serve. */
  async grant(): Promise<ToolGrant | null> {
    if (this.#tools().size === 0) return null;
    const url = await this.#listen();
    const token = randomBytes(24).toString("base64url");
    const grant: { thread: Thread | null } = { thread: null };
    this.#grants.set(token, grant);
    return {
      // Tools such as delegate_task wait on other work, so calls may take long.
      config: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
        timeoutSec: 3600,
      },
      bind: (thread) => {
        grant.thread = thread;
      },
      revoke: () => {
        this.#grants.delete(token);
      },
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#url = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }

  #listen(): Promise<string> {
    this.#url ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#handle(request, response);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || !address) {
          reject(new Error("The tool server has no address"));
          return;
        }
        // Harness connections are idle between calls; nothing should keep the process alive.
        server.unref();
        resolve(`http://127.0.0.1:${address.port}/mcp`);
      });
      this.#server = server;
    });
    return this.#url;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const grant = token ? this.#grants.get(token) : undefined;
    if (!grant) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method !== "POST") {
      // No server-to-client stream: everything is a reply to a request.
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      send(response, 400, rpcError(null, -32700, errorMessage(error)));
      return;
    }
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
    // A tool call can wait on other work, so it streams where the client takes a stream.
    const single = Array.isArray(body) ? undefined : messages[0];
    if (
      single?.method === "tools/call" &&
      single.id !== undefined &&
      single.id !== null &&
      request.headers.accept?.includes("text/event-stream")
    ) {
      await stream(response, this.#reply(single, grant));
      return;
    }
    const replies = (
      await Promise.all(messages.map((message) => this.#reply(message, grant)))
    ).filter((reply) => reply !== null);
    if (replies.length === 0) {
      response.writeHead(202).end();
      return;
    }
    send(response, 200, Array.isArray(body) ? replies : replies[0]);
  }

  /** The reply to one message, or null for a notification. */
  async #reply(message: JsonRpcMessage, grant: { thread: Thread | null }): Promise<unknown> {
    if (message.id === undefined || message.id === null) return null;
    const id = message.id;
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        const asked = String(params["protocolVersion"] ?? "");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "1harness", version: this.#version },
            instructions: "Tools that 1harness extensions provide.",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [...this.#tools().values()].map(({ tool }) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            })),
          },
        };
      case "tools/call": {
        const name = String(params["name"] ?? "");
        const entry = this.#tools().get(name);
        if (!entry) return rpcError(id, -32602, `No tool named ${name}`);
        if (!grant.thread) return toolError(id, "The session is still starting");
        try {
          const input = (params["arguments"] ?? {}) as Record<string, unknown>;
          const meta = (params["_meta"] ?? {}) as Record<string, unknown>;
          const callId = grant.thread.session.mcpCallId?.(meta) ?? null;
          const result = await entry.tool.execute(input, {
            thread: grant.thread,
            ...(callId ? { callId } : {}),
          });
          return { jsonrpc: "2.0", id, result: toolResult(result) };
        } catch (error) {
          return toolError(id, errorMessage(error));
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  }
}

function toolResult(result: ToolResult): { content: unknown[]; isError?: boolean } {
  return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

function toolError(id: string | number, text: string) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Answers over an event stream: headers at once, a comment every so often while
 * the reply is pending, then the reply as the stream's one message.
 */
async function stream(response: ServerResponse, reply: Promise<unknown>): Promise<void> {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.flushHeaders();
  const timer = setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS);
  try {
    const message = await reply;
    response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  } finally {
    clearInterval(timer);
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
