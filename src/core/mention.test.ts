import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mentionedImages } from "./files.ts";

describe("mentionedImages", () => {
  it("attaches images the text mentions that exist, quoted or not", () => {
    const root = mkdtempSync(join(tmpdir(), "1harness-images-"));
    try {
      writeFileSync(join(root, "shot.png"), "");
      writeFileSync(join(root, "my shot.JPG"), "");
      const text = 'compare @shot.png? with @"my shot.JPG", not @missing.png or @notes.md';
      assert.deepEqual(mentionedImages(text, root), [
        join(root, "shot.png"),
        join(root, "my shot.JPG"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
