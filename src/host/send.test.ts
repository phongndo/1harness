import assert from "node:assert/strict";
import { readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { savePastedImages } from "./send.ts";

describe("pasted images", () => {
  it("keeps image data in a private directory and private files", () => {
    const [path] = savePastedImages([
      { type: "image/png", data: Buffer.from("image data").toString("base64") },
    ]);
    assert.ok(path);
    try {
      assert.equal(readFileSync(path, "utf8"), "image data");
      if (process.platform !== "win32") {
        assert.equal(statSync(dirname(path)).mode & 0o077, 0);
        assert.equal(statSync(path).mode & 0o077, 0);
      }
    } finally {
      rmSync(path);
      rmdirSync(dirname(path));
    }
  });
});
