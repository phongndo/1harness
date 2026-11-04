import type { RuntimeMode } from "../core/events.ts";
import { MODE_DESCRIPTIONS } from "../core/wording.ts";
import { style } from "./theme.ts";
import { truncate, wrap } from "./text.ts";

const MODE_NAMES: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  "auto-edit": "Auto-edit",
  auto: "Auto",
  "full-access": "Full access",
};

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, charA] of [...a].entries()) {
    const next = [i + 1];
    for (const [j, charB] of [...b].entries())
      next.push(
        Math.min(
          (row[j] ?? 0) + (charA === charB ? 0 : 1),
          (row[j + 1] ?? 0) + 1,
          (next[j] ?? 0) + 1,
        ),
      );
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * The name closest to a mistyped one, where fewer than half of its letters
 * differ: a loose match could steer a typo into a command nobody meant.
 */
export function nearestName(typed: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const edits = editDistance(typed.toLowerCase(), name);
    if (edits * 2 < typed.length && edits < distance) {
      best = name;
      distance = edits;
    }
  }
  return best;
}

/** What a thread with nothing in it says, in `height` rows at most. */
export function welcomeRows(
  thread: { harness: string; model: string | null; mode: RuntimeMode },
  width: number,
  height: number,
): string[] {
  const who = [thread.harness, thread.model].filter(Boolean).join(" · ");
  const name = `${MODE_NAMES[thread.mode]}: ${MODE_DESCRIPTIONS[thread.mode]}`;
  // What never asks is the one thing here worth reading before the first message.
  const mode = thread.mode === "full-access" ? style.attention(name) : style.text(name);
  const rows = [
    "",
    truncate(`  ${style.strong("●")} ${style.bold(who)}`, width),
    "",
    ...wrap(`  ${mode}${style.muted(" · /mode changes it")}`, width, "  "),
    // A narrow pane keeps to a line, not a paragraph broken mid-phrase.
    ...wrap(
      style.text(
        width < 80
          ? "  Describe a task · /resume · /help"
          : "  Describe a task to begin · /resume picks up a thread · /help lists it all",
      ),
      width,
      "  ",
    ),
  ];
  // Short of room, the top row's blank goes before anything said.
  return rows.length > height ? rows.slice(1, height + 1) : rows;
}
