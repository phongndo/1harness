import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Key } from "./input.ts";
import { Menu, entry } from "./menu.ts";
import { ChoicePrompt, type ChoiceResult } from "./prompt.ts";

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
});
