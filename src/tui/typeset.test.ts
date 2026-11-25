import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PLACEHOLDER, dropCells, placeholderColor, placeholderMark } from "./images.ts";
import { Look } from "./look.ts";
import { paintSelection, selectedText, wordAt } from "./pointer.ts";
import { Rail, beside, marginOf } from "./rail.ts";
import { Screen } from "./screen.ts";
import { loadResvg } from "./svg.ts";
import { visibleWidth } from "./text.ts";
import { Transcript } from "./transcript.ts";
import { Typesetter, textRow } from "./typeset.ts";

const CELL = { width: 10, height: 20 };

/**
 * Draws a page as html2term does, near enough to lay rows out by: each block a
 * line a row tall, its characters a cell wide, and no picture worth seeing.
 */
const FAKE = `#!${process.execPath}
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { html, options } = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ top: options.top }) + "\\n");
  const body = html.slice(html.indexOf("</style>") + 8);
  const parts = body.split(/(?=<div style="height:)/).filter(Boolean);
  const text = [], hits = [];
  parts.forEach((part, at) => {
    const said = part.replace(/<[^>]+>/g, "").trim();
    const href = /href="([^"]+)"/.exec(part)?.[1];
    hits.push({ id: "b:" + at, x: 0, y: at * 20 - options.top, width: 400, height: 20 });
    if (said) text.push({ top: at * 20 - options.top, bottom: at * 20 + 20 - options.top, x: 0, text: said, ends: [...said].map((_, i) => (i + 1) * 10), wraps: said.endsWith("-"), ...(href ? { href } : {}) });
  });
  const pixels = parts.length * 20;
  console.log(JSON.stringify({ ok: true, png: "AAAA", width: options.pixel_width, height: Math.max(20, pixels - options.top), page_pixels: pixels, layer: { text, hits } }));
});
`;

let folder = "";
let log = "";
const saved = process.env["HTML2TERM_BIN"];

before(() => {
  folder = mkdtempSync(join(tmpdir(), "typeset-"));
  log = join(folder, "log");
  const binary = join(folder, "html2term.cjs");
  writeFileSync(binary, FAKE);
  writeFileSync(log, "");
  chmodSync(binary, 0o755);
  process.env["HTML2TERM_BIN"] = binary;
  process.env["FAKE_LOG"] = log;
});

after(() => {
  if (saved === undefined) delete process.env["HTML2TERM_BIN"];
  else process.env["HTML2TERM_BIN"] = saved;
  rmSync(folder, { recursive: true });
});

async function typesetter(): Promise<{ set: Typesetter; came: () => Promise<void> }> {
  let told: (() => void) | null = null;
  const set = new Typesetter({ arrived: () => told?.() });
  const came = () =>
    new Promise<void>((resolve) => {
      told = resolve;
    });
  await came();
  assert.equal(set.usable, true);
  return { set, came };
}

const block = (text: string) => `<div style="height:0px"></div><div data-hit="b:0">${text}</div>`;

async function rowsOf(...texts: string[]): Promise<string[]> {
  const { set, came } = await typesetter();
  const owner = {};
  assert.equal(set.sheet(owner, texts.map(block), 40, CELL, true), "pending");
  await came();
  const drawn = set.sheet(owner, texts.map(block), 40, CELL, true);
  set.close();
  assert.ok(drawn && drawn !== "pending" && !drawn.stale);
  return drawn.sheet.rows;
}

