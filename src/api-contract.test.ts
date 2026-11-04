import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ExtensionHost } from "./extensions/host.ts";
import { Host } from "./host/host.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import contract from "./api-contract.json" with { type: "json" };

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

/** The names a type's source lists, from where it starts to the end of its declaration. */
function names(text: string, start: string, pattern: RegExp): string[] {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, start);
  const end = text.indexOf("\n\n", from);
  const body = text.slice(from, end === -1 ? undefined : end);
  return [...new Set([...body.matchAll(pattern)].map((match) => match[1] ?? ""))].toSorted();
}

const TYPE = /\btype: "([^"]+)"/g;

async function operations() {
  const root = mkdtempSync(join(tmpdir(), "1h-contract-"));
  const host = new Host({
    version: "contract",
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
    store: null,
  });
  try {
    return host.operations
      .map(({ name, effect, callers, inputSchema }) => ({
        name,
        effect,
        callers: [...callers].toSorted(),
        input: Object.keys((inputSchema["properties"] ?? {}) as object).toSorted(),
        required: [...((inputSchema["required"] ?? []) as string[])].toSorted(),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

async function extensionApi(): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "1h-contract-"));
  const module = join(root, "keys.ts");
  writeFileSync(
    module,
    `export default function (api) { globalThis.contractApiKeys = Object.keys(api); }`,
  );
  const host = new ExtensionHost({
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    commands: null,
    ui: null,
  });
  try {
    await host.load({ path: module, scope: "flag" });
    return [...(globalThis as unknown as { contractApiKeys: string[] }).contractApiKeys].toSorted();
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// What programs and extensions build on. A change here should be a choice: adding
// is safe, and removing or changing anything clients use also bumps PROTOCOL_VERSION.
it("the API matches the committed contract", async () => {
  const protocol = source("./protocol.ts");
  const client = await import("./client/api.ts");
  const manifest = JSON.parse(source("../package.json")) as { exports: object };
  const measured = {
    protocolVersion: PROTOCOL_VERSION,
    packageExports: Object.keys(manifest.exports).toSorted(),
    clientExports: Object.keys(client).toSorted(),
    methods: names(protocol, "export interface Methods", /^ {2}"([a-z]+(?:\.[A-Za-z]+)+)": \{/gm),
    events: names(protocol, "export type HostEvent", TYPE),
    logEntries: names(protocol, "export type LogEntry", TYPE),
    uiRequests: names(protocol, "export type UiRequest", /\bmethod: "([^"]+)"/g),
    items: names(source("./core/events.ts"), "export type Item =", /\bkind: "([^"]+)"/g),
    threadEvents: [
      ...names(source("./core/events.ts"), "export type HarnessEvent", TYPE),
      ...names(source("./core/thread.ts"), "export type ThreadEvent", TYPE),
    ].toSorted(),
    extensionApi: await extensionApi(),
    operations: await operations(),
  };
  assert.deepEqual(
    measured,
    contract,
    "The API changed: update api-contract.json to the measured values, on purpose, and bump PROTOCOL_VERSION if this breaks a client",
  );
});
