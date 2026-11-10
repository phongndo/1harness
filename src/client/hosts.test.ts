import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadHosts, resolveServer } from "./hosts.ts";

const root = mkdtempSync(join(tmpdir(), "1harness-host-resolution-"));
const env = { XDG_CONFIG_HOME: root };
const folder = join(root, "1harness");
mkdirSync(folder);
after(() => rmSync(root, { recursive: true, force: true }));

function write(value: unknown): void {
  writeFileSync(join(folder, "hosts.json"), JSON.stringify(value));
}

describe("host resolution", () => {
  it("rejects cycles of aliases without exhausting the stack", () => {
    write({ hosts: { first: "second", second: "first" } });
    assert.throws(() => resolveServer("first", env), /cycle.*first.*second.*first/i);
  });

  it("resolves a chain while keeping its original label", () => {
    write({ hosts: { first: "second", second: "box:7330" } });
    assert.deepEqual(resolveServer("first", env), {
      target: { url: "http://box:7330" },
      local: false,
      label: "first",
    });
  });

  it("rejects malformed host maps and empty addresses", () => {
    for (const value of [
      null,
      [],
      { hosts: [] },
      { hosts: "box" },
      { hosts: { box: 1 } },
      { hosts: { box: " " } },
    ]) {
      write(value);
      assert.throws(() => loadHosts(env), /hosts\.json/);
    }
  });

  it("does not resolve inherited object properties as hosts", () => {
    write({ hosts: {} });
    assert.throws(() => resolveServer("constructor", env), /No server named constructor/);
  });
});
