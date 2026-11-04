import type { HarnessId } from "../core/events.ts";
import { looksLikeThreadId } from "../core/thread-id.ts";
import { safeCut } from "../core/wording.ts";
import type { RunRecord } from "./manager.ts";

/** The most characters a handoff takes, so it stays a small part of a context window. */
const BUDGET = 24_000;
const CHARS_PER_TOKEN = 4;
/** Tokens a session keeps free for its own work, or a quarter of its window if that is more. */
const RESERVE_TOKENS = 16_000;
/** How many of a turn's commands a handoff lists, the latest ones. */
const COMMAND_COUNT = 8;
const COMMAND_LIMIT = 160;
/** The start of the latest message a handoff keeps even with no room, as it may be the request. */
const MIN_START = 1_000;
/** Budget held back for the note on what is left out, which is written after choosing. */
const NOTE_ROOM = 320;
/** How many ranges of left-out turns the note names, the newest ones. */
const NOTE_RANGES = 8;

/** What is known of the session a handoff goes to; null where it is not known. */
export interface Receiver {
  contextWindow: number | null;
  /** How much of the window it has used: 0 for a new session. */
  contextTokens: number | null;
}

/** About how many tokens a text takes. */
export function tokensIn(text: string | null): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** The characters a handoff may take: the cap, or the room the receiver has if that is less. */
export function handoffBudget(receiver: Receiver | undefined): number {
  const { contextWindow: window, contextTokens: used } = receiver ?? {};
  if (!window || used === null || used === undefined) return BUDGET;
  const reserve = Math.max(RESERVE_TOKENS, window / 4);
  const room = Math.floor((window - used - reserve) * CHARS_PER_TOKEN);
  return Math.max(0, Math.min(BUDGET, room));
}

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
  /** The session it goes to, where that is known; it is never the session leaving. */
  receiver?: Receiver;
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
      // An agent outside 1harness sends from no thread.
      return looksLikeThreadId(origin.from)
        ? `Message from thread ${origin.from}`
        : `Message from ${origin.from}`;
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

/** Part of a turn that goes in whole or not at all, with a stub saying so in its place. */
interface Part {
  whole: string;
  stub: string;
  taken: boolean;
}

interface Turn {
  run: RunRecord;
  head: string;
  input: Part;
  reply: Part;
  /** Its commands and files changed. */
  activity: Part;
  /** Some of it is in the handoff. */
  shown: boolean;
}

/** A message as a handoff quotes it; having nothing to quote, it has nothing to leave out. */
function messagePart(name: string, text: string | null): Part {
  const quoted = text?.trim() ? defuse(text.trim()) : null;
  const whole = `${name}: ${quoted ?? "(none)"}`;
  return quoted === null
    ? { whole, stub: whole, taken: true }
    : { whole, stub: `${name}: (left out, ${quoted.length} characters)`, taken: false };
}

function describeTurn(run: RunRecord, label: (harness: HarnessId) => string): Turn {
  const outcome =
    run.status === "completed" ? "" : ` · ${run.status}${run.error ? `: ${run.error}` : ""}`;
  const commands = describeCommands(run.commands);
  const activity = [
    ...(commands ? [commands] : []),
    ...(run.files.length > 0 ? [`Files changed: ${defuse(run.files.join(", "))}`] : []),
  ].join("\n");
  return {
    run,
    head: `Turn ${run.index} · ${label(run.harness)}${outcome}`,
    input: messagePart(sender(run), run.input),
    reply: messagePart("Reply", run.result),
    activity: activity
      ? { whole: activity, stub: "Commands and files: (left out)", taken: false }
      : { whole: "", stub: "", taken: true },
    shown: false,
  };
}

/** A turn as it stands in the handoff. */
function renderTurn({ head, input, reply, activity }: Turn): string {
  const lines = [input, reply, activity].map((part) => (part.taken ? part.whole : part.stub));
  return [head, ...lines.filter(Boolean)].join("\n");
}

/** A result coming back from another thread is no one asking for anything. */
function isRequest({ run }: Turn): boolean {
  return run.origin?.type !== "report" && run.input.trim() !== "";
}

/**
 * Marks what fits in `budget`: the latest request, the latest reply, the
 * original request when the harness never saw it, then the rest from the newest
 * turn back. Whatever does not fit whole stays out, and smaller, older turns may
 * still fit after it. With nothing chosen at all, the latest request keeps a
 * clipped start, so a handoff always says what was asked.
 */
