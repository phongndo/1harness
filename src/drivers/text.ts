import type { TodoStep } from "../core/events.ts";
import { record, text } from "../core/values.ts";
import { truncate } from "../core/wording.ts";

// How every driver reads messages, tool calls, and their results.

/** A message that runs a command, `/name args`, split into the name and its arguments. */
export function slashCommand(message: string): { name: string; args: string } | null {
  const [, name, args = ""] = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim()) ?? [];
  return name ? { name, args: args.trim() } : null;
}

/**
 * A short description of a tool call's input: the first of `keys` it has, such
 * as a path, or else its JSON.
 */
export function summarizeInput(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return truncate(value, 120);
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : truncate(json, 120);
}

/** A tool result's content parts as text: text as it is, anything else by `other`, else its type, such as `[image]`. */
export function contentText(
  content: unknown,
  other: (part: unknown) => string = (part) => `[${text(record(part)["type"])}]`,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const fields = record(part);
      return fields["type"] === "text" || typeof fields["text"] === "string"
        ? text(fields["text"])
        : other(part);
    })
    .join("\n");
}

/** What a subagent was asked to do: its description, or the start of its prompt. */
export function agentDescription(input: Record<string, unknown>): string {
  return text(input["description"]) || truncate(text(input["prompt"]), 120);
}

/** A task's status, in either spelling harnesses use for one under way. */
export function todoStatus(status: unknown): TodoStep["status"] {
  if (status === "completed") return "completed";
  return status === "in_progress" || status === "inProgress" ? "in_progress" : "pending";
}
