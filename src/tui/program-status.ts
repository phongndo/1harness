import type { HarnessRequest } from "../core/events.ts";
import type { ThreadState } from "../protocol.ts";
import { shortThreadId } from "../core/thread-id.ts";
import { firstLine } from "./text.ts";
import { ancestry } from "./threads.ts";

// The Program Status Protocol (OSC 7501), which lets a program tell its
// terminal what it is doing: idle, working, blocked on the user, done, or
// failed. Rex shows it in its session picker and tab headers. 1harness reports
// one record for itself and one per thread, nested the way threads start one
// another. https://www.superlogical.com/rex/docs/build/program-status

export type StatusState = "idle" | "working" | "done" | "blocked" | "error";

/** One record: the root when `id` is null, otherwise a thread's path, such as `t1/t3`. */
export interface StatusRecord {
  id: string | null;
  state: StatusState;
  /** What a blocked record waits for. */
  kind?: "permission" | "question";
  /** A short label, such as the thread's title. */
  title?: string;
  /** One line about what it is doing, waiting for, or finished. */
  msg?: string;
  app?: string;
}

/** A thread as the status cares about it, whichever client knows it. */
export interface ThreadStatusInput {
  id: string;
  parentId: string | null;
  title: string;
  status: "starting" | "idle" | "working" | "waiting" | "parked" | "closed";
  /** The oldest open request, if any. */
  request: { kind: "approval" | "question"; title: string } | null;
  lastRun: {
    index: number;
    status: "running" | "completed" | "failed" | "interrupted";
    result: string | null;
    error: string | null;
  } | null;
  /** Why the session ended, when it ended badly. */
  error: string | null;
  /** What it is doing right now, when known. */
  activity: string | null;
  /**
   * Whether its finished runs are news to the user. An agent's thread reports
   * to that agent, so only its work in progress and its requests are shown.
   */
  notify: boolean;
}

export const STATUS_QUERY = "\x1b]7501;?\x1b\\";
const APP = "1harness";
const MSG_BYTES = 2048;
const TITLE_BYTES = 192;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const MAX_DEPTH = 8;
const ID_BYTES = 128;
/**
 * Whether a character may go in a report: no control characters, which the
 * protocol forbids, and none of the invisible formatting that could make a
 * message read as something else outside the terminal.
 */
