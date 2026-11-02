// Keeps prose out of the repository: docs written apart from the code fall out
// of sync with it. See AGENTS.md.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url).pathname;

const ALLOWED = new Set(["AGENTS.md", "CLAUDE.md", "README.md"]);
const PROSE = /\.(md|mdx|markdown|html?|txt|rst|adoc)$/i;
const README_LINES = 60;

function files(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

describe("docs", () => {
  it("adds no prose files beyond README.md and AGENTS.md", () => {
    const extra = files().filter((file) => PROSE.test(file) && !ALLOWED.has(file));
    assert.deepEqual(extra, [], "describe behavior in --help, /help, tests, or comments instead");
  });

  it(`keeps README.md under ${README_LINES} lines`, () => {
    const lines = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").length;
    assert.ok(
      lines <= README_LINES,
      `README.md has ${lines} lines; it is an entry point, not a manual`,
    );
  });
});
