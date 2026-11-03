import type { RuntimeMode, Usage } from "../core/events.ts";
import type { Message } from "../core/thread.ts";
import { contextUsed, formatCost, formatTokens, limitBrief, plural } from "../core/wording.ts";
import type { ThreadState } from "../protocol.ts";
import { style } from "./theme.ts";
import { oneLineText, spread, truncate, visibleWidth, wrap } from "./text.ts";
import { queuedText, type TurnState } from "./view.ts";

// The lines under the transcript, from what the terminal shows when it draws
// them: what the turn is doing, what waits to run, who else needs the user,
// and the status line at the bottom.

/** The queue of the thread on screen, a line a message; `held` after a restart. */
export function queueRows(queue: readonly Message[], held: boolean, width: number): string[] {
  const rows = queue.map((queued) =>
    truncate(
      style.muted(`  ↳ ${held ? "held" : "queued"}: ${oneLineText(queuedText(queued))}`),
      width,
    ),
  );
  if (held && queue.length > 0)
    rows.push(
      ...wrap(
        style.muted(
          `    your next message runs ${queue.length === 1 ? "it" : "these"} first · /unqueue takes one back`,
        ),
        width,
        "    ",
      ),
    );
  return rows;
}

/**
 * The line that says other threads need the user, such as an agent's
 * approval: the oldest one, with how many more are waiting.
 */
export function attentionLine(
  waiting: readonly { threadId: string; request: { kind: "approval" | "question" } }[],
  threads: ReadonlyMap<string, ThreadState>,
  width: number,
): string | null {
  const [first] = waiting;
  const thread = first ? threads.get(first.threadId) : undefined;
  if (!first || !thread) return null;
  const what = first.request.kind === "question" ? "has a question" : "needs approval";
  const others = new Set(waiting.map((open) => open.threadId)).size - 1;
  const more = others > 0 ? style.muted(` · ${others} more`) : "";
  const left = `${style.attention("◆")} ${style.strong(thread.title || "New thread")}  ${style.attention(what)}${more}`;
  return spread(truncate(left, Math.max(0, width - 14)), style.muted("ctrl+o open"), width);
}

/**
 * fx's activity line: a blinking dot, the phase and elapsed time, then the
 * token estimate. `running` is whether a tool runs; `steer` whether a
 * message joins the turn.
 */
export function activityLine(
  turn: TurnState,
  state: { running: boolean; blink: boolean; steer: boolean },
  width: number,
): string {
  const seconds = Math.floor((Date.now() - turn.startedAt) / 1000);
  // Streaming text, then running tools, then what the model says it is doing.
  const phase =
    turn.phase === "Generating"
      ? "Generating"
      : state.running
        ? "Running"
        : (turn.heading ?? turn.phase);
  const dot = state.blink ? style.text("•") : " ";
  const tokens = `(↑${formatTokens(Math.ceil(turn.up))} ↓${formatTokens(Math.ceil(turn.down))})`;
  const hint = state.steer
    ? "esc stop · enter adds to turn · tab queues"
    : "esc stop · enter queues";
  const left = `${dot} ${style.text(`${phase} (${seconds}s)`)} ${style.muted(tokens)}`;
  // A narrow screen keeps what the turn is doing and drops the keys.
  if (visibleWidth(left) + visibleWidth(hint) + 2 > width) return truncate(left, width);
  return spread(left, style.muted(hint), width);
}

/** The context and cost a thread has used, for the status line. */
export function usageSummary(usage: Usage): string {
  const parts: string[] = [];
  const context = contextUsed(usage);
  if (context) parts.push(`ctx ${context.used}/${context.window} (${context.percent}%)`);
  // Nothing spent yet, or a subscription that does not count it, shows no cost.
  if (usage.costUsd) parts.push(formatCost(usage.costUsd));
  return parts.join(" · ");
}

/** What the status line shows, as the terminal has it when it draws. */
export interface StatusState {
  /** A ctrl+c that one more exits after. */
  exitArmed: boolean;
  /** A word for a moment, such as what was copied. */
  toast: string | null;
  harness: string;
  /** The thread on screen, by ID, and as the host last said, once it has. */
  currentId: string | null;
  current: ThreadState | undefined;
  /** The model it uses, its harness's default where none was chosen and the default is known. */
  model: string | null;
  /** The runtime mode the next thread starts in, for when none is on screen. */
  runtimeMode: RuntimeMode;
  threads: Iterable<ThreadState>;
  /** The server the terminal works through, where not this machine's. */
  server: string | null;
  /** Rows the view is scrolled up. */
  scroll: number;
  /** Whether tool calls show whole. */
  details: boolean;
}

export function statusLine(state: StatusState, width: number): string {
  if (state.exitArmed) return style.muted("Press ctrl+c again to exit");
  if (state.toast) return truncate(`${style.added("✓")} ${style.text(state.toast)}`, width);
  const { current } = state;
  const info = current?.info ?? null;
  // Empty while the first run asks which harness to start.
  const parts: string[] = state.harness ? [state.harness] : [];
  if (info) {
    if (state.model) parts.push(state.model);
    if (info.effort) parts.push(info.effort);
  }
  const usage = current?.usage ? usageSummary(current.usage) : "";
  if (usage) parts.push(usage);
  // With more than one thread, what the others are doing.
  const threads = [...state.threads].filter((thread) => thread.status !== "closed");
  const elsewhere = (thread: ThreadState) => thread.id !== state.currentId;
  const others = threads.filter(
    (thread) => elsewhere(thread) && thread.status !== "idle" && thread.status !== "parked",
  ).length;
  if (others > 0) parts.push(`${plural(others, "other thread")} working`);
  else {
    // Threads of your own still open, not the agents they started, which ctrl+t lists
    // under them, nor parked ones, which are earlier threads to resume.
    const open = threads.filter(
      (thread) =>
        elsewhere(thread) &&
        thread.parentId === null &&
        !thread.archived &&
        thread.status !== "parked",
    ).length;
    if (open > 0) parts.push(`${open} other open · ctrl+t`);
  }
  if (state.server) parts.push(`on ${state.server}`);
  // Subscription limits appear once they need attention.
  for (const limit of current?.usage?.limits ?? [])
    if (limit.status !== "ok") parts.push(limitBrief(limit));
  // A closed thread on screen says so first, since it takes no messages.
  const mode = info?.runtimeMode ?? state.runtimeMode;
  const shown = current?.status === "closed" ? `closed · ${mode}` : mode;
  let left = `${style.text(shown)}${parts.length > 0 ? style.muted(` · ${parts.join(" · ")}`) : ""}`;
  if (info?.interactionMode === "plan") left += `${style.muted(" · ")}${style.strong("plan")}`;
  // The right edge stays whole as the left is cut, so modes the keys toggle go there.
  const right =
    state.scroll > 0
      ? style.muted(`↓ ${state.scroll} more lines · pgdn`)
      : state.details
        ? style.muted("details · ctrl+x")
        : "";
  return spread(left, right, width);
}
