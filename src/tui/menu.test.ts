import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { Key } from "./input.ts";
import { Menu, entry } from "./menu.ts";
import {
  ChoicePrompt,
  QuestionPrompt,
  type ChoiceConfig,
  type ChoiceResult,
  type QuestionsResult,
} from "./prompt.ts";
import { visibleWidth } from "./text.ts";

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

describe("Menu", () => {
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
});

describe("ChoicePrompt", () => {
  it("moves with j/k, g/G, and ctrl+j/k", () => {
    let result: ChoiceResult | null = null;
    const prompt = new ChoicePrompt(
      {
        header: "Question",
        tag: "",
        title: "Pick",
        detail: [],
        options: ["one", "two", "three"].map((label) => ({ label, description: "" })),
        multiSelect: false,
        allowOther: false,
        secret: false,
        initial: 0,
      },
      (chosen) => {
        result = chosen;
      },
    );
    const choose = (...specs: string[]) => {
      for (const spec of specs) prompt.key(key(spec));
      prompt.key(key("return"));
      return result;
    };
    assert.deepEqual(choose("j", "j", "k"), { kind: "options", indexes: [1] });
    assert.deepEqual(choose("G"), { kind: "options", indexes: [2] });
    assert.deepEqual(choose("g", "ctrl+j"), { kind: "options", indexes: [1] });
    assert.deepEqual(choose("ctrl+k", "ctrl+k"), { kind: "options", indexes: [2] }, "wraps");
  });

  it("wraps a long command whole, and shows all of a long one on ctrl+x", () => {
    const command = `$ ${"word ".repeat(30).trim()}`;
    const many = Array.from({ length: 30 }, (_, index) => `+line ${index}`).join("\n");
    const prompt = new ChoicePrompt(
      {
        header: "Permission needed",
        tag: "Command",
        title: "Run this command?",
        detail: [command, many],
        options: [{ label: "Yes", description: "" }],
        multiSelect: false,
        allowOther: false,
        secret: false,
        initial: 0,
      },
      () => {},
    );
    const text = () =>
      prompt
        .render(60, 60)
        .rows.map((row) => stripVTControlCharacters(row))
        .join("\n");
    // Every character of the command is there, across rows.
    assert.ok(
      text()
        .replace(/\n {4}/g, "")
        .includes(command),
    );
    assert.match(text(), /more rows · ctrl\+x shows them/);
    prompt.key(key("ctrl+x"));
    assert.match(text(), /\+line 29/);
    assert.doesNotMatch(text(), /more rows/);
  });
});

describe("Menu edge cases", () => {
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

  it("keeps the same file selected when the entries come again", () => {
    const files = [entry("index.ts", "src/a/"), entry("index.ts", "src/b/")];
    const list = new Menu({ title: "Files", entries: files });
    list.move(1);
    list.setEntries([entry("index.ts", "src/a/"), entry("index.ts", "src/b/")]);
    assert.equal(list.selected()?.detail, "src/b/");
  });

  it("fits its rows, the whole-entry rows included, in the rows allowed", () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`/command${index}`, "x".repeat(90)),
    );
    const list = new Menu({ title: "Commands", entries, describe: true });
    // The rule, title, and blank above; the rule and hints below.
    assert.equal(list.render(80, 10).length, 10 + 5);
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
});

/** A prompt of three options, with what `config` changes. */
function threeWay(
  config: Partial<ConstructorParameters<typeof ChoicePrompt>[0]>,
  onDone: (result: ChoiceResult) => void = () => {},
): ChoicePrompt {
  return new ChoicePrompt(
    {
      header: "Question",
      tag: "",
      title: "Pick",
      detail: [],
      options: ["A", "B", "C"].map((label) => ({ label, description: "" })),
      multiSelect: false,
      allowOther: false,
      secret: false,
      initial: 0,
      ...config,
    },
    onDone,
  );
}

