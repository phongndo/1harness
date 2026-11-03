import type { ThreadListing, ThreadState } from "../protocol.ts";
import { agentStatus, harnessLabel, isLive, statusDot } from "./agents.ts";
import { listedEntry, type ResumeEntry } from "./resume.ts";

// The thread lists ctrl+t and /lineage open, built from what the host keeps
// of threads and, over that, the threads open now as they stand.

/** When a thread last did something: its latest run, or its start. */
export function lastActive(thread: ThreadState): number {
  return thread.lastRun?.endedAt ?? thread.lastRun?.startedAt ?? thread.createdAt;
}

/**
 * A thread and the ones above it, nearest first, as far as `parent` finds
 * them; a parent met twice ends it, so a loop in what the host says cannot.
 */
export function ancestry<T>(thread: T, parent: (thread: T) => T | undefined): T[] {
  const chain = [thread];
  for (let up = parent(thread); up && !chain.includes(up); up = parent(up)) chain.push(up);
  return chain;
}

/** An open thread's entry, as it stands now. */
function liveEntry(thread: ThreadState): ResumeEntry {
  const status = agentStatus(thread);
  return {
    id: thread.id,
    title: thread.title,
    on: harnessLabel(thread),
    cwd: thread.info.cwd,
    updatedAt: lastActive(thread),
    depth: 0,
    // A thread at work, or waiting on you, says so with its dot.
    dot: isLive(status) ? `${statusDot(status)} ` : "",
  };
}

/** A thread in a tree of them, under the one that started it. */
interface TreeNode {
  entry: ResumeEntry;
  parentId: string | null;
  createdAt: number;
}

function listedNode(thread: ThreadListing): TreeNode {
  return { entry: listedEntry(thread), parentId: thread.parentId, createdAt: thread.createdAt };
}

function liveNode(thread: ThreadState): TreeNode {
  return { entry: liveEntry(thread), parentId: thread.parentId, createdAt: thread.createdAt };
}

/**
 * `top`, from `depth`, each followed by the threads it started, a level
 * deeper, oldest first. A thread whose parent is not among `nodes` shows
 * only where it is in `top`.
 */
function flattenTree(
  nodes: Iterable<TreeNode>,
  top: readonly TreeNode[],
  depth = 0,
): ResumeEntry[] {
  const under = new Map<string, TreeNode[]>();
  for (const node of nodes)
    if (node.parentId) under.set(node.parentId, [...(under.get(node.parentId) ?? []), node]);
  const walk = (level: readonly TreeNode[], at: number): ResumeEntry[] =>
    level.flatMap((node) => [
      { ...node.entry, depth: at },
      ...walk(
        (under.get(node.entry.id) ?? []).toSorted((a, b) => a.createdAt - b.createdAt),
        at + 1,
      ),
    ]);
  return walk(top, depth);
}

/**
 * The thread list: your threads, newest first, each followed by the agents
 * it started; then your archived threads. `open` are the threads open now;
 * `currentId` the thread on screen.
 */
export function threadEntries(
  recent: readonly ThreadListing[],
  archived: readonly ThreadListing[],
  open: Iterable<ThreadState>,
  currentId: string | null,
): ResumeEntry[] {
  // The thread on screen with nothing in it yet is where you are, not one to go back to.
  const empty = (thread: { id: string; runCount: number }) =>
    thread.runCount === 0 && thread.id === currentId;
  const nodes = new Map<string, TreeNode>();
  for (const thread of recent) if (!empty(thread)) nodes.set(thread.id, listedNode(thread));
  // Open threads as they stand now, over what the store last kept of them.
  for (const thread of open)
    if (thread.status !== "closed" && !thread.archived && !empty(thread))
      nodes.set(thread.id, liveNode(thread));
  const roots = [...nodes.values()]
    .filter((node) => node.parentId === null)
    .toSorted((a, b) => b.entry.updatedAt - a.entry.updatedAt);
  const entries = flattenTree(nodes.values(), roots);
  // Archived threads, which tab shows on their own.
  for (const thread of archived)
    if (thread.parentId === null) entries.push({ ...listedEntry(thread), archived: true });
  return entries;
}

/**
 * What /lineage shows: the title of the thread of yours `currentId` came
 * from, and the agents under it, parents first, as they stand now.
 */
export function family(
  stored: readonly ThreadListing[],
  open: Iterable<ThreadState>,
  currentId: string | null,
): { title: string; agents: ResumeEntry[] } {
  const nodes = new Map<string, TreeNode>();
  for (const thread of stored) nodes.set(thread.id, listedNode(thread));
  // Threads open here as they stand now, over what the store last kept of them.
  for (const thread of open) nodes.set(thread.id, liveNode(thread));
  const current = currentId ? nodes.get(currentId) : undefined;
  const root =
    current &&
    ancestry(current, (node) => (node.parentId ? nodes.get(node.parentId) : undefined)).at(-1);
  if (!root) return { title: "", agents: [] };
  const id = root.entry.id;
  const agents = [...nodes.values()]
    .filter((node) => node.parentId === id)
    .toSorted((a, b) => a.createdAt - b.createdAt);
  return { title: root.entry.title, agents: flattenTree(nodes.values(), agents) };
}
