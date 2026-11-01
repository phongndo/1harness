import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pngSize } from "../tui/images.ts";
import { LivePages } from "./live.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-live-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for html2term's browser worker: each page's frame is its click
 * count, so a frame changes only when the page is used; a page whose HTML
 * says so ends the worker.
 */
function fakeWorker(): string {
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
let next = 0;
const clicks = new Map();
const png = (text) => Buffer.from(text).toString("base64");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const reply = (body) => process.stdout.write(JSON.stringify({ id: request.id, ok: true, ...body }) + "\\n");
  const frame = (doc, extra = "") => reply({ document: doc, png: png(doc + ":" + clicks.get(doc) + extra), width: 200, height: 100, css_width: 100, css_height: 50 });
  if (request.op === "open") {
    if (request.html.includes("die")) process.exit(1);
    const doc = "doc" + ++next;
    clicks.set(doc, 0);
    writeFileSync("${root}/options.json", JSON.stringify(request.options));
    frame(doc);
  } else if (!clicks.has(request.document)) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: "document is closed" }) + "\\n");
  } else if (request.op === "frame") frame(request.document);
  else if (request.op === "input") {
    clicks.set(request.document, clicks.get(request.document) + 1);
    frame(request.document);
  } else if (request.op === "resize") frame(request.document, ":" + request.width + "x" + request.height);
  else if (request.op === "close") { clicks.delete(request.document); reply({}); }
}
`,
  );
  const binary = join(root, "html2term");
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(binary, 0o755);
  return binary;
}

const decode = (data: string) => Buffer.from(data, "base64").toString();

describe("Live pages", () => {
  it("opens a page, and sends a frame only when it has changed", async () => {
    const live = new LivePages(fakeWorker);
    try {
      const page = await live.open("tui", "<p>hi</p>", { width: 100, scale: 2, dark: true });
      assert.equal(decode(page.data), "doc1:0");
      const options = JSON.parse(readFileSync(join(root, "options.json"), "utf8"));
      assert.deepEqual(options, {
        width: 100,
        scale: 2,
        appearance: "dark",
        transparent: true,
      });
      assert.deepEqual([page.width, page.cssWidth], [200, 100]);
      assert.equal(await live.frame(page.id), null, "unchanged");
      const clicked = await live.input(page.id, { type: "click", x: 10, y: 10 });
      assert.equal(decode(clicked?.data ?? ""), "doc1:1");
      assert.equal(await live.frame(page.id), null);
      const resized = await live.resize(page.id, 300, 200);
      assert.equal(decode(resized.data), "doc1:1:300x200");
    } finally {
      live.stop();
    }
  });

  it("closes a client's pages when it leaves, and says a closed page is closed", async () => {
    const live = new LivePages(fakeWorker);
    try {
      const mine = await live.open("tui", "<p>a</p>", { width: 100, scale: 1, dark: true });
      const theirs = await live.open("other", "<p>b</p>", { width: 100, scale: 1, dark: true });
      live.closeOwned("tui");
      await assert.rejects(live.frame(mine.id), /The page is closed/);
      assert.equal(await live.frame(theirs.id), null);
    } finally {
      live.stop();
    }
  });

  it("fails what was asked when the worker stops, and starts another after", async () => {
    const live = new LivePages(fakeWorker);
    try {
      await assert.rejects(live.open("tui", "<p>die</p>", { width: 100, scale: 1, dark: true }));
      const page = await live.open("tui", "<p>ok</p>", { width: 100, scale: 1, dark: true });
      assert.equal(decode(page.data), "doc1:0");
    } finally {
      live.stop();
    }
  });

  // The real worker and a Chromium, where both are, to check a script runs and takes clicks.
  const built = join(homedir(), "code/html2term/target/release/html2term");
  const chromium = process.env["CHROMIUM"];
  it(
    "runs a page's script in Chromium, and redraws it after a click",
    { skip: !existsSync(built) || !chromium || !existsSync(chromium), timeout: 60_000 },
    async () => {
      const live = new LivePages(() => built);
      try {
        const page = await live.open(
          "tui",
          `<button id="b" style="width:200px;height:60px" onclick="this.textContent='clicked'">Click</button>
           <script>document.body.dataset.ran = "yes"</script>`,
          { width: 300, scale: 2, dark: true },
        );
        assert.equal(pngSize(Buffer.from(page.data, "base64"))?.width, 600);
        const clicked = await live.input(page.id, { type: "click", x: 50, y: 20 });
        assert.ok(clicked, "the click changed the page");
      } finally {
        live.stop();
      }
    },
  );
});