describe("ChoicePrompt edge cases", () => {
  it("keeps ticked options beside an answer of its own", () => {
    let result: ChoiceResult | null = null;
    const asked = threeWay({ multiSelect: true, allowOther: true }, (chosen) => {
      result = chosen;
    });
    for (const spec of ["1", "2", "4", "x", "y", "return"]) asked.key(key(spec));
    assert.deepEqual(result, { kind: "other", text: "xy", indexes: [0, 1] });
  });

  it("shows more on ctrl+x at 24 rows, and scrolls what still does not fit", () => {
    const detail = [Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")];
    const asked = threeWay({ header: "Permission needed", detail });
    const count = () => asked.render(80, 24).rows.filter((row) => /line \d/.test(row)).length;
    const before = count();
    asked.key(key("ctrl+x"));
    assert.ok(count() > before, `${count()} > ${before}`);
    assert.ok(asked.scrolls);
    asked.key(key("pagedown"));
    const text = asked
      .render(80, 24)
      .rows.map((row) => stripVTControlCharacters(row))
      .join("\n");
    assert.match(text, /line 8\n/);
    // The rows it is given, less one for a row of the transcript.
    assert.ok(asked.render(80, 24).rows.length <= 23);
  });

  it("keeps line breaks in a harness's text out of its rows", () => {
    const asked = threeWay({
      title: "Which one?\nA) keep",
      options: [{ label: "Keep", description: "keeps it\nfor now" }],
    });
    for (const row of asked.render(80).rows) assert.doesNotMatch(row, /\n/);
    const other = threeWay({ options: [], allowOther: true });
    other.paste("first line\r\nsecond line");
    let result: ChoiceResult | null = null;
    const typed = threeWay({ options: [], allowOther: true }, (chosen) => {
      result = chosen;
    });
    typed.paste("first\rsecond");
    typed.key(key("return"));
    assert.deepEqual(result, { kind: "other", text: "first second", indexes: [] });
  });

  it("answers with a comment written on the selected option with tab", () => {
    let result: ChoiceResult | null = null;
    const asked = threeWay({ commentable: (index) => index === 1 }, (chosen) => {
      result = chosen;
    });
    asked.key(key("tab"));
    assert.ok(!asked.typing, "the first option takes no comment");
    asked.key(key("down"));
    for (const spec of ["tab", "n", "o", "t", " ", "t", "h", "i", "s"]) asked.key(key(spec));
    assert.ok(asked.typing);
    const shown = asked
      .render(80)
      .rows.map((row) => stripVTControlCharacters(row))
      .join("\n");
    assert.match(shown, /2 {2}B\n {5}↳ not this/);
    assert.match(shown, /enter confirm with comment/);
    asked.key(key("return"));
    assert.deepEqual(result, {
      kind: "options",
      indexes: [1],
      comment: { index: 1, text: "not this" },
    });
  });

  it("keeps a multi-select's comment, ticking its option, until the answer is confirmed", () => {
    let result: ChoiceResult | null = null;
    const asked = threeWay({ multiSelect: true, commentable: () => true }, (chosen) => {
      result = chosen;
    });
    for (const spec of ["down", "down", "tab", "x", "return"]) asked.key(key(spec));
    assert.equal(result, null, "a comment alone answers nothing");
    // Esc leaves a comment being changed as it was.
    for (const spec of ["tab", "y", "escape", "return"]) asked.key(key(spec));
    assert.deepEqual(result, { kind: "options", indexes: [2], comment: { index: 2, text: "x" } });
  });
});

describe("Menu and prompt, round two", () => {
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

  it("fits a prompt's status rows to a narrow width", () => {
    const detail = [Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")];
    const asked = threeWay({ header: "Permission needed", detail });
    for (const row of asked.render(30, 30).rows) assert.ok(visibleWidth(row) <= 30, row);
    asked.key(key("ctrl+x"));
    for (const row of asked.render(40, 30).rows) assert.ok(visibleWidth(row) <= 40, row);
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

/** A question of `labels` for a QuestionPrompt, named by its `tag`. */
const question = (tag: string, labels: string[], multiSelect = false): ChoiceConfig => ({
  header: "Question",
  tag,
  title: `Which ${tag}?`,
  detail: [],
  options: labels.map((label) => ({ label, description: "" })),
  multiSelect,
  allowOther: false,
  secret: false,
  initial: 0,
  commentable: () => true,
});

/** A prompt's rows as plain text. */
const text = (prompt: QuestionPrompt) =>
  prompt
    .render(80)
    .rows.map((row) => stripVTControlCharacters(row))
    .join("\n");

/** Two questions, a single choice and then a multiple one. */
const asked = (onDone: (result: QuestionsResult) => void) =>
  new QuestionPrompt(
    [question("Theme", ["Dark", "Light"]), question("Features", ["Math", "Images"], true)],
    onDone,
  );

describe("QuestionPrompt", () => {
  it("moves between questions, keeps each answer, and sends them once all are answered", () => {
    let result: QuestionsResult | null = null;
    const prompt = asked((chosen) => (result = chosen));
    assert.match(text(prompt), /Question 1 of 2 +\[Theme\] +Features/);
    prompt.key(key("2"));
    assert.equal(result, null, "waits for the other question");
    assert.match(text(prompt), /Question 2 of 2 +✓ Theme +\[Features\]/);
    // Back to the first, which is changed; the second still has no answer, so on to it.
    prompt.key(key("left"));
    assert.match(text(prompt), /Which Theme\?/);
    prompt.key(key("1"));
    assert.match(text(prompt), /Which Features\?/);
    for (const spec of ["1", "2", "return"]) prompt.key(key(spec));
    assert.deepEqual(result, {
      kind: "answers",
      answers: [
        { indexes: [0], text: null, comment: null },
        { indexes: [0, 1], text: null, comment: null },
      ],
    });
  });

  it("keeps each question's comment with its answer", () => {
    let result: QuestionsResult | null = null;
    const prompt = asked((chosen) => (result = chosen));
    for (const spec of ["down", "tab", "d", "i", "m", "return"]) prompt.key(key(spec));
    assert.match(text(prompt), /Question 2 of 2/, "a comment on one choice answers it");
    for (const spec of ["1", "return"]) prompt.key(key(spec));
    assert.deepEqual(result, {
      kind: "answers",
      answers: [
        { indexes: [1], text: null, comment: { index: 1, text: "dim" } },
        { indexes: [0], text: null, comment: null },
      ],
    });
  });

  it("cancels every question on esc", () => {
    let result: QuestionsResult | null = null;
    asked((chosen) => (result = chosen)).key(key("escape"));
    assert.deepEqual(result, { kind: "cancel" });
  });
});
