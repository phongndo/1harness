import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServerConfig, ToolPolicy } from "../core/events.ts";
import type { Thread } from "../core/thread.ts";
import { ownToolCheck } from "../core/tools.ts";
import { serveMcp } from "../operations/mcp-http.ts";
import type { OperationInfo } from "../operations/operation.ts";
import type { ToolDefinition } from "./api.ts";
import { gatewayTools } from "./tool-gateway.ts";

/** One session's access: the server config to give the harness, and its thread once known. */
export interface ToolGrant {
  config: McpServerConfig;
  bind(thread: Thread): void;
  revoke(): void;
}

export type Tools = () => ReadonlyMap<string, { tool: ToolDefinition }>;

/** The policy for a thread's calls as things stand, if any. */
export type GrantPolicy = (thread: Thread) => ToolPolicy | undefined;

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
  #grants = new Map<string, { thread: Thread | null; tools: Tools; policy: GrantPolicy }>();
  #disabled: () => (name: string) => boolean;
  #gateway: () => boolean;

  /**
   * `disabled` says, as things stand, which tools to keep from sessions' lists
   * and calls; `gateway`, whether to offer all but `direct` tools through
   * `tool_search`.
   */
  constructor(
    tools: () => ReadonlyMap<string, { tool: ToolDefinition }>,
    version: string,
    disabled: () => (name: string) => boolean = () => () => false,
    gateway: () => boolean = () => false,
  ) {
    this.#tools = tools;
    this.#version = version;
    this.#disabled = disabled;
    this.#gateway = gateway;
  }

  /** What a session sees by name, and what it reaches through the gateway, as things stand. */
  exposure(own: Tools = () => new Map()): {
    advertised: ReadonlyMap<string, { tool: ToolDefinition }>;
    onDemand: ReadonlyMap<string, ToolDefinition>;
  } {
    const off = this.#disabled();
    const all = [...own(), ...this.#tools()].filter(([name]) => !off(name));
    const onDemand = new Map(
      all.filter(([, { tool }]) => !tool.direct).map(([name, { tool }]) => [name, tool]),
    );
    if (!this.#gateway() || onDemand.size === 0)
      return { advertised: new Map(all), onDemand: new Map() };
    const direct = all.filter(([, { tool }]) => tool.direct);
    const gateway = gatewayTools(onDemand).map((tool) => [tool.name, { tool }] as const);
    return { advertised: new Map([...direct, ...gateway]), onDemand };
  }

  /**
   * A grant for a new session, serving the shared tools and `own`; null when
   * there is no tool to serve. `policy` can block any call, a reason it gives
   * going to the agent as the tool's failure. This runs these tools, so it holds
   * on every harness, whatever the harness's own hooks can do.
   */
  async grant(
    own: Tools = () => new Map(),
    policy: GrantPolicy = () => undefined,
  ): Promise<ToolGrant | null> {
    const tools: Tools = () => this.exposure(own).advertised;
    if (tools().size === 0) return null;
    const url = await this.#listen();
    const token = randomBytes(24).toString("base64url");
    const grant = { thread: null as Thread | null, tools, policy };
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
        "1harness: hand work to agents on any harness, follow and steer its threads, and use the tools its extensions add. tool_search finds what is not listed.",
      tools: () => [...grant.tools().values()].map(({ tool }) => toolInfo(tool)),
      call: async (name, input, meta) => {
        const entry = grant.tools().get(name);
        const thread = grant.thread;
        if (!entry || !thread) throw new Error("The session is still starting");
        // Before the policy's wait: OpenCode's call IDs go by which calls are running now.
        const callId = thread.callId(meta, name);
        const reason = await grant.policy(thread)?.(ownToolCheck(name, input));
        if (reason) throw new Error(reason);
        return entry.tool.execute(input, {
          thread,
          ...(callId ? { callId } : {}),
        });
      },
    });
  }
}

/** A tool as an operation lists it: one only agents in 1harness threads call. */
function toolInfo(tool: ToolDefinition): OperationInfo {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: tool.readOnly ? "read" : "act",
    callers: ["agent"],
  };
}
