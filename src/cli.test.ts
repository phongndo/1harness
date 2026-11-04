import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const cli = new URL("./cli.ts", import.meta.url).pathname;

describe("--help", () => {
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

  it("says what full access, the default, lets an agent do, and how to be asked instead", () => {
    assert.match(help, /full-access +never ask \(default/);
    assert.match(help, /agents run commands and change files without asking/);
    assert.match(help, /--mode\s+supervised/);
  });

  it("shows how to begin", () => {
    assert.match(help, /Examples:\n {2}1harness +start in this folder/);
  });
});
