import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { render } from "pele";
import { Diagrams, fillVariables, floating } from "./diagrams.ts";
import type { Figure } from "./figures.ts";
import { pngSize } from "./images.ts";
import { renderMarkdown } from "./markdown.ts";

const FLOW = "flowchart LR\n  A[Terminal] --> B(1harness)\n  B --> C{Server}";
const CELL = { width: 8, height: 16 };

/**
 * The alpha of an RGBA PNG's top-left pixel. The first pixel of the first row
 * is stored as it is under every filter, having nothing left of or above it.
 */
function cornerAlpha(png: Buffer): number {
  assert.equal(png[25], 6, "RGBA");
  const data: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT")
      data.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  return inflateSync(Buffer.concat(data))[4] ?? -1;
}

/** Stands in for drawing: says what it drew, and from how many lines. */
const figure = ({ kind, source }: Figure) => [`<${kind} of ${source.split("\n").length} lines>`];

describe("diagrams", () => {
  it("fills Pele's CSS variables, which resvg cannot read", () => {
    const filled = fillVariables(render(FLOW).svg, { "--pele-fg": "#123456" });
    assert.doesNotMatch(filled, /var\(/);
    assert.match(filled, /#123456/);
  });

  it("draws a diagram once the engine has loaded, and in characters", async () => {
    let ready!: () => void;
    const loaded = new Promise<void>((resolve) => (ready = resolve));
    const diagrams = new Diagrams(() => ready());
    assert.equal(
      diagrams.picture(FLOW, false, 800, CELL),
      undefined,
      "drawn once the engine loads",
    );
    await loaded;
    const drawn = diagrams.picture(FLOW, false, 800, CELL);
    assert.ok(drawn, "a picture");
    const size = pngSize(Buffer.from(drawn.data, "base64"));
    assert.ok(size && size.width <= 800 && size.width > 0);
    assert.equal(diagrams.picture(FLOW, false, 800, CELL), drawn, "kept");
    assert.equal(diagrams.picture("not a diagram at all", false, 800, CELL), null);
    assert.match(diagrams.text(FLOW)?.join("\n") ?? "", /Terminal/);
  });

  it("draws a diagram on whole cells, at the screen's density, with nothing behind it", async () => {
    let ready!: () => void;
    const loaded = new Promise<void>((resolve) => (ready = resolve));
    const diagrams = new Diagrams(() => ready());
    diagrams.picture(FLOW, false, 1600, CELL);
    await loaded;
    const small = diagrams.picture(FLOW, false, 1600, CELL);
    const dense = diagrams.picture(FLOW, false, 1600, { width: 17, height: 33 });
    assert.ok(small && dense);
    assert.equal(small.pixelWidth % 8, 0);
    assert.equal(small.pixelHeight % 16, 0);
    assert.equal(dense.pixelWidth % 17, 0);
    assert.equal(dense.pixelHeight % 33, 0);
    assert.ok(dense.pixelWidth > small.pixelWidth * 1.8, "drawn for the denser screen");
    // The corner is the terminal's own background showing through.
    assert.equal(cornerAlpha(Buffer.from(small.data, "base64")), 0);
    const narrow = diagrams.picture(FLOW, false, 200, CELL);
    assert.ok(narrow && narrow.pixelWidth <= 200, "never wider than the room for it");
    assert.equal(
      diagrams.picture(FLOW, false, 1800, CELL),
      small,
      "a wider screen alone draws none",
    );
    assert.notEqual(
      diagrams.picture(FLOW, false, 192, CELL),
      narrow,
      "a narrower one draws it smaller",
    );
  });

  it("cuts edge labels into their lines instead of painting a background behind them", () => {
    const svg = floating(render("flowchart LR\n  A -->|yes| B").svg);
    assert.doesNotMatch(svg, /fill="var\(--_bg\)"/);
    assert.match(svg, /<mask id="pele-gaps"/);
    assert.match(svg, /<g class="pele-edges" mask="url\(#pele-gaps\)"/);
  });

  it("shows a diagram in Markdown once its fence closes, and code while it streams", () => {
    const done = renderMarkdown(`Look:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nAfter.`, 60, "  ", {
      figure,
    });
    assert.ok(done.includes("  <mermaid of 3 lines>"), done.join("\n"));
    assert.equal(done.at(-1), "  After.");
    const streaming = renderMarkdown(`\`\`\`mermaid\n${FLOW}`, 60, "  ", { figure });
    assert.ok(!streaming.some((row) => row.includes("<mermaid")));
  });
});
