const CONTEXT = 3;
// Beyond this many line pairs the middle is shown as removed then added, unaligned.
const MAX_CELLS = 4_000_000;

type Line = { kind: " " | "-" | "+"; text: string };

/**
 * A unified diff of two texts, as harnesses that send whole files need: hunks
 * of changed lines with three lines of context. Empty when nothing changed.
 */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const lines = diffLines(splitLines(before), splitLines(after));
  const changes = lines.flatMap((line, index) => (line.kind === " " ? [] : [index]));
  const hunks: string[] = [];
  // Changes no more than twice the context apart share a hunk.
  let first = changes[0];
  let last = first;
  for (const change of [...changes.slice(1), undefined]) {
    if (first === undefined || last === undefined) break;
    if (change !== undefined && change - last <= CONTEXT * 2) {
      last = change;
      continue;
    }
    hunks.push(
      hunk(lines, Math.max(0, first - CONTEXT), Math.min(lines.length, last + CONTEXT + 1)),
    );
    first = change;
    last = change;
  }
  return hunks.join("\n");
}

function hunk(lines: Line[], start: number, end: number): string {
  let oldStart = 1;
  let newStart = 1;
  for (const line of lines.slice(0, start)) {
    if (line.kind !== "+") oldStart++;
    if (line.kind !== "-") newStart++;
  }
  const body = lines.slice(start, end);
  const oldCount = body.filter((line) => line.kind !== "+").length;
  const newCount = body.filter((line) => line.kind !== "-").length;
  return [
    `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
    ...body.map((line) => `${line.kind}${line.text}`),
  ].join("\n");
}

function keep(text: string): Line {
  return { kind: " ", text };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Lines in order, each kept, removed, or added. */
function diffLines(before: string[], after: string[]): Line[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  return [
    ...before.slice(0, prefix).map(keep),
    ...alignMiddle(oldMiddle, newMiddle),
    ...before.slice(before.length - suffix).map(keep),
  ];
}

/** A longest-common-subsequence alignment of the changed middle. */
function alignMiddle(before: string[], after: string[]): Line[] {
  const removed = before.map((text): Line => ({ kind: "-", text }));
  const added = after.map((text): Line => ({ kind: "+", text }));
  if (before.length === 0 || after.length === 0 || before.length * after.length > MAX_CELLS) {
    return [...removed, ...added];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: " ", text: before[i] ?? "" });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "-", text: before[i++] ?? "" });
    } else {
      lines.push({ kind: "+", text: after[j++] ?? "" });
    }
  }
  while (i < before.length) lines.push({ kind: "-", text: before[i++] ?? "" });
  while (j < after.length) lines.push({ kind: "+", text: after[j++] ?? "" });
  return lines;
}
