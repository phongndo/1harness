import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  clipboardText,
  collapsesPaste,
  pastedImagePaths,
  pastedTextPlaceholder,
  pathsAsPaste,
  readPastedImage,
} from "./attachments.ts";

describe("pastedImagePaths", () => {
  let root: string;
  let shot: string;
  let photo: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "1harness-paste-"));
    shot = join(root, "Screenshot 2026-11-02 at 5.48.29 PM.png");
    photo = join(root, "it's.jpg");
    writeFileSync(shot, "png");
    writeFileSync(photo, "jpg");
    writeFileSync(join(root, "notes.txt"), "text");
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("reads a dropped path as terminals escape it, quoted, or as a file URL", () => {
    assert.deepEqual(pastedImagePaths(shot.replaceAll(" ", "\\ ")), [shot]);
    assert.deepEqual(pastedImagePaths(`'${shot}'\n`), [shot]);
    assert.deepEqual(pastedImagePaths(`"${shot}" ${photo.replace("'", "\\'")}`), [shot, photo]);
    assert.deepEqual(pastedImagePaths(pathToFileURL(shot).href), [shot]);
  });

  it("leaves text, other files, and images that are not there as a paste", () => {
    assert.equal(pastedImagePaths("look at this"), null);
    assert.equal(pastedImagePaths(join(root, "notes.txt")), null);
    assert.equal(pastedImagePaths(join(root, "gone.png")), null);
    assert.equal(pastedImagePaths(`${shot.replaceAll(" ", "\\ ")} and more`), null);
    assert.equal(pastedImagePaths(`'${shot}`), null);
  });

  it("reads copied files' paths back as a paste of them", () => {
    assert.deepEqual(pastedImagePaths(pathsAsPaste([shot, photo])), [shot, photo]);
  });

  it("reads an image with its type by its extension", () => {
    assert.deepEqual(readPastedImage(photo), {
      type: "image/jpeg",
      data: Buffer.from("jpg").toString("base64"),
    });
  });
});

describe("long pastes", () => {
  it("stand as a placeholder past a thousand characters or ten lines", () => {
    assert.equal(collapsesPaste("x".repeat(1000)), false);
    assert.equal(collapsesPaste("x".repeat(1001)), true);
    assert.equal(collapsesPaste("line\n".repeat(10)), false);
    assert.equal(collapsesPaste("line\n".repeat(11)), true);
    assert.equal(pastedTextPlaceholder(2, "line\r\n".repeat(12)), "[Pasted text #2 +12 lines]");
    assert.equal(pastedTextPlaceholder(1, "x".repeat(1200)), "[Pasted text #1 1200 chars]");
  });

  it("does not read the clipboard of a machine reached over SSH", async () => {
    assert.equal(await clipboardText("linux", { SSH_CONNECTION: "1 2 3 4" }), null);
  });
});
