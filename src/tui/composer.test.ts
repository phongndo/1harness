import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComposerBox, composerSvg, modelLabel, type ComposerState } from "./composer.ts";
import { Editor } from "./editor.ts";
import { footerRows, type FooterState } from "./footer.ts";
import { PLACEHOLDER } from "./images.ts";
import { Look } from "./look.ts";
import { loadResvg } from "./svg.ts";
import { visibleWidth } from "./text.ts";

const CELL = { width: 16, height: 34 };
const IDLE: ComposerState = { model: "Opus 5.5", effort: "high", empty: true, busy: false };

async function panel(graphics = true): Promise<Look> {
  const look = new Look({ cell: () => CELL, graphics: () => graphics, redraw: () => {} });
  await loadResvg();
  await Promise.resolve();
  return look;
}

const boxes = new WeakMap<Look, ComposerBox>();

function footer(look: Look, editor: Editor, width = 120, height = 40, busy = false) {
  const box = boxes.get(look) ?? new ComposerBox(look);
  boxes.set(look, box);
  const state: FooterState = {
    turn: null,
    running: false,
    blink: false,
    steer: false,
    queue: [],
    held: false,
    waiting: [],
    threads: new Map(),
    prompt: null,
    panel: null,
    editor,
    busy,
    retry: null,
    suggestions: null,
    status: "status",
    box: { panel: box, look, model: "Opus 5.5", effort: "high" },
  };
  return footerRows(state, width, height);
}

const action = (state: Partial<ComposerState>) =>
  composerSvg(92, 6, CELL, { ...IDLE, ...state }).spots[0]?.action;

const plain = (drawn: { rows: string[]; pictures?: unknown }) => {
  assert.equal(drawn.pictures, undefined);
  assert.ok(drawn.rows.some((row) => row.includes("───")));
};

describe("the composer's model label", () => {
  it("reads as a name, without the maker or the date", () => {
    assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
    assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
    assert.equal(modelLabel("gpt-6.2-sol"), "6.2 Sol");
    assert.equal(modelLabel("opus"), "Opus");
    assert.equal(modelLabel("openrouter/vendor/some-model"), "Some Model");
  });
});

describe("the composer as a panel", () => {
  it("sits centered, its rows as wide as it is, with what is typed as text between its edges", async () => {
    const editor = new Editor();
    editor.insert("fix the parser");
    const drawn = footer(await panel(), editor);
    const rows = drawn.rows.filter((row) => row.includes(PLACEHOLDER));
    const [shown] = drawn.pictures ?? [];
    assert.ok(shown);
    assert.equal(shown.columns, 92);
    assert.equal(rows.length, shown.rows);
    assert.equal(shown.picture.pixelWidth, shown.columns * CELL.width);
    assert.equal(shown.picture.pixelHeight, shown.rows * CELL.height);
    for (const row of rows) assert.equal(visibleWidth(row), 14 + 92);
    assert.match(rows[1] ?? "", /fix the parser/);
    // Two cells of picture on each side of the text, and none under it.
    assert.equal((rows[1] ?? "").split(PLACEHOLDER).length - 1, 4);
  });

  it("puts the cursor after what is typed", async () => {
    const editor = new Editor();
    editor.insert("abc");
    const { rows, cursor } = footer(await panel(), editor);
    const row = rows.findIndex((line) => line.includes("abc"));
    assert.deepEqual(cursor, { row, column: 14 + 2 + 3 });
  });

  it("keeps its picture while a line is typed, and grows with more lines", async () => {
    const box = await panel();
    const editor = new Editor();
    editor.insert("a");
    const before = footer(box, editor).pictures?.[0];
    editor.insert("b");
    assert.equal(footer(box, editor).pictures?.[0]?.picture.id, before?.picture.id);
    editor.insert("\nc\nd");
    assert.equal(footer(box, editor).pictures?.[0]?.rows, (before?.rows ?? 0) + 1);
  });

  it("sends, or stops a turn while nothing is typed", () => {
    assert.equal(action({}), "send");
    assert.equal(action({ busy: true }), "stop");
    assert.equal(action({ busy: true, empty: false }), "send");
  });

  it("escapes a model's name", () => {
    const { svg } = composerSvg(92, 6, CELL, { ...IDLE, model: "<b>&" });
    assert.ok(!svg.includes("<b>"));
  });

  it("leaves the plain composer where there are no pictures, or no room", async () => {
    const editor = new Editor();
    plain(footer(await panel(false), editor));
    const box = await panel();
    plain(footer(box, editor, 30));
    plain(footer(box, editor, 120, 9));
  });
});
