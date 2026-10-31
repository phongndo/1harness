import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fitRuntimeMode } from "./events.ts";
import { loadSettings } from "./settings.ts";

describe("loadSettings", () => {
  it("reads the start mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    try {
      assert.deepEqual(loadSettings(dir), { settings: { mode: null }, warnings: [] });
      writeFileSync(join(dir, "settings.json"), '{ "mode": "auto" }');
      assert.deepEqual(loadSettings(dir), { settings: { mode: "auto" }, warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts in supervised, with a warning, when the file is broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    const file = join(dir, "settings.json");
    try {
      for (const text of ['{ "mode": "Supervised" }', "{", "null", "[]"]) {
        writeFileSync(file, text);
        const loaded = loadSettings(dir);
        assert.equal(loaded.settings.mode, "supervised", text);
        assert.match(loaded.warnings[0] ?? "", /threads start in supervised until it is fixed/);
      }
      // A file that exists but cannot be read is not the same as no file.
      rmSync(file);
      mkdirSync(file);
      assert.equal(loadSettings(dir).settings.mode, "supervised");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fitRuntimeMode", () => {
  it("steps down to the broadest mode offered, never up", () => {
    assert.equal(fitRuntimeMode("full-access", ["supervised", "auto-edit", "auto"]), "auto");
    assert.equal(fitRuntimeMode("auto", ["supervised", "auto-edit", "full-access"]), "auto-edit");
    assert.equal(fitRuntimeMode("auto-edit", ["auto-edit"]), "auto-edit");
    assert.equal(fitRuntimeMode("supervised", ["auto", "full-access"]), null);
  });
});
