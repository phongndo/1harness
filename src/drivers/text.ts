import type { TodoStep } from "../core/events.ts";
import { truncate } from "../core/wording.ts";

// How every driver shows tool calls and their results.

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

/** A task's status, in either spelling harnesses use for one under way. */
export function todoStatus(status: unknown): TodoStep["status"] {
  if (status === "completed") return "completed";
  return status === "in_progress" || status === "inProgress" ? "in_progress" : "pending";
}
