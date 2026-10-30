import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadMcpConfig } from "./mcp-config.ts";

describe("loadMcpConfig", () => {
  it("reads both files, fills variables, and skips what it cannot use", () => {
    const root = mkdtempSync(join(tmpdir(), "1harness-mcp-"));
    try {
      mkdirSync(join(root, "project", ".1harness"), { recursive: true });
      writeFileSync(
        join(root, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            docs: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "${DOCS_TOKEN}" } },
            tracker: { url: "https://user.example/mcp" },
            "bad name": { command: "x" },
            missing: { url: "https://x/${NOPE}" },
          },
        }),
      );
      writeFileSync(
        join(root, "project", ".1harness", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            tracker: { type: "http", url: "https://project.example/mcp", headers: { A: "b" } },
          },
        }),
      );
      const config = loadMcpConfig(root, join(root, "project"), { DOCS_TOKEN: "secret" });
      assert.deepEqual(config.servers, {
        docs: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "secret" } },
        tracker: { type: "http", url: "https://project.example/mcp", headers: { A: "b" } },
      });
      assert.equal(config.warnings.length, 2);
      assert.match(config.warnings.join("\n"), /bad name: names may use/);
      assert.match(config.warnings.join("\n"), /missing: \$\{NOPE\} is not set/);
      assert.deepEqual(loadMcpConfig(join(root, "none"), null).servers, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
