import type { HarnessId } from "../core/events.ts";
import type { RunRecord } from "./manager.ts";

/** About how much of a handoff the turns may take, so it stays a small part of a context window. */
const BUDGET = 24_000;
/** The most of one turn's message or reply a handoff quotes. */
const FIELD_LIMIT = 2_000;
/** How many of a turn's commands a handoff lists, the latest ones. */
const COMMAND_COUNT = 8;
const COMMAND_LIMIT = 160;

export interface HandoffOptions {
  /** The 1harness thread ID, which `thread_read` takes. */
  threadId: string;
  /** The harness taking the thread over. */
  to: HarnessId;
  /** The turns it has not seen, oldest first. */
  runs: readonly RunRecord[];
  /** It resumes its own earlier thread, so it saw the turns before these. */
  resumed: boolean;
  /** A new thread starts from thread `threadId`'s turns, as `/fork` makes one. */
  forked?: boolean;
  /** A harness's name as people know it, such as `Claude Code`. */
  label(harness: HarnessId): string;
}

const OPEN = "<1harness-handoff>";
const CLOSE = "</1harness-handoff>";
const TRAILER = "\n\nThe next message follows.\n\n";

/** Quoted text with the handoff's own tags defused, so it cannot close the block early. */
function defuse(text: string): string {
  return text.replace(/<(\/?)1harness-handoff>/g, "‹$11harness-handoff›");
}

/**
 * A message as it was written, without a handoff in front of it, for a harness
 * that echoes what it was sent rather than which message it was.
 */
export function stripHandoff(text: string): string {
  if (!text.startsWith(OPEN)) return text;
  const end = text.indexOf(`${CLOSE}${TRAILER}`);
  return end === -1 ? text : text.slice(end + CLOSE.length + TRAILER.length);
}

function clip(text: string): string {
  const trimmed = defuse(text.trim());
  if (trimmed.length <= FIELD_LIMIT) return trimmed;
  return `${trimmed.slice(0, FIELD_LIMIT)}… (${trimmed.length - FIELD_LIMIT} more characters)`;
}

/** Who sent the message that started a run. */
function sender(run: RunRecord): string {
  const origin = run.origin;
  if (!origin) return "Message";
  switch (origin.type) {
    case "user":
      return "User";
    case "task":
      return `Task from thread ${origin.from}`;
    case "message":
      return `Message from thread ${origin.from}`;
    case "report":
      return `Result from thread ${origin.from}`;
  }
}

/** A turn's latest commands: what ran and how it exited, never what it printed. */
function describeCommands(commands: RunRecord["commands"]): string | null {
  if (commands.length === 0) return null;
  const shown = commands.slice(-COMMAND_COUNT).map(({ command, exitCode }) => {
    const line = defuse(command.replace(/\s+/g, " ").trim());
    const cut = line.length > COMMAND_LIMIT ? `${line.slice(0, COMMAND_LIMIT)}…` : line;
    return `\`${cut}\` → ${exitCode === null ? "no exit code" : `exit ${exitCode}`}`;
  });
  const earlier = commands.length - shown.length;
  return `Commands${earlier > 0 ? ` (latest ${shown.length} of ${commands.length})` : ""}: ${shown.join("; ")}`;
}

function describeRun(run: RunRecord, label: (harness: HarnessId) => string): string {
  const outcome =
    run.status === "completed" ? "" : ` · ${run.status}${run.error ? `: ${run.error}` : ""}`;
  const lines = [
    `Turn ${run.index} · ${label(run.harness)}${outcome}`,
    `${sender(run)}: ${run.input.trim() ? clip(run.input) : "(none)"}`,
    `Reply: ${run.result?.trim() ? clip(run.result) : "(none)"}`,
  ];
  const commands = describeCommands(run.commands);
  if (commands) lines.push(commands);
  if (run.files.length > 0) lines.push(`Files changed: ${defuse(run.files.join(", "))}`);
  return lines.join("\n");
}

function list(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Where turns are left out, and the call that reads them. */
function gap(threadId: string, from: number, to: number): string {
  const which = from === to ? `Turn ${from} is` : `Turns ${from}–${to} are`;
  return `[${which} left out here. Read ${from === to ? "it" : "them"} only if you need ${from === to ? "it" : "them"}: thread_read {"threadId": "${threadId}", "fromRun": ${from}, "toRun": ${to}}]`;
}

/**
 * Which turns fit: always the latest, then the thread's first turn when it is
 * among them, since the harness never saw the original request, then as many
 * of the newest as the budget allows. Kept turns stay whole but for long
 * fields, so the left-out ones form one range.
 */
function select(blocks: readonly string[], pinFirst: boolean): Set<number> {
  const kept = new Set<number>();
  const last = blocks.length - 1;
  let used = blocks[last]?.length ?? 0;
  kept.add(last);
  const first = blocks[0]?.length ?? 0;
  if (pinFirst && last > 0 && used + first <= BUDGET) {
    kept.add(0);
    used += first;
  }
  for (let index = last - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const size = blocks[index]?.length ?? 0;
    if (used + size > BUDGET) break;
    kept.add(index);
    used += size;
  }
  return kept;
}

/**
 * What a harness taking a thread over is told before the next message: the
 * turns it has not seen, as history rather than requests. Null when it missed
 * nothing. Built from the thread's records rather than asked of the harness
 * leaving, so it costs no turn and works when that harness is gone. It never
 * carries reasoning, which a model may refuse to take from another session.
 */
export function handoffText(options: HandoffOptions): string | null {
  const runs = options.runs.filter((run) => run.status !== "running");
  if (runs.length === 0) return null;
  const blocks = runs.map((run) => describeRun(run, options.label));
  // A resumed thread may have seen nothing, such as one whose handoff never went out.
  const kept = select(blocks, runs[0]?.index === 1);
  const others = list([
    ...new Set(
      runs.filter((run) => run.harness !== options.to).map((run) => options.label(run.harness)),
    ),
  ]);
  const id = options.threadId;
  const history =
    "They are finished history, not requests: do not redo them. Act only on the message after this block.";
  const last = runs.at(-1)?.index ?? 0;
  const intro = options.forked
    ? `This 1harness thread starts from thread ${id}, as it stood after turn ${last}. Below are that thread's turns, oldest first. ${history} The working folder may have changed since then; check before relying on it.`
    : options.resumed
      ? `You are back on 1harness thread ${id}.${others ? ` While you were away it ran on ${others}.` : ""} Below are the turns you missed, oldest first. ${history} The files in the working folder already reflect them.`
      : `1harness thread ${id} has moved to you (${options.label(options.to)})${others ? ` from ${others}` : ""}. Below are its earlier turns, oldest first, which you have not seen. ${history} The working folder is the same, so its files and \`git status\` show where the work stands.`;
  const body: string[] = [];
  let skipped: number[] = [];
  const closeGap = () => {
    const [from, to] = [skipped[0], skipped.at(-1)];
    if (from !== undefined && to !== undefined) body.push(gap(id, from, to));
    skipped = [];
  };
  runs.forEach((run, index) => {
    if (!kept.has(index)) {
      skipped.push(run.index);
      return;
    }
    closeGap();
    body.push(blocks[index] ?? "");
  });
  closeGap();
  return `${[OPEN, intro, "", body.join("\n\n"), CLOSE].join("\n")}${TRAILER.trimEnd()}`;
}