function choose(turns: readonly Turn[], budget: number, pinFirst: boolean): void {
  let used = 0;
  const take = (turn: Turn, ...parts: Part[]): void => {
    const growth = parts.reduce((sum, part) => sum + part.whole.length - part.stub.length, 0);
    // Stubs go in as soon as the turn does, so they count from then on.
    const size = growth + (turn.shown ? 0 : renderTurn(turn).length + 2);
    if (used + size > budget) return;
    used += size;
    turn.shown = true;
    for (const part of parts) part.taken = true;
  };
  const requests = turns.filter(isRequest);
  const [firstRequest, latestRequest] = [requests[0], requests.at(-1)];
  if (latestRequest) take(latestRequest, latestRequest.input);
  const latestReply = turns.findLast((turn) => !turn.reply.taken);
  if (latestReply) take(latestReply, latestReply.reply);
  if (pinFirst && firstRequest && !firstRequest.input.taken) take(firstRequest, firstRequest.input);
  for (const turn of turns.toReversed()) {
    const parts = [turn.input, turn.reply, turn.activity].filter((part) => !part.taken);
    if (turn.shown) for (const part of parts) take(turn, part);
    else take(turn, ...parts);
  }
  if (latestRequest && !turns.some((turn) => turn.shown)) {
    latestRequest.shown = true;
    latestRequest.input = clippedPart(latestRequest, budget);
  }
}

/**
 * The start of a turn's message, marked as clipped, in what budget the turn has.
 * Its whole is still left out, so it counts as not taken.
 */
function clippedPart(turn: Turn, budget: number): Part {
  const name = sender(turn.run);
  const quoted = defuse(turn.run.input.trim());
  const mark = (end: number) => `… (clipped: the first ${end} of ${quoted.length} characters)`;
  const rest = renderTurn(turn).length - turn.input.stub.length;
  const room = budget - rest - name.length - 2 - mark(quoted.length).length;
  const end = Math.max(MIN_START, room);
  if (end >= quoted.length) return { ...turn.input, taken: true };
  const cut = safeCut(quoted, end);
  const text = `${name}: ${quoted.slice(0, cut)}${mark(cut)}`;
  return { whole: text, stub: text, taken: false };
}

function list(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Consecutive run numbers as ranges, such as `2–9`, `11`. */
function ranges(indexes: readonly number[]): [number, number][] {
  const found: [number, number][] = [];
  for (const index of indexes) {
    const last = found.at(-1);
    if (last && last[1] === index - 1) last[1] = index;
    else found.push([index, index]);
  }
  return found;
}

/** How much was left out, and the call that reads it. Null when nothing was. */
function leftOutNote(threadId: string, turns: readonly Turn[]): string | null {
  const absent = turns.filter((turn) => !turn.shown).map((turn) => turn.run.index);
  const partial = turns
    .filter(
      ({ shown, input, reply, activity }) =>
        shown && !(input.taken && reply.taken && activity.taken),
    )
    .map((turn) => turn.run.index);
  if (absent.length === 0 && partial.length === 0) return null;
  const all = ranges(absent);
  const named = all
    .slice(-NOTE_RANGES)
    .map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`));
  const parts =
    partial.length > 0
      ? `parts of ${partial.length === 1 ? "turn" : "turns"} ${partial.join(", ")}`
      : "";
  const what =
    absent.length > 0
      ? `${absent.length} of ${turns.length} ${turns.length === 1 ? "turn" : "turns"} left out (${all.length > named.length ? "…, " : ""}${named.join(", ")})${parts && `, and ${parts}`}`
      : `Left out: ${parts}`;
  const [from, to] = all.at(-1) ?? [partial.at(-1), partial.at(-1)];
  return `[${what}. Read what you need: thread_read {"threadId": "${threadId}", "fromRun": ${from}, "toRun": ${to}}]`;
}

/** What is inside a handoff's tags. */
function inner(handoff: string): string {
  const end = handoff.lastIndexOf(`\n${CLOSE}`);
  return handoff.slice(OPEN.length + 1, end === -1 ? undefined : end);
}

/**
 * Two handoffs as one, the first's history before the second's, such as a
 * forked thread's start and the turns it ran since.
 */
export function combineHandoffs(first: string | null, second: string | null): string | null {
  if (!first || !second) return first ?? second;
  return `${[OPEN, inner(first), "", inner(second), CLOSE].join("\n")}${TRAILER.trimEnd()}`;
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
  const turns = runs.map((run) => describeTurn(run, options.label));
  const frame = [OPEN, intro, "", "", CLOSE].join("\n").length + TRAILER.length;
  // A resumed thread may have seen nothing, such as one whose handoff never went out.
  choose(turns, handoffBudget(options.receiver) - frame - NOTE_ROOM, runs[0]?.index === 1);
  const note = leftOutNote(id, turns);
  const body = [
    ...(note ? [note] : []),
    ...turns.filter((turn) => turn.shown).map((turn) => renderTurn(turn)),
  ];
  return `${[OPEN, intro, "", body.join("\n\n"), CLOSE].join("\n")}${TRAILER.trimEnd()}`;
}
