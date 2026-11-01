import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pngSize } from "../tui/images.ts";
import { Media, runsScripts } from "./media.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-media-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in html2term that keeps what it was given and writes `output`, or fails with `error`. */
function fake(output: string, error?: string): string {
  const path = join(root, `html2term-${Math.random().toString(36).slice(2)}`);
  writeFileSync(join(root, "out"), output);
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" > "${root}/args"\ncat > "${root}/stdin"\n${
      error ? `echo "${error}" >&2\nexit 3` : `cat "${root}/out"`
    }\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("Media", () => {
  it("gives html2term the page on stdin, at the width, density, and theme asked", async () => {
    const media = new Media(fake("PNG"));
    const png = await media.html("<p>hi</p>", { width: 612.4, scale: 2, dark: true });
    assert.equal(png.toString(), "PNG");
    assert.equal(
      readFileSync(join(root, "args"), "utf8").trim(),
      "render - --width 612 --scale 2 --dark",
    );
    assert.equal(readFileSync(join(root, "stdin"), "utf8"), "<p>hi</p>");
  });

  it("asks for a transparent page, and an html2term that predates it for one on its canvas", async () => {
    const media = new Media(fake("PNG"));
    await media.html("<p>hi</p>", { width: 400, scale: 1, dark: true, transparent: true });
    assert.match(readFileSync(join(root, "args"), "utf8"), /--dark --transparent$/m);
    assert.match(
      readFileSync(join(root, "stdin"), "utf8"),
      /^<p>hi<\/p>\n<style>html,body\{background:transparent!important\}<\/style>$/,
      "its own background is not drawn",
    );
    // An older one says it knows no such flag; the page is drawn again without it.
    const older = join(root, "html2term-older");
    writeFileSync(
      older,
      `#!/bin/sh\ncase "$*" in *--transparent*) echo "error: unexpected argument '--transparent' found" >&2; exit 2;; esac\necho "$@" > "${root}/args"\ncat >/dev/null\nprintf PNG\n`,
    );
    chmodSync(older, 0o755);
    const png = await new Media(older).html("<p>", {
      width: 400,
      scale: 1,
      dark: true,
      transparent: true,
    });
    assert.equal(png.toString(), "PNG");
    assert.doesNotMatch(readFileSync(join(root, "args"), "utf8"), /--transparent/);
  });

  it("counts a handler such as onclick as a script, and not the word on in text", () => {
    assert.equal(runsScripts('<button onclick="go()">Go</button>'), true);
    assert.equal(runsScripts("<script>go()</script>"), true);
    assert.equal(runsScripts("<p>Hold on = wait</p>"), false);
  });

  it("shrinks an image to a box, and has none when it fails", async () => {
    const media = new Media(fake("PNG"));
    assert.equal((await media.image("/tmp/a.jpg", 400, 300))?.toString(), "PNG");
    assert.equal(
      readFileSync(join(root, "args"), "utf8").trim(),
      "image /tmp/a.jpg --width 400 --height 300",
    );
    assert.equal(await new Media(fake("", "unsupported format")).image("/tmp/a.txt", 10), null);
  });

  it("says why a page could not be drawn", async () => {
    await assert.rejects(
      new Media(fake("", "error: bad CSS")).html("<p>", { width: 400, scale: 1, dark: false }),
      /error: bad CSS/,
    );
    await assert.rejects(
      new Media(null).html("<p>", { width: 400, scale: 1, dark: false }),
      /html2term is not installed/,
    );
    assert.equal(await new Media(null).image("/tmp/a.png"), null);
  });

  // The real one, where it is built, to check it takes what 1harness gives it.
  const built = join(homedir(), "code/html2term/target/release/html2term");
  it("draws a page with html2term, as wide as asked", { skip: !existsSync(built) }, async () => {
    const png = await new Media(built).html(
      "<div style='height:40px;background:#3a6'>Builds</div>",
      { width: 300, scale: 2, dark: true },
    );
    assert.equal(pngSize(png)?.width, 600);
  });
});