function safe(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return !(
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** One line of text, safe to report, cut to at most `bytes` of UTF-8. */
function line(text: string, bytes: number): string {
  let kept = "";
  let size = 0;
  for (const char of text.replace(/\s+/g, " ").trim()) {
    if (!safe(char)) continue;
    const length = Buffer.byteLength(char);
    if (size + length > bytes) break;
    kept += char;
    size += length;
  }
  return kept.trim();
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Whether an ID follows the protocol's grammar: segments joined by `/`. */
export function validId(id: string): boolean {
  const segments = id.split("/");
  return (
    Buffer.byteLength(id) <= ID_BYTES &&
    segments.length <= MAX_DEPTH &&
    segments.every((segment) => SEGMENT.test(segment))
  );
}

/** The escape sequence for one record, or for clearing one (every record when `id` is null). */
export function encodeStatus(record: StatusRecord | { id: string | null; state: "clear" }): string {
  const pairs = [`state=${record.state}`];
  if (record.id !== null) {
    if (!validId(record.id)) throw new Error(`Not a status ID: ${record.id}`);
    pairs.push(`id=${record.id}`);
  }
  if (record.state !== "clear") {
    if (record.state === "blocked" && record.kind) pairs.push(`kind=${record.kind}`);
    if (record.app) pairs.push(`app=${record.app}`);
    const title = record.title ? line(record.title, TITLE_BYTES) : "";
    if (title) pairs.push(`title=${base64(title)}`);
    const msg = record.msg ? line(record.msg, MSG_BYTES) : "";
    if (msg) pairs.push(`msg=${base64(msg)}`);
  }
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/** What an approval asks to do, in one line, such as `Run: pnpm test`. */
function approvalLine(request: Extract<HarnessRequest, { kind: "approval" }>): string {
  const action = request.action;
  switch (action.type) {
    case "command":
      return `Run: ${action.command}`;
    case "file_change":
      return `Edit ${action.paths.join(", ")}`;
    case "tool":
      return `Use ${action.tool}${request.title ? `: ${request.title}` : ""}`;
    case "other":
      return request.title;
  }
}

/** A thread's state as the status reports it; `activity` is what it is doing, when known. */
export function threadStatusInput(thread: ThreadState, activity: string | null): ThreadStatusInput {
  const request = thread.requests[0];
  const run = thread.lastRun;
  return {
    id: thread.id,
    parentId: thread.parentId,
    title: thread.title,
    status: thread.status,
    request: request
      ? {
          kind: request.kind,
          title:
            request.kind === "approval"
              ? approvalLine(request)
              : (request.questions[0]?.question ?? "A question"),
        }
      : null,
    lastRun: run
      ? { index: run.index, status: run.status, result: run.result, error: run.error }
      : null,
    error: thread.error,
    activity,
    notify: thread.origin === "user",
  };
}

/**
 * What to report for each open thread, and for 1harness as a whole. `seen` is
 * how many of a thread's runs the user has seen; a later finished run is news.
 */
export function statusRecords(
  threads: readonly ThreadStatusInput[],
  seen: (id: string) => number,
): StatusRecord[] {
  const open = threads.filter((thread) => thread.status !== "closed");
  const byId = new Map(open.map((thread) => [thread.id, thread]));
  const path = (thread: ThreadStatusInput): string =>
    ancestry(thread, (child) => (child.parentId ? byId.get(child.parentId) : undefined))
      // A UUID is longer than a segment may be, so each goes by its short form.
      .map((one) => shortThreadId(one.id))
      .toReversed()
      .join("/");
  const records: StatusRecord[] = [];
  for (const thread of open) {
    const id = path(thread);
    if (!validId(id)) continue;
    const base = { id, ...(thread.title ? { title: thread.title } : {}) };
    const run = thread.lastRun;
    const unseen = thread.notify && run !== null && run.index > seen(thread.id);
    if (thread.status === "waiting" && thread.request) {
      records.push({
        ...base,
        state: "blocked",
        kind: thread.request.kind === "approval" ? "permission" : "question",
        msg: thread.request.title,
      });
    } else if (thread.status === "working" || thread.status === "starting") {
      records.push({ ...base, state: "working", msg: thread.activity ?? "Working" });
    } else if (thread.error && thread.notify) {
      records.push({ ...base, state: "error", msg: thread.error });
    } else if (unseen && run.status === "failed") {
      records.push({ ...base, state: "error", msg: run.error ?? "The turn failed" });
    } else if (unseen && run.status === "completed") {
      records.push({ ...base, state: "done", msg: firstLine(run.result ?? "") || "Finished" });
    } else {
      // Idle rather than cleared: clearing a record clears every record under it.
      records.push({ ...base, state: "idle" });
    }
  }
  // 1harness as a whole shows whatever most needs the user.
  const order: StatusState[] = ["blocked", "error", "done", "working"];
  const top = order
    .map((state) => records.find((record) => record.state === state))
    .find((record) => record !== undefined);
  const root: StatusRecord = top
    ? {
        id: null,
        state: top.state,
        app: APP,
        ...(top.kind ? { kind: top.kind } : {}),
        msg: `${top.id}: ${top.msg ?? top.state}`,
      }
    : { id: null, state: "idle", app: APP };
  return [root, ...records];
}

/**
 * Keeps a terminal's records in step: writes only the records that changed,
 * and clears the ones that are gone.
 */
export class StatusReporter {
  #write: (data: string) => void;
  /** What was last written for each record, by ID ("" for the root). */
  #sent = new Map<string, string>();

  constructor(write: (data: string) => void) {
    this.#write = write;
  }

  update(records: readonly StatusRecord[]): void {
    let output = "";
    const current = new Set<string>();
    for (const record of records) {
      const key = record.id ?? "";
      current.add(key);
      const sequence = encodeStatus(record);
      if (this.#sent.get(key) === sequence) continue;
      this.#sent.set(key, sequence);
      output += sequence;
    }
    // Deepest first, so clearing a parent never takes a live child with it.
    const gone = [...this.#sent.keys()].filter((key) => !current.has(key));
    for (const key of gone.toSorted((a, b) => b.split("/").length - a.split("/").length)) {
      this.#sent.delete(key);
      if (key !== "") output += encodeStatus({ id: key, state: "clear" });
    }
    if (output) this.#write(output);
  }

  /** Removes every record, such as when 1harness exits or is suspended. */
  clear(): void {
    if (this.#sent.size === 0) return;
    this.#sent.clear();
    this.#write(encodeStatus({ id: null, state: "clear" }));
  }
}
