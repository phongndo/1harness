import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fitRuntimeMode } from "./events.ts";
import {
  loadLastHarness,
  loadSettings,
  saveLastHarness,
  saveSettings,
  toolDisabled,
} from "./settings.ts";

describe("loadSettings", () => {
  it("reads which tools are not offered, and says when it cannot", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    try {
      writeFileSync(join(dir, "settings.json"), '{ "disabledTools": ["delegate_task"] }');
      const { settings } = loadSettings(dir);
      assert.deepEqual(settings.disabledTools, ["delegate_task"]);
      assert.equal(toolDisabled(settings, "delegate_task"), true);
      assert.equal(toolDisabled(settings, "thread_read"), false);
      assert.equal(toolDisabled({ disabledTools: ["*"] }, "thread_read"), true);
      writeFileSync(join(dir, "settings.json"), '{ "disabledTools": "all" }');
      const bad = loadSettings(dir);
      assert.deepEqual(bad.settings.disabledTools, []);
      assert.match(bad.warnings[0] ?? "", /disabledTools must be a list/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the start mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    try {
      assert.deepEqual(loadSettings(dir), {
        settings: {
          harness: null,
          mode: null,
          retainClosedDays: null,
          agentMode: null,
          disabledTools: [],
        },
        warnings: [],
      });
      writeFileSync(join(dir, "settings.json"), '{ "mode": "auto" }');
      assert.deepEqual(loadSettings(dir), {
        settings: {
          harness: null,
          mode: "auto",
          retainClosedDays: null,
          agentMode: null,
          disabledTools: [],
        },
        warnings: [],
      });
      writeFileSync(join(dir, "settings.json"), '{ "retainClosedDays": 30 }');
      assert.equal(loadSettings(dir).settings.retainClosedDays, 30);
      // A bad number keeps everything, and says so.
      writeFileSync(join(dir, "settings.json"), '{ "retainClosedDays": "soon" }');
      const kept = loadSettings(dir);
      assert.equal(kept.settings.retainClosedDays, null);
      assert.match(kept.warnings[0] ?? "", /retainClosedDays/);
      writeFileSync(join(dir, "settings.json"), '{ "agentMode": "auto-edit" }');
      assert.equal(loadSettings(dir).settings.agentMode, "auto-edit");
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
        assert.equal(loaded.settings.agentMode, "supervised", text);
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

describe("the harness setting", () => {
  it("names the harness to start, and asks when it is not a name", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    try {
      writeFileSync(join(dir, "settings.json"), '{ "harness": "codex" }');
      assert.equal(loadSettings(dir).settings.harness, "codex");
      writeFileSync(join(dir, "settings.json"), '{ "harness": 3, "mode": "auto" }');
      const loaded = loadSettings(dir);
      assert.equal(loaded.settings.harness, null);
      assert.equal(loaded.settings.mode, "auto");
      assert.match(loaded.warnings[0] ?? "", /harness must be a harness's name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the harness used last", () => {
  it("is kept in the state folder, and is none before any", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-state-"));
    try {
      assert.equal(loadLastHarness(join(dir, "state")), null);
      saveLastHarness(join(dir, "state"), "codex");
      assert.equal(loadLastHarness(join(dir, "state")), "codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("saveSettings", () => {
  it("sets a key and keeps the rest as written", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    const config = join(dir, "config");
    try {
      saveSettings(config, { harness: "opencode" });
      assert.equal(loadSettings(config).settings.harness, "opencode");
      writeFileSync(join(config, "settings.json"), '{ "mode": "auto", "other": [1] }');
      saveSettings(config, { harness: "fx" });
      assert.deepEqual(JSON.parse(readFileSync(join(config, "settings.json"), "utf8")), {
        mode: "auto",
        other: [1],
        harness: "fx",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a file it cannot read as settings alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "1harness-settings-"));
    const file = join(dir, "settings.json");
    try {
      for (const text of ["{", "[]"]) {
        writeFileSync(file, text);
        assert.throws(() => saveSettings(dir, { harness: "codex" }));
        assert.equal(readFileSync(file, "utf8"), text);
      }
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
