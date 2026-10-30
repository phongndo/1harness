import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServer } from "../core/events.ts";
import { describeMcpServer, mcpListReport, mcpServerReport } from "./reports.ts";
import type { ReportSpan } from "./registry.ts";

function server(overrides: Partial<McpServer>): McpServer {
  return {
    name: "docs",
    state: "connected",
    source: null,
    transport: null,
    target: null,
    auth: null,
    error: null,
    tools: [],
    ...overrides,
  };
}

const text = (lines: ReportSpan[][]) => lines.map((spans) => spans.map((s) => s.text).join(""));

describe("mcpListReport", () => {
  it("aligns each server's state, tools, and source, with errors under the row", () => {
    const report = mcpListReport(
      "codex",
      [
        server({ name: "docs", tools: ["fetch", "search"], source: "~/.codex/config.toml" }),
        server({ name: "tracker", state: "failed", error: "connection refused" }),
      ],
      ["login"],
    );
    assert.equal(report.title, "MCP servers · codex");
    assert.deepEqual(text(report.lines), [
      "docs     connected  2 tools  ~/.codex/config.toml",
      "tracker  failed              ",
      "         connection refused",
      "",
      "/mcp show NAME for its tools · /mcp login NAME",
    ]);
  });

  it("says when there are no servers", () => {
    assert.deepEqual(text(mcpListReport("claude", [], []).lines), ["No MCP servers"]);
  });
});

describe("mcpServerReport", () => {
  it("lists what is known about one server", () => {
    const report = mcpServerReport(
      server({
        transport: "stdio",
        target: "npx -y docs-mcp",
        source: "project",
        tools: ["fetch", "search"],
      }),
    );
    assert.deepEqual(text(report.lines), [
      "state      connected",
      "source     project",
      "transport  stdio",
      "command    npx -y docs-mcp",
      "tools      2 tools: fetch, search",
    ]);
    assert.equal(describeMcpServer(server({ state: "needs-login" })), "needs sign-in");
  });
});
