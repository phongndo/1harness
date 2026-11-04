import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Host } from "./host.ts";
import budget from "./agent-context-budget.json" with { type: "json" };

async function measure(settings: object): Promise<{ list: number; instructions: number }> {
  const root = mkdtempSync(join(tmpdir(), "1harness-budget-"));
  const config = join(root, "config");
  mkdirSync(config);
  writeFileSync(join(config, "settings.json"), JSON.stringify(settings));
  const host = new Host({
    version: "budget",
    cwd: root,
    configDir: config,
    stateDir: join(root, "state"),
    idleCloseMs: 0,
    store: null,
  });
  const grant = await host.tools.grant();
  assert.ok(grant && grant.config.type === "http");
  const { url, headers } = grant.config;
  const rpc = async (method: string, params: object = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await response.json()) as { result: Record<string, unknown> }).result;
  };
  try {
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
    const { tools } = (await rpc("tools/list")) as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    return {
      // What the model sees of each; annotations are for the harness.
      list: Buffer.byteLength(
        JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ),
      ),
      instructions: Buffer.byteLength(String(initialized["instructions"])),
    };
  } finally {
    grant.revoke();
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

// Every thread pays for this in every turn, so growing it should be a choice.
// Set the JSON to the measured values, and lower them whenever the text shrinks.
it("what 1harness adds to every thread's context matches the committed budget", async () => {
  const gateway = await measure({});
  const all = await measure({ toolGateway: false });
  assert.deepEqual(
    {
      toolListBytes: gateway.list,
      allToolsBytes: all.list,
      serverInstructionsBytes: gateway.instructions,
    },
    budget,
    "Tools or their descriptions changed size: update agent-context-budget.json to the measured values, on purpose",
  );
  assert.ok(gateway.list < all.list / 2, "tool_search should keep most tools out of context");
});