describe("pages drawn by html2term", () => {
  it("draws a page that grew only from where it grew", async () => {
    const { set, came } = await typesetter();
    const owner = {};
    set.sheet(owner, ["one", "two"].map(block), 40, CELL, true);
    await came();
    const drawn = set.sheet(owner, ["one", "two"].map(block), 40, CELL, true);
    writeFileSync(log, "");
    const during = set.sheet(owner, ["one", "two", "three"].map(block), 40, CELL, true);
    // What was drawn shows until what it grew to is.
    assert.ok(during && during !== "pending" && during.stale);
    await came();
    const grown = set.sheet(owner, ["one", "two", "three"].map(block), 40, CELL, true);
    set.close();
    assert.ok(drawn && drawn !== "pending" && grown && grown !== "pending");
    assert.deepEqual(grown.sheet.rows.slice(0, 2), drawn.sheet.rows);
    assert.equal(grown.sheet.rows.length, 3);
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(log, "utf8"), '{"top":40}\n');
  });

  it("is text to select, copy, and take words of", async () => {
    const rows = await rowsOf("one two three", "a line that wraps-", "to here");
    for (const row of rows) assert.equal(visibleWidth(row), 40);
    assert.equal(
      textRow(rows[0] ?? "")
        ?.cells.slice(0, 3)
        .join(""),
      "one",
    );
    assert.deepEqual(wordAt(rows[0] ?? "", 5), { from: 4, to: 6 });
    assert.equal(wordAt(rows[0] ?? "", 30), null);
    const all = { anchor: { row: 0, column: 4 }, head: { row: 2, column: 39 } };
    assert.equal(selectedText(rows, all), "two three\na line that wraps- to here");
    const painted = paintSelection(rows, all, 0, 40);
    // Selected cells are filled behind the picture, whose ID its color must go on naming.
    assert.match(painted[0] ?? "", /\x1b\[48;2;/); // oxlint-disable-line no-control-regex
    assert.ok(!painted[0]?.includes("\x1b[7m"));
    assert.equal(visibleWidth(painted[0] ?? ""), 40);
  });

  it("links the cells over a link", async () => {
    const [row = ""] = await rowsOf('<a href="https://e.com/x">here</a>');
    assert.ok(row.includes("\x1b]8;;https://e.com/x\x1b\\"));
    assert.ok(row.includes("\x1b]8;;\x1b\\"));
    assert.equal(visibleWidth(row), 40);
  });

  it("keeps a picture's place in a row cut from its left", () => {
    // One whose cells leave it to the first to say where they are.
    const row = `  ${placeholderColor(7)}${placeholderMark(3, 0)}${PLACEHOLDER.repeat(5)}\x1b[39m`;
    assert.equal(
      dropCells(row, 4),
      `${placeholderColor(7)}${placeholderMark(3, 2)}${PLACEHOLDER.repeat(3)}\x1b[39m`,
    );
    assert.equal(dropCells("abcdef", 2), "cdef");
  });

  it("is sized until it is near the view, so only what may show is drawn", async () => {
    const { set, came } = await typesetter();
    const look = new Look({ cell: () => CELL, graphics: () => true, redraw: () => {} });
    const transcript = new Transcript();
    for (let at = 0; at < 100; at++) transcript.add({ kind: "assistant", text: `reply ${at}` });
    const context = {
      width: 40,
      look,
      typeset: set,
      cwd: "/",
      blink: true,
      now: 0,
      media: { graphics: true, cell: CELL, maxRows: 10 },
    };
    writeFileSync(log, "");
    transcript.view(context, 10, 0);
    await came();
    const { readFileSync } = await import("node:fs");
    const asked = readFileSync(log, "utf8").trim().split("\n").length;
    assert.ok(asked > 3 && asked < 60, `${asked} drawn`);
    // Holding to what the view ended at, whatever is drawn above it.
    const { last } = transcript.view(context, 10, 20);
    assert.ok(last);
    assert.equal(transcript.below(context, last), 20);
    set.close();
  });
});

describe("the prompt rail", () => {
  const place = { left: 20, room: 30, top: 0, total: 60, columns: 60 };
  const asked = Array.from({ length: 5 }, (_, at) => ({
    row: at * 12,
    text: `q${at}`,
    reply: "r",
  }));

  it("lists messages in the margin, for a click to go to", async () => {
    await loadResvg();
    const look = new Look({ cell: () => CELL, graphics: () => true, redraw: () => {} });
    const rail = new Rail();
    const frame = rail.frame(look, null, asked, place, null, true);
    assert.ok(frame);
    for (let at = 0; at < place.room; at++) {
      const margin = marginOf(at, place.left, frame);
      assert.equal(visibleWidth(margin ?? ""), place.left);
      assert.equal(visibleWidth(beside("text", at, place.left, frame)), place.left + 4);
    }
    assert.equal(frame.at(0, 0), null);
    // Strips share rows, so each is at some column of one.
    const reached = new Set<number | null>();
    for (let row = 0; row < frame.cells.length; row++)
      for (let along = 0; along < frame.columns; along++)
        reached.add(frame.at(frame.top + row, along));
    assert.deepEqual([...reached].toSorted(), [0, 1, 2, 3, 4]);
    // One message is nothing to go between, and no margin is nowhere to list them.
    assert.equal(rail.frame(look, null, asked.slice(0, 1), place, null, true), null);
    assert.equal(rail.frame(look, null, asked, { ...place, left: 3 }, null, true), null);
  });
});

function screen() {
  const written: string[] = [];
  const out = { columns: 20, rows: 12, write: (data: string) => written.push(data) > 0 };
  const made = new Screen(out as unknown as NodeJS.WriteStream);
  made.enter();
  written.length = 0;
  return { made, written };
}
const page = (from: number) => [
  ...Array.from({ length: 10 }, (_, at) => `line ${from + at}`),
  "box",
  "status",
];

describe("a screen that scrolls", () => {
  it("moves what it has, and writes only what comes into view", () => {
    const { made, written } = screen();
    made.render(page(0), null);
    written.length = 0;
    made.render(page(3), null);
    const out = written.join("");
    assert.ok(out.includes("\x1b[1;10r\x1b[3S\x1b[r"), JSON.stringify(out));
    assert.deepEqual([...out.matchAll(/line \d+/g)].map(String), ["line 10", "line 11", "line 12"]);
    written.length = 0;
    made.render(page(1), null);
    assert.ok(written.join("").includes("\x1b[1;10r\x1b[2T\x1b[r"));
    assert.ok(!written.join("").includes("status"));
  });

  it("writes a margin that stays while the rest scrolls past it", () => {
    const { made, written } = screen();
    const rows = (from: number) => page(from).map((row, at) => `${at === 4 ? "##" : "  "}${row}`);
    const margins = page(0).map((_, at) => (at === 4 ? "##" : "  "));
    made.render(rows(0), null, [], margins);
    written.length = 0;
    made.render(rows(2), null, [], margins);
    const out = written.join("");
    assert.deepEqual([...out.matchAll(/line \d+/g)].map(String), ["line 10", "line 11"]);
    assert.ok(out.includes("\x1b[5;1H##\x1b[0m"));
  });
});
