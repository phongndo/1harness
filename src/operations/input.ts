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
