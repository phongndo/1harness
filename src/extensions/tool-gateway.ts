// Most of 1harness's tools cost nothing until an agent needs one. Harnesses see
// only the tools marked `direct`, and these three, which reach the rest. Doing
// this here rather than through each harness's own deferred tools means one
// mechanism on every harness, and none of them to keep up with.
//
// Two tools call, rather than one, so a harness can still tell reads from
// changes: `tool_read` carries the read-only hint and refuses anything else.

import { GATEWAY_ACT, GATEWAY_READ, GATEWAY_SEARCH } from "../core/tools.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "./api.ts";

/** How many tools one search returns with their schemas, which are what cost. */
const SEARCH_RESULTS = 5;

function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
}

const callWith = (tool: ToolDefinition) => (tool.readOnly ? GATEWAY_READ : GATEWAY_ACT);

function search(hidden: ReadonlyMap<string, ToolDefinition>, query: string): string {
  const tools = [...hidden.values()];
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0)
    return JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: firstSentence(tool.description),
        callWith: callWith(tool),
      })),
    );
  const score = (tool: ToolDefinition) => {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    return words.reduce(
      (sum, word) => sum + (name.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0),
      0,
    );
  };
  const found = tools
    .map((tool) => ({ tool, score: score(tool) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, SEARCH_RESULTS)
    .map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      callWith: callWith(tool),
    }));
  return JSON.stringify(
    found.length > 0 ? found : { found: [], tools: tools.map((tool) => tool.name) },
  );
}

/** A tool's input as it was sent, which some models write as a JSON string. */
function innerInput(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : (value ?? {});
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("input must be a JSON object");
  return parsed as Record<string, unknown>;
}

const CALL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The tool's name, from tool_search." },
    input: { type: "object", description: "The tool's arguments, as its inputSchema says." },
  },
  required: ["name"],
};

/** The tools that reach `hidden`. */
export function gatewayTools(hidden: ReadonlyMap<string, ToolDefinition>): ToolDefinition[] {
  const call = (
    input: Record<string, unknown>,
    context: ToolContext,
    readOnly: boolean,
  ): ToolResult | Promise<ToolResult> => {
    // Only a string: a policy sees the tool `gatewayCall` finds, which is nothing for `["x"]`.
    const name = typeof input["name"] === "string" ? input["name"] : "";
    const tool = hidden.get(name);
    if (!tool) throw new Error(`No tool ${name}; ${GATEWAY_SEARCH} finds them`);
    // What keeps a change from running under a read's lighter approval.
    if (readOnly && !tool.readOnly)
      throw new Error(`${name} changes things, so it goes through ${GATEWAY_ACT}`);
    return tool.execute(innerInput(input["input"]), context);
  };
  return [
    {
      name: GATEWAY_SEARCH,
      description: `Finds 1harness's other tools and their arguments, for working with threads, harnesses, and more. Call what it finds with the tool it names. They are: ${[...hidden.keys()].join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words or a tool's name; empty lists them all." },
        },
      },
      readOnly: true,
      direct: true,
      execute: (input) => search(hidden, String(input["query"] ?? "")),
    },
    {
      name: GATEWAY_READ,
      description: `Calls a tool that ${GATEWAY_SEARCH} says to call with ${GATEWAY_READ}: one that only reads.`,
      inputSchema: CALL_SCHEMA,
      readOnly: true,
      direct: true,
      execute: (input, context) => call(input, context, true),
    },
    {
      name: GATEWAY_ACT,
      description: `Calls a tool that ${GATEWAY_SEARCH} says to call with ${GATEWAY_ACT}: one that changes things.`,
      inputSchema: CALL_SCHEMA,
      direct: true,
      execute: (input, context) => call(input, context, false),
    },
  ];
}
