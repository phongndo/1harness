import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "./events.ts";

// The names Codex accepts, which Claude Code takes too.
const SERVER_NAME = /^[A-Za-z0-9_:@/.-]{1,64}$/;

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  /** Problems with the files, one per skipped server or unreadable file. */
  warnings: string[];
}

/**
 * Reads 1harness's shared MCP servers: `mcp.json` in the config folder, then
 * a trusted project's `.1harness/mcp.json`, whose servers win by name. Both use
 * the common `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`
 * shape, and `${VAR}` in any string is filled from the environment.
 */
export function loadMcpConfig(
  configDir: string,
  project: string | null,
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const config: McpConfig = { servers: {}, warnings: [] };
  const files = [join(configDir, "mcp.json")];
  if (project) files.push(join(project, ".1harness", "mcp.json"));
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
      for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
        try {
          config.servers[name] = serverConfig(name, entry, env);
        } catch (error) {
          config.warnings.push(`${file}: ${name}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      config.warnings.push(`${file}: ${(error as Error).message}`);
    }
  }
  return config;
}

function serverConfig(name: string, entry: unknown, env: NodeJS.ProcessEnv): McpServerConfig {
  if (!SERVER_NAME.test(name))
    throw new Error("names may use letters, digits, and _ : @ / . - only");
  const value = (entry ?? {}) as Record<string, unknown>;
  const fill = (text: unknown, field: string): string => {
    if (typeof text !== "string") throw new Error(`${field} must be a string`);
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const filled = env[variable];
      if (filled === undefined) throw new Error(`\${${variable}} is not set`);
      return filled;
    });
  };
  const record = (field: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries((value[field] ?? {}) as Record<string, unknown>).map(([key, text]) => [
        key,
        fill(text, `${field}.${key}`),
      ]),
    );
  if (typeof value["url"] === "string") {
    if (value["type"] === "sse")
      throw new Error("SSE servers are not supported; use streamable HTTP");
    return { type: "http", url: fill(value["url"], "url"), headers: record("headers") };
  }
  if (typeof value["command"] === "string") {
    const args = (value["args"] ?? []) as unknown[];
    if (!Array.isArray(args)) throw new Error("args must be a list");
    return {
      type: "stdio",
      command: fill(value["command"], "command"),
      args: args.map((arg, index) => fill(arg, `args[${index}]`)),
      env: record("env"),
    };
  }
  throw new Error("needs a command or a url");
}
