import type { McpAction, McpServer, McpServerState } from "../core/events.ts";
import type { ReportSpan } from "./registry.ts";

const STATES: Record<McpServerState, { label: string; tone: ReportSpan["tone"] }> = {
  connected: { label: "connected", tone: "good" },
  starting: { label: "starting", tone: "muted" },
  "needs-login": { label: "needs sign-in", tone: "strong" },
  failed: { label: "failed", tone: "bad" },
  disabled: { label: "disabled", tone: "muted" },
  stopped: { label: "not started", tone: "muted" },
};

function span(text: string, tone: ReportSpan["tone"]): ReportSpan {
  return { text, tone };
}

function count(tools: readonly string[]): string {
  return `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
}

/** A server's state and tool count, as completion menus show it. */
export function describeMcpServer(server: McpServer): string {
  const state = STATES[server.state].label;
  return server.state === "connected" ? `${state} · ${count(server.tools)}` : state;
}

/** `/mcp`: one row per server with its state, tools, and where it is configured. */
export function mcpListReport(
  harness: string,
  servers: readonly McpServer[],
  actions: readonly McpAction[],
): { title: string; lines: ReportSpan[][] } {
  const title = `MCP servers · ${harness}`;
  if (servers.length === 0) return { title, lines: [[span("No MCP servers", "muted")]] };
  const nameWidth = Math.max(...servers.map((server) => server.name.length));
  const stateWidth = Math.max(...servers.map((server) => STATES[server.state].label.length));
  const toolsWidth = Math.max(...servers.map((server) => count(server.tools).length));
  const lines: ReportSpan[][] = [];
  for (const server of servers) {
    const state = STATES[server.state];
    const tools = server.state === "connected" ? count(server.tools) : "";
    lines.push([
      span(`${server.name.padEnd(nameWidth)}  `, "strong"),
      span(`${state.label.padEnd(stateWidth)}  `, state.tone),
      span(`${tools.padEnd(toolsWidth)}  `, "soft"),
      span(server.source ?? "", "muted"),
    ]);
    if (server.error)
      lines.push([span(" ".repeat(nameWidth + 2), "muted"), span(server.error, "bad")]);
  }
  const hints = ["/mcp show NAME for its tools", ...actions.map((action) => `/mcp ${action} NAME`)];
  lines.push([], [span(hints.join(" · "), "muted")]);
  return { title, lines };
}

/** `/mcp show NAME`: everything the harness says about one server. */
export function mcpServerReport(server: McpServer): { title: string; lines: ReportSpan[][] } {
  const state = STATES[server.state];
  const fields: [string, ReportSpan][] = [["state", span(state.label, state.tone)]];
  if (server.source) fields.push(["source", span(server.source, "soft")]);
  if (server.transport) fields.push(["transport", span(server.transport, "soft")]);
  if (server.target)
    fields.push([server.transport === "stdio" ? "command" : "url", span(server.target, "soft")]);
  if (server.auth) fields.push(["auth", span(server.auth, "soft")]);
  if (server.error) fields.push(["error", span(server.error, "bad")]);
  if (server.state === "connected" || server.tools.length > 0) {
    const names = server.tools.length > 0 ? `: ${server.tools.join(", ")}` : "";
    fields.push(["tools", span(`${count(server.tools)}${names}`, "soft")]);
  }
  const width = Math.max(...fields.map(([key]) => key.length));
  return {
    title: server.name,
    lines: fields.map(([key, value]) => [span(`${key.padEnd(width)}  `, "muted"), value]),
  };
}
