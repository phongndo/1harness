import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { Key } from "./input.ts";
import { Menu, entry, keyHint } from "./menu.ts";
import { style } from "./theme.ts";

/** A key as the decoder reports it: `ctrl+d`, a typed character such as `G`, or a name such as `down`. */
function key(spec: string): Key {
  if (spec.startsWith("ctrl+"))
    return { name: spec.slice(5), text: "", ctrl: true, meta: false, shift: false };
  if (spec.length === 1) {
    const name = spec.toLowerCase();
    return { name, text: spec, ctrl: false, meta: false, shift: name !== spec };
  }
  return { name: spec, text: "", ctrl: false, meta: false, shift: false };
}

function menu(filter: boolean): Menu {
  const entries = ["a", "b", "c", "d", "e", "f"].map((label) =>
    entry(label, "", { group: label < "d" ? "first" : "second" }),
  );
  entries.push(entry("keys", "", { group: "Keys", inert: true }));
  return new Menu({ title: "Test", entries, tabs: true, filter });
}

function press(target: Menu, ...specs: string[]): string | undefined {
  for (const spec of specs) target.key(key(spec));
  return target.selected()?.label;
}

describe("a key hint", () => {
  it("makes the key stand out from what it does", () => {
    assert.equal(keyHint("enter use"), `${style.text("enter")}${style.muted(" use")}`);
    assert.equal(keyHint("esc"), style.text("esc"));
  });
});

function hintLine(config: { filter?: boolean; narrows?: boolean; leave?: string }): string {
  return stripVTControlCharacters(
    new Menu({ title: "List", entries: [entry("/one")], ...config }).render(80, 5).at(-1) ?? "",
  );
}

describe("Menu keys", () => {
  it("takes vim keys when it has no filter", () => {
    const list = menu(false);
    assert.equal(press(list, "j", "j", "k"), "b");
    assert.equal(press(list, "G"), "f", "the informational row is skipped");
    assert.equal(press(list, "g"), "a");
    list.render(80, 4);
    assert.equal(press(list, "ctrl+d"), "c", "half of the four shown rows");
    assert.equal(press(list, "ctrl+d", "ctrl+d", "ctrl+d"), "f", "stops at the end");
    assert.equal(press(list, "l"), "a", "the first tab after All");
    assert.equal(press(list, "l"), "d");
    assert.equal(press(list, "h", "h"), "a");
    assert.deepEqual(list.key(key("q")), { kind: "close" });
  });

  it("moves with ctrl+j and ctrl+k while letters go to its filter", () => {
    const list = menu(true);
    assert.equal(press(list, "ctrl+j", "ctrl+j", "ctrl+k"), "b");
    assert.equal(press(list, "e"), "e", "typing narrows the entries");
    assert.equal(list.key(key("q")), null);
  });

  it("stops a page jump at the last entry before informational rows", () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      entry(`/c${index}`, "", { group: "Commands" }),
    );
    for (const keys of ["a", "b", "c"])
      entries.push(entry(keys, "", { group: "Keys", inert: true }));
    const list = new Menu({ title: "Help", entries, tabs: true });
    list.render(80, 4);
    for (let step = 0; step < 6; step++) list.key(key("down"));
    list.key(key("ctrl+d"));
    assert.equal(list.selected()?.label, "/c7");
  });
});

