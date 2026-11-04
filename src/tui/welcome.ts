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

/** What a thread with nothing in it says, in `height` rows at most. */
export function welcomeRows(
  thread: { harness: string; model: string | null; mode: RuntimeMode },
  width: number,
  height: number,
): string[] {
  const who = [thread.harness, thread.model].filter(Boolean).join(" · ");
  const name = `${MODE_NAMES[thread.mode]}: ${MODE_DESCRIPTIONS[thread.mode]}`;
  // What never asks is the one thing here worth reading before the first message.
  const mode = thread.mode === "full-access" ? style.attention(name) : style.muted(name);
  const rows = [
    "",
    truncate(`  ${style.strong("●")} ${style.bold(who)}`, width),
    "",
    ...wrap(`  ${mode}${style.muted(" · /mode changes it")}`, width, "  "),
    ...wrap(
      style.muted("  Describe a task to begin · /resume picks up a thread · /help lists it all"),
      width,
      "  ",
    ),
  ];
  // Short of room, the top row's blank goes before anything said.
  return rows.length > height ? rows.slice(1, height + 1) : rows;
}
