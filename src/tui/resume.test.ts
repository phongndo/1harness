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
    assert.deepEqual(rows.slice(1, 8), [
      "Resume                                  ◉ This folder  ○ All  ○ Archived",
      "",
      "> type to search",
      "",
      "  › 1h ago    Fix the login redirect                claude · opus · high",
      "    10d ago   Set up the repo                       claude · opus · high",
      "──────────────────────────────────────────────────────────────── 1 / 2 ─",
    ]);
    assert.match(rows.at(-1) ?? "", /tab scope/);
  });

  it("widens the age column for a date from another year, keeping the titles apart", () => {
    const old = thread("t0", "Old work", 24 * 400);
    const rows = plain(
      new ResumeView("Resume", [ENTRIES[0]!, old], { cwd: HERE }).render(72, 20, NOW),
    );
    const [recent, dated] = rows.filter((row) => /work|redirect/.test(row));
    assert.match(dated ?? "", /^ {4}\S.*\d{4} {2,}Old work/);
    // Every title starts in one column.
    assert.equal(recent?.indexOf("Fix"), dated?.indexOf("Old"));
  });

  it("shows every folder's threads on tab, with their folders", () => {
    const shown = view();
    shown.key(key("tab"));
    const text = plain(shown.render(90, 20, NOW)).join("\n");
    assert.match(text, /○ This folder {2}◉ All/);
    assert.match(text, /30h|1d ago {4}Plan the release +claude · opus · high {2}~\/code\/site/);
    assert.match(text, /1 \/ 3/);
  });

  it("leaves out the agents threads started, even from a search", () => {
    const shown = new ResumeView("Resume", ENTRIES, { initial: "t4", cwd: HERE });
    const rows = plain(shown.render(72, 20, NOW));
    // Opened on an agent, the list starts on the thread that started it.
    assert.ok(
      rows.includes("  › 1h ago    Fix the login redirect                claude · opus · high"),
    );
    assert.ok(!rows.some((row) => row.includes("Review the change")));
    for (const char of "review") shown.key(key(char, char));
    assert.match(plain(shown.render(72, 20, NOW)).join("\n"), /No thread matches/);
  });

  it("lists a thread's agents the same way for /lineage, kept up to date", () => {
    const agents = [
      thread("t4", "Review the change", 1),
      thread("t5", "Check the tests", 1, { depth: 1 }),
    ];
    const shown = new ResumeView("Fix the login redirect", () => agents, {
      initial: "t5",
      cwd: HERE,
      lineage: true,
    });
    agents.push(thread("t6", "Review it again", 0));
    const rows = plain(shown.render(72, 20, NOW));
    assert.deepEqual(rows.slice(1, 10), [
      "Fix the login redirect",
      "",
      "> type to search",
      "",
      "    1h ago    Review the change                     claude · opus · high",
      "  › 1h ago      Check the tests                     claude · opus · high",
      "    now       Review it again                       claude · opus · high",
      "──────────────────────────────────────────────────────────────── 2 / 3 ─",
      "↑↓ navigate   enter go in   ← back out   esc close",
    ]);
    assert.deepEqual(shown.key(key("return")), { kind: "choose", id: "t5" });
    // An agent come in above the one selected leaves the selection on it.
    agents.splice(1, 0, thread("t7", "Read the diff", 0, { depth: 1 }));
    assert.deepEqual(shown.key(key("return")), { kind: "choose", id: "t5" });
    // So does one come in after a paste searched the list.
    shown.key(key("home"));
    shown.paste("check");
    agents.unshift(thread("t8", "Check the docs", 0));
    assert.deepEqual(shown.key(key("return")), { kind: "choose", id: "t5" });
    assert.deepEqual(shown.key(key("left")), { kind: "exit" });
    assert.equal(shown.key(key("tab")), null);
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

  it("archives the selected thread with ctrl+a, shows it among the archived, and brings it back", () => {
    const shown = view();
    assert.deepEqual(shown.key({ ...key("a", "a"), ctrl: true }), {
      kind: "archive",
      id: "t3",
      archived: true,
    });
    assert.doesNotMatch(plain(shown.render(72, 20, NOW)).join("\n"), /Fix the login/);
    shown.key(key("tab"));
    shown.key(key("tab"));
    const archived = plain(shown.render(72, 20, NOW)).join("\n");
    assert.match(archived, /◉ Archived/);
    assert.match(archived, /Fix the login redirect/);
    assert.match(archived, /ctrl\+a unarchive/);
    assert.deepEqual(shown.key({ ...key("a", "a"), ctrl: true }), {
      kind: "archive",
      id: "t3",
      archived: false,
    });
  });

  it("renames the selected thread with ctrl+r, keeping its title on esc", () => {
    const shown = view();
    shown.key({ ...key("r", "r"), ctrl: true });
    assert.match(plain(shown.render(72, 20, NOW)).join("\n"), /rename › Fix the login redirect▏/);
    shown.key({ ...key("u", "u"), ctrl: true });
    for (const char of "Login fix") shown.key(key(char, char));
    assert.deepEqual(shown.key(key("return")), { kind: "rename", id: "t3", title: "Login fix" });
    assert.match(plain(shown.render(72, 20, NOW)).join("\n"), /› 1h ago +Login fix/);
    shown.key({ ...key("r", "r"), ctrl: true });
    shown.key(key("x", "x"));
    assert.equal(shown.key(key("escape")), null);
    assert.match(plain(shown.render(72, 20, NOW)).join("\n"), /Login fix /);
  });

  it("keeps the selection in view as it moves past the rows shown", () => {
    const shown = view();
    for (let step = 0; step < 2; step++) shown.key(key("down"));
    const text = plain(shown.render(72, 9, NOW)).join("\n");
    assert.match(text, /Set up the repo/);
    assert.doesNotMatch(text, /Fix the login/);
  });
});