describe("Menu layout", () => {
  it("keeps the selected tab in view when the tabs are wider than the row", () => {
    const names = ["General", "Session", "Model", "Permissions", "Tools", "Skills", "Claude Code"];
    const list = new Menu({
      title: "Commands",
      entries: names.map((group) => entry(`/${group.toLowerCase()}`, "", { group })),
      tabs: true,
    });
    const title = () => stripVTControlCharacters(list.render(50, 4)[1] ?? "");
    assert.match(title(), /^Commands 7 {2}\[All\].*›$/);
    for (let step = 0; step < names.length; step++) list.key(key("tab"));
    assert.match(title(), /‹ .*\[Claude Code\]$/, "the last tab, with more before it");
    assert.ok(title().length <= 50);
  });

  it("keeps a typed filter in view beside scrolled tabs", () => {
    const names = ["Open", "Recent", "Archived", "Claude Code", "Codex"];
    const list = new Menu({
      title: "Threads",
      entries: names.map((group) => entry(`fix ${group}`, "", { group })),
      tabs: true,
      filter: true,
    });
    list.key(key("tab"));
    for (const char of "fix") list.key(key(char));
    const title = stripVTControlCharacters(list.render(42, 4)[1] ?? "");
    assert.match(title, /filter fix$/);
  });

  it("shows a short list's labels whole, and leaves the count off a question", () => {
    const list = new Menu({
      title: "Forget t1?",
      entries: [entry("Keep it"), entry("Forget it for good")],
      count: false,
    });
    const rows = list.render(80, 4).map((row) => stripVTControlCharacters(row));
    assert.equal(rows[1], "Forget t1?");
    assert.ok(rows.some((row) => row.trim() === "Forget it for good"));
  });

  it("leaves details half a narrow row", () => {
    const list = new Menu({
      title: "Threads",
      entries: [entry("A thread title that runs on and on", "codex · gpt · done")],
    });
    const row = stripVTControlCharacters(list.render(46, 4)[3] ?? "");
    assert.match(row, /codex · gpt · done$/);
  });

  it("gives labels the room details leave, and shows a cut entry whole", () => {
    const title = "A title long enough that the old limit would cut it short";
    const list = new Menu({
      title: "Threads",
      entries: [entry(title, "t1 · idle"), entry("short", "x".repeat(120))],
      describe: true,
    });
    const rows = list.render(120, 6).map((row) => stripVTControlCharacters(row));
    assert.ok(
      rows.some((row) => row.startsWith(`  ${title}`)),
      "the whole title fits in its row",
    );
    list.move(1);
    const moved = list.render(120, 6).map((row) => stripVTControlCharacters(row));
    // Below the list, the selected entry whole: its label, then its detail wrapped.
    assert.deepEqual(moved.slice(6, 8), ["  short", `  ${"x".repeat(117)}…`]);
  });

  it("marks the selected row, and says where it is in a list too long to show", () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(`/command${index}`));
    const list = new Menu({ title: "Commands", entries });
    list.move(2);
    const rows = list.render(80, 5).map((row) => stripVTControlCharacters(row));
    assert.ok(rows.some((row) => row.startsWith("› /command2")));
    assert.ok(rows.some((row) => row.endsWith(" ↓ 15 more · 3 / 20 ─")));
  });

  it("counts as the title does, leaving out rows that are only headings", () => {
    const entries = [
      entry("Group", "", { inert: true }),
      ...Array.from({ length: 20 }, (_, index) => entry(`/command${index}`)),
    ];
    const list = new Menu({ title: "Commands", entries });
    const rows = list.render(80, 5).map((row) => stripVTControlCharacters(row));
    assert.ok(rows.some((row) => row.endsWith(" 1 / 20 ─")));
  });

  it("says a heading once, for the first of the rows under it", () => {
    const list = new Menu({
      title: "Commands",
      headings: true,
      entries: [
        entry("/one", "", { tag: "Threads" }),
        entry("/two", "", { tag: "Threads" }),
        entry("/three", "", { tag: "Model" }),
      ],
    });
    const rows = list.render(60, 5).map((row) => stripVTControlCharacters(row));
    assert.match(rows.find((row) => row.includes("/one")) ?? "", /Threads$/);
    assert.doesNotMatch(rows.find((row) => row.includes("/two")) ?? "", /Threads/);
    assert.match(rows.find((row) => row.includes("/three")) ?? "", /Model$/);
  });

  it("says typing narrows it, and what esc does", () => {
    assert.doesNotMatch(hintLine({}), /type to filter/);
    assert.match(hintLine({ narrows: true }), /type to filter/);
    assert.match(hintLine({ filter: true, leave: "quit" }), /type to filter.*esc quit$/);
  });

  it("does not count a list it shows whole", () => {
    const list = new Menu({ title: "Commands", entries: [entry("/one"), entry("/two")] });
    const rows = list.render(80, 5).map((row) => stripVTControlCharacters(row));
    assert.ok(!rows.some((row) => /\d \/ \d/.test(row)));
  });

  it("does not say twice an entry its row shows whole", () => {
    const list = new Menu({
      title: "Commands",
      entries: [entry("/one", "short"), entry("/two", "x".repeat(120))],
      describe: true,
    });
    const rows = list.render(80, 8).map((row) => stripVTControlCharacters(row));
    assert.equal(rows.filter((row) => row.includes("short")).length, 1);
  });

  it("fits its rows, the whole-entry rows included, in the rows allowed", () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`/command${index}`, "x".repeat(90)),
    );
    const list = new Menu({ title: "Commands", entries, describe: true });
    // The rule, title, and blank above; the rule and hints below.
    assert.equal(list.render(80, 10).length, 10 + 5);
  });

  it("keeps within its rows at a small budget, and off informational rows", () => {
    const entries = [1, 2, 3, 4].map((index) => entry(`/c${index}`, "x".repeat(80)));
    const list = new Menu({ title: "Commands", entries, describe: true });
    assert.ok(list.render(40, 3).length <= 3 + 5);
    const mixed = new Menu({
      title: "Help",
      entries: [entry("keys", "", { inert: true }), entry("/a")],
    });
    mixed.setEntries([entry("keys", "", { inert: true }), entry("/a")]);
    assert.equal(mixed.selected()?.label, "/a");
  });
});

describe("Menu entries", () => {
  it("keeps the same file selected when the entries come again", () => {
    const files = [entry("index.ts", "src/a/"), entry("index.ts", "src/b/")];
    const list = new Menu({ title: "Files", entries: files });
    list.move(1);
    list.setEntries([entry("index.ts", "src/a/"), entry("index.ts", "src/b/")]);
    assert.equal(list.selected()?.detail, "src/b/");
  });
});

describe("Menu paste", () => {
  it("goes into a picker's filter", () => {
    const list = new Menu({
      title: "Threads",
      entries: [entry("alpha"), entry("beta")],
      filter: true,
    });
    assert.equal(list.paste("bet"), true);
    assert.equal(list.selected()?.label, "beta");
    assert.equal(new Menu({ title: "Modes", entries: [entry("a")] }).paste("x"), false);
  });
});

describe("Menu clicks", () => {
  it("selects the entry drawn on a clicked row, and nothing on the rest", () => {
    const picker = new Menu({
      title: "Pick",
      entries: [
        entry("alpha", "first"),
        entry("note", "", { inert: true }),
        entry("gamma", "third"),
      ],
    });
    const rows = picker.render(60, 8);
    const at = (label: string) =>
      rows.findIndex((row) => stripVTControlCharacters(row).trim().startsWith(label));
    assert.equal(picker.entryAt(at("gamma")), true);
    assert.equal(picker.selected()?.label, "gamma");
    assert.equal(picker.entryAt(at("note")), false, "an informational row is not chosen");
    assert.equal(picker.entryAt(0), false, "the rule above the entries");
    assert.equal(picker.selected()?.label, "gamma");
  });
});
