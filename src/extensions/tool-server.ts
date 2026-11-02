import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServerConfig } from "../core/events.ts";
import type { Thread } from "../core/thread.ts";
import { serveMcp } from "../operations/mcp-http.ts";
import type { OperationInfo } from "../operations/operation.ts";
import type { ToolDefinition } from "./api.ts";

/** One session's access: the server config to give the harness, and its thread once known. */
export interface ToolGrant {
  config: McpServerConfig;
  bind(thread: Thread): void;
  revoke(): void;
}

type Tools = () => ReadonlyMap<string, { tool: ToolDefinition }>;

/**
 * Serves tools to every harness as one MCP server over streamable HTTP on
 * localhost: the ones every session gets, such as the orchestrator's, and
 * each grant's own, such as its folder's extensions'. Each session gets its
 * own bearer token, which also tells a tool which thread called it.
 */
export class ToolServer {
  #tools: Tools;
  #version: string;
  #server: Server | null = null;
  #url: Promise<string> | null = null;
  #grants = new Map<string, { thread: Thread | null; tools: Tools }>();

  constructor(tools: () => ReadonlyMap<string, { tool: ToolDefinition }>, version: string) {
    this.#tools = tools;
    this.#version = version;
  }

  /**
   * A grant for a new session, serving the shared tools and `own`; null when
   * there is no tool to serve.
   */
  async grant(own: Tools = () => new Map()): Promise<ToolGrant | null> {
    const tools: Tools = () => new Map([...own(), ...this.#tools()]);
    if (tools().size === 0) return null;
    const url = await this.#listen();
    const token = randomBytes(24).toString("base64url");
    const grant: { thread: Thread | null; tools: Tools } = { thread: null, tools };
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
      response
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    await serveMcp(request, response, {
      version: this.#version,
      instructions:
        "1harness: hand work to agents on any harness, follow and steer its threads, and use the tools its extensions add.",
      tools: () => [...grant.tools().values()].map(({ tool }) => toolInfo(tool)),
      call: async (name, input, meta) => {
        const entry = grant.tools().get(name);
        if (!entry || !grant.thread) throw new Error("The session is still starting");
        const callId = grant.thread.callId(meta, name);
        return entry.tool.execute(input, {
          thread: grant.thread,
          ...(callId ? { callId } : {}),
        });
      },
    });
  }
}

/** A tool as an operation lists it: one only agents in 1harness threads call. */
export function toolInfo(tool: ToolDefinition): OperationInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: tool.readOnly ? "read" : "act",
    callers: ["agent"],
  };
}
