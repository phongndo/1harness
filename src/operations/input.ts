import { RUNTIME_MODES } from "../core/events.ts";
import { OperationError } from "./operation.ts";

/** The longest an operation waits for news of a thread. */
export const MAX_WAIT_SECONDS = 3000;

/** An input's runtime mode, as operations' schemas list them. */
export const RUNTIME_MODE_SCHEMA = { type: "string", enum: [...RUNTIME_MODES] };

/** A text input, trimmed; undefined when it is missing or blank. */
export function text(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new OperationError("invalid_request", `${name} must be a string`);
  return value.trim() || undefined;
}

export function required(input: Record<string, unknown>, name: string): string {
  const value = text(input, name);
  if (!value) throw new OperationError("invalid_request", `${name} is required`);
  return value;
}

/**
 * An operation's input from words such as `threadId=ab12 fresh=true`, or one
 * JSON object. Values parse as JSON where they can, else as text; a word with
 * no `=` goes on the value before it, so `message=fix the tests` is one value.
 */
export function parseInput(words: readonly string[]): Record<string, unknown> {
  const [first] = words;
  if (words.length === 1 && first?.trimStart().startsWith("{")) {
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("the input must be a JSON object");
    return parsed as Record<string, unknown>;
  }
  const raw = new Map<string, string>();
  let last: string | null = null;
  for (const word of words) {
    const equals = word.indexOf("=");
    if (equals < 1) {
      if (last === null) throw new Error(`${word} is not key=value`);
      raw.set(last, `${raw.get(last)} ${word}`);
      continue;
    }
    last = word.slice(0, equals);
    raw.set(last, word.slice(equals + 1));
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of raw) {
    try {
      input[key] = JSON.parse(value);
    } catch {
      // Not JSON, so it is text.
      input[key] = value;
    }
  }
  return input;
}
