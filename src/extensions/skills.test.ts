import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findSkills, skillMessage, skillTool } from "./skills.ts";

let root: string;
let made = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-skills-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function folder(skills: Record<string, string>): string {
  const path = join(root, String(++made));
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(path, name), { recursive: true });
    writeFileSync(join(path, name, "SKILL.md"), text);
  }
  return path;
}

describe("findSkills", () => {
  it("reads a skill's front matter and instructions, in the format harnesses use", () => {
    const path = folder({
      review: `---\nname: careful-review\ndescription: "Reviews: slowly"\nlicense: MIT\n---\n\nRead it twice.\n`,
      plain: "---\ndescription: Named for its folder\n---\nDo it.",
    });
    const { skills, warnings } = findSkills([path]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      skills.map(({ name, description, body }) => ({ name, description, body })),
      [
        { name: "plain", description: "Named for its folder", body: "Do it." },
        { name: "careful-review", description: "Reviews: slowly", body: "Read it twice." },
      ],
    );
  });

  it("reads a description written across lines, as YAML allows", () => {
    const path = folder({
      folded: "---\ndescription: >-\n  Tidies a file\n  when asked.\nlicense: MIT\n---\nHi.",
      literal: "---\ndescription: |\n  Tidies a file\n\n  when asked.\n---\nHi.",
      plain: "---\ndescription: Tidies a file\n  when asked.\n---\nHi.",
    });
    const { skills, warnings } = findSkills([path]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      skills.map((skill) => skill.description),
      ["Tidies a file when asked.", "Tidies a file when asked.", "Tidies a file when asked."],
    );
  });

  it("leaves out a skill it cannot use, and says why", () => {
    const path = folder({
      bare: "No front matter here.",
      "bad-name": "---\nname: ../up\ndescription: Climbs\n---\nHi.",
      good: "---\ndescription: Fine\n---\nHi.",
    });
    const { skills, warnings } = findSkills([path]);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["good"],
    );
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((warning) => /no description/.test(warning)));
    assert.ok(warnings.some((warning) => /not a skill's name/.test(warning)));
  });

  it("gives a name to the first folder that has it, and skips folders that are not there", () => {
    const mine = folder({ tidy: "---\ndescription: Mine\n---\nMine." });
    const theirs = folder({ tidy: "---\ndescription: Theirs\n---\nTheirs." });
    const { skills } = findSkills([join(root, "missing"), mine, theirs]);
    assert.deepEqual(
      skills.map((skill) => skill.description),
      ["Mine"],
    );
  });
});

const skills = () =>
  findSkills([folder({ tidy: "---\ndescription: Tidies a file\n---\nTidy it." })]).skills;

describe("what agents and messages get", () => {
  it("sends the instructions whole, then what was asked", () => {
    const [skill] = skills();
    assert.ok(skill);
    const message = skillMessage(skill, " the parser\nand the lexer ");
    assert.match(message, /^<skill name="tidy" folder="[^"]+">\nTidy it\.\n<\/skill>\n\n/);
    assert.ok(message.endsWith("the parser\nand the lexer"));
    assert.ok(skillMessage(skill, "  ").endsWith("</skill>"));
  });

  it("lists skills in the tool's description, and reads them on request", async () => {
    const found = skills();
    const tool = skillTool(() => found);
    assert.match(tool.description, /- tidy: Tidies a file/);
    assert.equal(tool.readOnly, true);
    const context = {} as Parameters<typeof tool.execute>[1];
    assert.match(String(await tool.execute({ name: "tidy" }, context)), /Tidy it\.$/);
    assert.throws(() => tool.execute({ name: "nope" }, context), /no skill nope/);
  });

  it("clips a long description, so one skill cannot crowd out the rest", () => {
    const long = "x".repeat(1000);
    const found = findSkills([folder({ big: `---\ndescription: ${long}\n---\nHi.` })]).skills;
    assert.ok(skillTool(() => found).description.length < 400);
  });
});
