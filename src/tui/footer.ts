import type { RuntimeMode } from "../core/events.ts";
import type { Message } from "../core/thread.ts";
import { cacheHit, contextUsed, formatCost } from "../core/wording.ts";
import type { ThreadState } from "../protocol.ts";
import type { Editor } from "./editor.ts";
import { infoPanel, type Menu } from "./menu.ts";
import type { ResumeView } from "./resume.ts";
import type { CursorPosition } from "./screen.ts";
import { style } from "./theme.ts";
import { oneLineText, spread, truncate, visibleWidth, wrap } from "./text.ts";
import { queuedText, tokenCounts, type TurnState } from "./view.ts";

// The lines under the transcript, from what the terminal shows when it draws
// them: what the turn is doing, what waits to run, who else needs the user,
// the composer or a prompt, the panel over it, and the status line at the
// bottom.

/** The queue of the thread on screen, a line a message; `held` after a restart. */
function queueRows(queue: readonly Message[], held: boolean, width: number): string[] {
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
function attentionLine(
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
function activityLine(
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
  const tokens = tokenCounts(Math.ceil(turn.up), Math.ceil(turn.down));
  const hint = state.steer
    ? "esc stop · enter adds to turn · tab queues"
    : "esc stop · enter queues";
  const left = `${dot} ${style.text(`${phase} (${seconds}s)`)} ${style.muted(tokens)}`;
  // A narrow screen keeps what the turn is doing and drops the keys.
  if (visibleWidth(left) + visibleWidth(hint) + 2 > width) return truncate(left, width);
  return spread(left, style.muted(hint), width);
}

/** What the status line shows, as the terminal has it when it draws. */
export interface StatusLineState {
  /** A ctrl+c that one more exits after. */
  exitArmed: boolean;
  /** A word for a moment, such as what was copied. */
  toast: string | null;
  harness: string;
  /** The thread on screen, as the host last said, once it has. */
  current: ThreadState | undefined;
  /** The model it uses, its harness's default where none was chosen and the default is known. */
  model: string | null;
  /** The runtime mode the next thread starts in, for when none is on screen. */
  runtimeMode: RuntimeMode;
  /** The server the terminal works through, where not this machine's. */
  server: string | null;
  /** Rows the view is scrolled up. */
  scroll: number;
  /** Whether tool calls show whole. */
  details: boolean;
}

/** `full-access · claude · opus · high · ctx 12% · cache 87% · $0.42`; /status says the rest. */
export function statusLine(state: StatusLineState, width: number): string {
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
  const usage = current?.usage;
  const context = usage ? contextUsed(usage) : null;
  if (context) parts.push(`ctx ${context.percent}%`);
  const cached = usage ? cacheHit(usage) : null;
  if (cached !== null) parts.push(`cache ${cached}%`);
  // Nothing spent yet, or a subscription that does not count it, shows no cost.
  if (usage?.costUsd) parts.push(formatCost(usage.costUsd));
  if (state.server) parts.push(`on ${state.server}`);
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

/** A panel over the composer, as the footer shows it. */
type FooterPanel =
  | { kind: "info"; title: string; rows: [string, string][] }
  | { kind: "menu"; menu: Menu }
  | { kind: "resume" | "lineage"; view: ResumeView };

/** What the footer shows, as the terminal has it when it draws. */
export interface FooterState {
  turn: TurnState | null;
  /** Whether a tool runs, the activity dot's blink, and whether a message joins the turn. */
  running: boolean;
  blink: boolean;
  steer: boolean;
  /** The queue of the thread on screen; `held` after a restart. */
  queue: readonly Message[];
  held: boolean;
  /** Other threads' open requests, oldest first. */
  waiting: Parameters<typeof attentionLine>[0];
  threads: ReadonlyMap<string, ThreadState>;
  /** A request's prompt, in the composer's place. */
  prompt: {
    render(width: number, height: number): { rows: string[]; cursor: CursorPosition | null };
  } | null;
  panel: FooterPanel | null;
  editor: Pick<Editor, "layout" | "empty">;
  /** Whether the thread on screen is working, which the empty composer's hint says. */
  busy: boolean;
  /** The list open under the composer, such as commands or files. */
  suggestions: Menu | null;
  status: string;
}

export interface Footer {
  rows: string[];
  cursor: CursorPosition | null;
  /** The list shown, and the footer row its rows start on. */
  list?: { menu: Menu; row: number };
}

/** The rows below the transcript: activity, queue, and the composer or a panel, in `height` rows at most. */
export function footerRows(state: FooterState, width: number, height: number): Footer {
  const rows: string[] = [""];
  const { turn, prompt, panel } = state;
  if (turn && !prompt) rows.push(activityLine(turn, state, width), "");
  // A queue held after a restart waits for the user's next message.
  rows.push(...queueRows(state.queue, state.held, width));
  if (state.queue.length > 0) rows.push("");
  const attention = attentionLine(state.waiting, state.threads, width);
  if (attention) rows.push(attention, "");

  let cursor: CursorPosition | null = null;
  let list: { menu: Menu; row: number } | undefined;
  if (prompt && !panel) {
    // The rows the footer has left, under the queue and the attention line,
    // less the status line, which keeps the bottom row under a prompt too.
    const rendered = prompt.render(width, height - rows.length - 2);
    if (rendered.cursor)
      cursor = { row: rows.length + rendered.cursor.row, column: rendered.cursor.column };
    rows.push(...rendered.rows, "", state.status);
  } else {
    const limit = Math.max(1, Math.min(10, Math.floor(height / 3)));
    // The rules mark it off, so it needs no marker of its own.
    const layout = state.editor.layout("", width);
    // An empty composer says what it takes.
    if (state.editor.empty && !panel) {
      const hint = state.busy
        ? "Add to the turn, or tab to queue a message"
        : "Ask anything · / commands · $ skills · @ files";
      layout.rows[0] = truncate(style.faint(hint), width);
    }
    const start = Math.max(0, Math.min(layout.cursor.row - limit + 1, layout.rows.length - limit));
    const composer = layout.rows.slice(start, start + limit);
    // Room for a list: the screen less the rows above it, the composer and
    // status line under it, the list's chrome, and a little transcript.
    const listRows = Math.max(3, Math.min(14, height - rows.length - composer.length - 11));
    const listed = panel?.kind === "menu" ? panel.menu : panel ? null : state.suggestions;
    // Lists and panels open above the composer, which keeps its place at the
    // bottom; the thread list takes the screen above it.
    const shown =
      panel?.kind === "info"
        ? infoPanel(panel.title, panel.rows, width)
        : panel?.kind === "resume"
          ? panel.view.render(width, Math.max(8, height - rows.length - composer.length - 3))
          : panel?.kind === "lineage"
            ? // Short enough to watch the thread on screen above it.
              panel.view.render(width, Math.max(10, Math.floor(height * 0.45)))
            : listed
              ? listed.render(width, listRows)
              : [];
    if (listed) list = { menu: listed, row: rows.length };
    if (shown.length > 0) rows.push(...shown, "");
    // Rules above and below mark off what the composer holds.
    const edge = style.rule("─".repeat(width));
    rows.push(edge);
    if (!panel)
      cursor = { row: rows.length + layout.cursor.row - start, column: layout.cursor.column };
    rows.push(...composer, edge, state.status);
  }
  if (rows.length > height) {
    const cut = rows.length - height;
    if (cursor) cursor = { ...cursor, row: Math.max(0, cursor.row - cut) };
    return {
      rows: rows.slice(cut),
      cursor,
      ...(list && list.row >= cut ? { list: { ...list, row: list.row - cut } } : {}),
    };
  }
  return { rows, cursor, ...(list ? { list } : {}) };
}
