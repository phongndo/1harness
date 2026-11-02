import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Key } from "./input.ts";
import { ResumeView, type ResumeEntry } from "./resume.ts";

const NOW = new Date(2026, 10, 1, 18, 0).getTime();
const HOUR = 3_600_000;
const HERE = "/home/me/code/app";

function key(name: string, text = ""): Key {
  return { name, text, ctrl: false, meta: false, shift: false };
}

function thread(
  id: string,
  title: string,
  hoursAgo: number,
  options: { depth?: number; cwd?: string } = {},
): ResumeEntry {
  return {
    id,
    title,
    on: "claude · opus · high",
    cwd: options.cwd ?? HERE,
    updatedAt: NOW - hoursAgo * HOUR,
    depth: options.depth ?? 0,
    dot: "",
  };
}

const ENTRIES = [
  thread("t3", "Fix the login redirect", 1),
  thread("t4", "Review the change", 1, { depth: 1 }),
  thread("t2", "Plan the release", 30, { cwd: "/home/me/code/site" }),
  thread("t1", "Set up the repo", 240),
];

const view = () =>
  new ResumeView("Resume", ENTRIES, { initial: "t3", cwd: HERE, home: "/home/me" });
const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row).trimEnd());

describe("ResumeView", () => {
  it("lists this folder's threads, a row each: age, title, and what it runs on", () => {
    const rows = plain(view().render(72, 20, NOW));
    assert.deepEqual(rows.slice(1, 9), [
      "Resume                                              ◉ This folder  ○ All",
      "",
      "> type to search",
      "",
      "  › 1h ago    Fix the login redirect                claude · opus · high",
      "    1h ago      Review the change                   claude · opus · high",
      "    10d ago   Set up the repo                       claude · opus · high",
      "──────────────────────────────────────────────────────────────── 1 / 3 ─",
    ]);
    assert.match(rows.at(-1) ?? "", /tab this folder \/ all/);
  });

  it("shows every folder's threads on tab, with their folders", () => {
    const shown = view();
    shown.key(key("tab"));
    const text = plain(shown.render(90, 20, NOW)).join("\n");
    assert.match(text, /○ This folder {2}◉ All/);
    assert.match(text, /30h|1d ago {4}Plan the release +claude · opus · high {2}~\/code\/site/);
    assert.match(text, /1 \/ 4/);
  });

  it("searches as you type, and esc clears the search before it closes", () => {
    const shown = view();
    for (const char of "set") shown.key(key(char, char));
    const text = plain(shown.render(72, 20, NOW)).join("\n");
    assert.match(text, /> set▏/);
    assert.doesNotMatch(text, /Fix the login/);
    assert.deepEqual(shown.key(key("return")), { kind: "choose", id: "t1" });
    assert.equal(shown.key(key("escape")), null);
    assert.equal(shown.query, "");
    assert.deepEqual(shown.key(key("escape")), { kind: "close" });
  });

  it("starts on every folder's threads where this folder has none", () => {
    const shown = new ResumeView("Resume", ENTRIES, { cwd: "/elsewhere" });
    assert.match(plain(shown.render(72, 20, NOW)).join("\n"), /◉ All/);
  });

  it("keeps the selection in view as it moves past the rows shown", () => {
    const shown = view();
    for (let step = 0; step < 2; step++) shown.key(key("down"));
    const text = plain(shown.render(72, 9, NOW)).join("\n");
    assert.match(text, /Set up the repo/);
    assert.doesNotMatch(text, /Fix the login/);
  });
});
