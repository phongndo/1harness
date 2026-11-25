import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PLACEHOLDER, type Shown } from "./images.ts";
import { Look } from "./look.ts";
import { Menu, entry } from "./menu.ts";
import { paintSelection, selectedText } from "./pointer.ts";
import { Screen } from "./screen.ts";
import { loadResvg } from "./svg.ts";
import { setPanelsLook } from "./theme.ts";
import { plainText, visibleWidth } from "./text.ts";
import { Transcript, type Block, type RenderContext } from "./transcript.ts";

const CELL = { width: 16, height: 34 };
const WIDTH = 92;

async function panels(): Promise<Look> {
  const look = new Look({ cell: () => CELL, graphics: () => true, redraw: () => {} });
  await loadResvg();
  await Promise.resolve();
  setPanelsLook(true);
  return look;
}

afterEach(() => setPanelsLook(false));

function context(look: Look, details = false): RenderContext {
  return {
    width: WIDTH,
    look,
    cwd: "/app",
    blink: true,
    now: 0,
    details,
    media: { graphics: true, cell: CELL, maxRows: 30 },
  };
}

function shown(look: Look, blocks: Block[], details = false) {
  const transcript = new Transcript();
  for (const block of blocks) transcript.add(block);
  return transcript.view(context(look, details), 200, 0);
}

/** A row's text, with a picture's cells as dots. */
function text(row: string): string {
  return plainText(row).replace(new RegExp(`${PLACEHOLDER}\\p{M}*`, "gu"), "·");
}

const command = (id: string, line: string, exitCode: number) =>
  ({
    kind: "command",
    id,
    command: line,
    output: "",
    exitCode,
    status: exitCode === 0 ? "completed" : "failed",
  }) as const;

describe("the panels look", () => {
  it("takes a column in the middle of a wide screen", async () => {
    const look = await panels();
    assert.deepEqual(look.column(200), { left: 54, width: 92 });
    assert.deepEqual(look.column(80), { left: 0, width: 80 });
    assert.deepEqual(look.column(30), { left: 0, width: 30 });
    assert.equal(look.fits(30), false);
  });

  it("shows what was sent in a bubble at the right, its text no picture", async () => {
    const { rows, pictures } = shown(await panels(), [{ kind: "user", text: "fix it" }]);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(visibleWidth(row), WIDTH);
    assert.ok(rows[0]?.includes(PLACEHOLDER) && rows[2]?.includes(PLACEHOLDER));
    assert.ok(!rows[1]?.includes(PLACEHOLDER));
    assert.match(text(rows[1] ?? ""), /^ +fix it +$/);
    assert.equal(pictures.length, 2);
  });

  it("uses the same pictures for surfaces of one width", async () => {
    const look = await panels();
    const one = shown(look, [{ kind: "user", text: "same" }]);
    const two = shown(look, [{ kind: "user", text: "size" }]);
    assert.deepEqual(
      one.pictures.map((each) => each.picture.id),
      two.pictures.map((each) => each.picture.id),
    );
  });

  it("marks calls with icons, and copies their text without them", async () => {
    const look = await panels();
    const { rows } = shown(look, [
      { kind: "tools", settled: true, items: [command("1", "ls", 0), command("2", "false", 1)] },
    ]);
    assert.deepEqual(rows.map(text), [
      "·· Ran 2 commands · 1 failed",
      "·· Ran ls",
      "·· Ran false · exit 1",
    ]);
    const selection = { anchor: { row: 0, column: 0 }, head: { row: 2, column: WIDTH } };
    assert.equal(
      selectedText(rows, selection),
      "Ran 2 commands · 1 failed\nRan ls\nRan false · exit 1",
    );
    assert.notDeepEqual(paintSelection(rows, selection, 0, WIDTH), rows);
  });

  it("puts code on a surface that a click copies, and copies no edge of it", async () => {
    const { rows, targets } = shown(await panels(), [
      { kind: "assistant", text: "Run:\n\n```sh\nls -la\n```\n\nThen `cat` it." },
    ]);
    const at = rows.findIndex((row) => text(row).includes("ls -la"));
    assert.ok(!rows[at]?.includes(PLACEHOLDER));
    assert.equal(visibleWidth(rows[at] ?? ""), WIDTH);
    const target = targets[at]?.target;
    assert.equal(target?.kind === "code" && target.code, "ls -la");
    const all = { anchor: { row: 0, column: 0 }, head: { row: rows.length - 1, column: WIDTH } };
    assert.doesNotMatch(selectedText(rows, all), /[^\x20-\x7e\n]/);
  });

  it("keeps what failed and what changed in a turn's summary", async () => {
    const { rows } = shown(await panels(), [
      {
        kind: "worked",
        text: "Changed 1 file",
        files: [{ path: "/app/a.ts", added: 2, removed: 1 }],
        failures: ["pnpm test · exit 1"],
      },
    ]);
    const said = rows.map(text).join("\n");
    assert.match(said, /Changed 1 file · ctrl\+x shows output/);
    assert.match(said, /pnpm test · exit 1/);
    assert.match(said, /a\.ts \+2 −1/);
  });

  it("draws a list over the composer whose rows a click still finds", async () => {
    const look = await panels();
    const entries = ["Opus", "Sonnet", "Haiku"].map((label) => entry(label, "a model"));
    for (const narrows of [true, false]) {
      const menu = new Menu({ title: "Model", entries, filter: !narrows, narrows });
      const pictures: Shown[] = [];
      const rows = menu.render(WIDTH, 10, { look, collect: (one) => pictures.push(one) });
      for (const row of rows) assert.ok(visibleWidth(row) <= WIDTH);
      const at = rows.findIndex((row) => text(row).includes("Sonnet"));
      assert.equal(menu.entryAt(at), true);
      assert.equal(menu.selected()?.label, "Sonnet");
      assert.ok(pictures.length > 0);
    }
  });

  it("gives the terminal its own colors back on leaving", () => {
    let written = "";
    const out = { columns: 80, rows: 24, write: (data: string) => ((written += data), true) };
    const screen = new Screen(out as unknown as NodeJS.WriteStream);
    screen.ground({ page: "#000000", text: "#dddddd" });
    assert.equal(written, "");
    screen.enter();
    assert.ok(written.includes("\x1b]11;#000000\x1b\\\x1b]10;#dddddd\x1b\\"));
    written = "";
    screen.ground({ page: "#000000", text: "#dddddd" });
    assert.equal(written, "");
    screen.leave();
    assert.ok(written.includes("\x1b]111\x1b\\\x1b]110\x1b\\"));
  });

  it("leaves the transcript as it was without it", async () => {
    const look = await panels();
    setPanelsLook(false);
    const transcript = new Transcript();
    transcript.add({ kind: "user", text: "fix it" });
    const { rows, pictures } = transcript.view({ ...context(look), look: null }, 20, 0);
    assert.equal(rows.length, 1);
    assert.equal(pictures.length, 0);
  });
});
