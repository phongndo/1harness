import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileIndex } from "./files.ts";

describe("FileIndex", () => {
  it("finds files and folders by fuzzy path, folders marked with a slash", async () => {
    const root = mkdtempSync(join(tmpdir(), "1harness-files-"));
    mkdirSync(join(root, "src", "tui"), { recursive: true });
    writeFileSync(join(root, "src", "tui", "app.ts"), "");
    writeFileSync(join(root, "README.md"), "");
    const files = new FileIndex(root);
    try {
      assert.deepEqual(files.search("app", 5), [], "nothing before loading");
      await files.load();
      assert.equal(files.search("tuiapp", 5)[0]?.path, "src/tui/app.ts");
      // Paths that say what was typed crowd out what only fuzzily matches.
      assert.ok(files.search("src/tui/a", 10).every((match) => match.path.startsWith("src/tui/a")));
      assert.ok(
        files.search("tui", 10).some((match) => match.path === "src/tui/" && match.directory),
      );
      assert.ok(
        files.search("", 10).every((match) => match.path !== ""),
        "never the root",
      );
      assert.deepEqual(
        files.search("src/tui/", 10).map((match) => match.path),
        ["src/tui/app.ts"],
        "a folder lists what is inside it",
      );
    } finally {
      files.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
