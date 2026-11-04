// Skills that work on every harness. A skill is a folder with a `SKILL.md`, as
// harnesses' own skills are. 1harness offers these itself, rather than writing
// them into each harness's settings: `$name` sends one as a message, and agents
// read them through a tool, whose description is all they cost until they do.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../core/errors.ts";
import type { ToolDefinition } from "./api.ts";

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The most of a description that goes to agents, so one skill cannot crowd out the rest. */
const DESCRIPTION_LIMIT = 240;

export const SKILL_TOOL = "skill_read";

export interface Skill {
  name: string;
  description: string;
  /** Its `SKILL.md`. */
  file: string;
  /** Its instructions, without the front matter. */
  body: string;
}

/**
 * Reads `key: value` lines between `---` lines, which is all a skill's header
 * needs. A value may go on across indented lines, under `>` or `|` or not; they
 * join with spaces, since every field here reads as one line.
 */
function frontMatter(text: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: new Map(), body: text };
  const fields = new Map<string, string>();
  let key: string | null = null;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1] ?? "";
      const value = (pair[2] ?? "").trim().replace(/^[>|][+-]?$/, "");
      const quoted = /^(["'])(.*)\1$/.exec(value);
      fields.set(key, quoted ? (quoted[2] ?? "") : value);
    } else if (key && /^\s+\S/.test(line))
      fields.set(key, `${fields.get(key) ?? ""} ${line.trim()}`.trim());
  }
  return { fields, body: text.slice(match[0].length) };
}

function readSkill(file: string, folderName: string): Skill {
  const { fields, body } = frontMatter(readFileSync(file, "utf8"));
  const name = fields.get("name") || folderName;
  if (!SKILL_NAME.test(name)) throw new Error(`${name} is not a skill's name`);
  const description = fields.get("description");
  if (!description) throw new Error("it has no description in its front matter");
  return { name, description, file, body: body.trim() };
}

/**
 * The skills in these folders, each skill a folder of its own. An earlier folder
 * wins a name, so the user's own skill stands in for a package's.
 */
export function findSkills(folders: readonly string[]): { skills: Skill[]; warnings: string[] } {
  const byName = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(folder).toSorted();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const file = join(folder, name, "SKILL.md");
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      try {
        const skill = readSkill(file, name);
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      } catch (error) {
        warnings.push(`Skill ${file} was left out: ${errorMessage(error)}`);
      }
    }
  }
  return { skills: [...byName.values()], warnings };
}

/** The message `$name args` sends: the instructions whole, so it works with tools turned off. */
export function skillMessage(skill: Skill, args: string): string {
  const request = args.trim();
  const block = `<skill name="${skill.name}" folder="${dirname(skill.file)}">\n${skill.body}\n</skill>`;
  return request ? `${block}\n\n${request}` : block;
}

function clip(text: string): string {
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT)}…`;
}

/** The tool agents read skills through, whose description lists them. */
export function skillTool(skills: () => readonly Skill[]): ToolDefinition {
  const listed = skills()
    .map((skill) => `- ${skill.name}: ${clip(skill.description)}`)
    .join("\n");
  return {
    name: SKILL_TOOL,
    description: `Reads a skill's instructions. Read one before a task it applies to.\n${listed}`,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name." } },
      required: ["name"],
    },
    readOnly: true,
    execute: (input) => {
      const name = input["name"];
      const skill = skills().find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`no skill ${String(name)}`);
      return `Files it names are in ${dirname(skill.file)}.\n\n${skill.body}`;
    },
  };
}
