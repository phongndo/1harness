import type { Usage } from "../core/events.ts";
import type { ThreadListing, ThreadState } from "../protocol.ts";
import type { ThreadRow, ThreadSummaryRow } from "../store/store.ts";
import type { ManagedThread, RunRecord } from "./manager.ts";

// How a thread looks to clients and to the store, from the thread in memory
// or from its row alone.

/** How much of a run's message and reply a thread's state carries; tools read the rest. */
const RUN_TEXT = 4_000;

/** Pinned and archived, as the store keeps them. */
export interface Flags {
  pinned: boolean;
  archived: boolean;
}

export const NO_FLAGS: Flags = { pinned: false, archived: false };

/** What the host keeps of a thread in memory besides the manager's record of it. */
export interface Marks {
  flags: Flags;
  /** How many of its runs a client has shown. */
  seenRuns: number;
}

/** When a thread last did anything: its last run's end or start, or its creation. */
export function updatedAt(runs: readonly RunRecord[], createdAt: number): number {
  const last = runs.at(-1);
  return last?.endedAt ?? last?.startedAt ?? createdAt;
}

function clipText(text: string | null): string | null {
  return text !== null && text.length > RUN_TEXT ? `${text.slice(0, RUN_TEXT)}…` : text;
}

/** A thread's last run as its state carries it, its message and reply clipped. */
export function lastRunView(runs: readonly RunRecord[]): RunRecord | null {
  const last = runs.at(-1);
  return last
    ? { ...last, input: clipText(last.input) ?? "", result: clipText(last.result) }
    : null;
}

/**
 * Usage saved before a restart: its context and cost still hold, but its
 * subscription limits are old news, and the harness says them again.
 */
export function restoredUsage(usage: Usage | null): Usage | null {
  return usage ? { ...usage, limits: [] } : null;
}

/** Whether a thread finished runs no client has shown. */
export function unseen(runs: number, last: RunRecord["status"] | null, seen: number): boolean {
  const finished = last === "running" ? runs - 1 : runs;
  return finished > seen;
}

/**
 * A thread a client opened and left with nothing in it: no runs, nothing
 * queued, no agents, and not named or pinned, which says it is wanted. A fork
 * has the turns it came from, though it has run none of its own.
 */
export function isEmpty(thread: {
  origin: "user" | "delegated";
  forkedFrom: string | null;
  named: boolean;
  pinned: boolean;
  runs: number;
  queued: number;
  children: number;
}): boolean {
  return (
    thread.origin === "user" &&
    thread.forkedFrom === null &&
    !thread.named &&
    !thread.pinned &&
    thread.runs === 0 &&
    thread.queued === 0 &&
    thread.children === 0
  );
}

export function threadState(
  managed: ManagedThread,
  marks: Marks,
  commandsVersion: number,
): ThreadState {
  const thread = managed.thread;
  return {
    id: managed.id,
    title: managed.title,
    harness: managed.harness,
    parentId: managed.parentId,
    parentCallId: managed.parentCallId,
    origin: managed.origin,
    createdAt: managed.createdAt,
    updatedAt: updatedAt(managed.runs, managed.createdAt),
    status: managed.status,
    error: managed.error,
    info: { ...thread.info },
    capabilities: thread.capabilities,
    methods: [...thread.methods],
    busy: thread.busy,
    queue: [...thread.queue],
    held: thread.held,
    requests: [...thread.requests],
    usage: thread.usage,
    runCount: managed.runs.length,
    lastRun: lastRunView(managed.runs),
    background: thread.session?.backgroundTasks?.() ?? [],
    commandsVersion,
    openedBy: managed.openedBy,
    seenRuns: marks.seenRuns,
    pinned: marks.flags.pinned,
    archived: marks.flags.archived,
  };
}

/** A thread's state from the store alone, for one not in memory, such as a closed agent. */
export function storedState(row: ThreadRow, runs: readonly RunRecord[]): ThreadState {
  return {
    id: row.id,
    title: row.title,
    harness: row.harness,
    parentId: row.parentId,
    parentCallId: row.parentCallId,
    origin: row.origin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.state === "closed" ? "closed" : "parked",
    error: row.error,
    info: row.info,
    capabilities: row.capabilities,
    methods: row.methods,
    busy: false,
    queue: [],
    held: false,
    requests: [],
    usage: restoredUsage(row.usage),
    runCount: runs.length,
    lastRun: lastRunView(runs),
    background: [],
    commandsVersion: 0,
    openedBy: null,
    seenRuns: row.seenRuns,
    pinned: row.pinned,
    archived: row.archived,
  };
}

export function threadListing(managed: ManagedThread, marks: Marks): ThreadListing {
  const info = managed.thread.info;
  return {
    id: managed.id,
    title: managed.title,
    harness: managed.harness,
    model: info.model,
    effort: info.effort,
    cwd: info.cwd,
    status: managed.status,
    parentId: managed.parentId,
    runCount: managed.runs.length,
    createdAt: managed.createdAt,
    updatedAt: updatedAt(managed.runs, managed.createdAt),
    pinned: marks.flags.pinned,
    archived: marks.flags.archived,
    unseen: unseen(managed.runs.length, managed.runs.at(-1)?.status ?? null, marks.seenRuns),
    native: info.threadId,
  };
}

/** A stored thread for a listing, as the store last saw it. */
export function rowListing(row: ThreadSummaryRow): ThreadListing {
  return {
    id: row.id,
    title: row.title,
    harness: row.harness,
    model: row.info.model,
    effort: row.info.effort,
    cwd: row.cwd,
    status: row.state === "closed" ? "closed" : "parked",
    parentId: row.parentId,
    runCount: row.runCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pinned: row.pinned,
    archived: row.archived,
    unseen: unseen(row.runCount, row.lastRunStatus, row.seenRuns),
    native: row.info.threadId,
  };
}

/** A thread as the store keeps it. */
export function threadRow(
  managed: ManagedThread,
  marks: Marks,
  seenWithoutHandoff: number | null,
): ThreadRow {
  const thread = managed.thread;
  return {
    id: managed.id,
    title: managed.title,
    named: managed.named,
    cwd: thread.info.cwd,
    harness: managed.harness,
    parentId: managed.parentId,
    parentCallId: managed.parentCallId,
    origin: managed.origin,
    forkedFrom: managed.forkedFrom,
    forkContext: managed.forkContext,
    state: managed.status === "closed" ? "closed" : thread.session ? "open" : "parked",
    info: { ...thread.info },
    capabilities: thread.capabilities,
    methods: [...thread.methods],
    handoff: thread.handoff,
    seenWithoutHandoff,
    generation: thread.generation,
    error: managed.error,
    pinned: marks.flags.pinned,
    archived: marks.flags.archived,
    seenRuns: marks.seenRuns,
    usage: thread.usage,
    createdAt: managed.createdAt,
    updatedAt: updatedAt(managed.runs, managed.createdAt),
  };
}
