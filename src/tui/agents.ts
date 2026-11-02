import { stripVTControlCharacters } from "node:util";
import type { MessageOrigin } from "../core/thread.ts";
import type { ThreadState } from "../protocol.ts";
import { inline } from "./markdown.ts";
import { style } from "./theme.ts";
import { plainText } from "./text.ts";

// How the terminal names and colors what threads are doing, so agent rows and
// the thread picker use one word per state.

export type AgentStatus =
  | "starting"
  | "working"
  | "needs you"
  | "done"
  | "failed"
  | "stopped"
  | "idle";

export function agentStatus(thread: ThreadState): AgentStatus {
  const run = thread.lastRun;
  switch (thread.status) {
    case "starting":
      return "starting";
    case "working":
      return "working";
    case "waiting":
      return "needs you";
    case "idle":
    case "parked":
    case "closed": {
      if (!run) return thread.error ? "failed" : thread.status === "closed" ? "stopped" : "idle";
      if (run.status === "completed") return "done";
      return run.status === "failed" ? "failed" : "stopped";
    }
  }
}

/** How a reported task ended, in the words its agent row uses. */
export function reportStatus(
  status: Extract<MessageOrigin, { type: "report" }>["status"],
): AgentStatus {
  if (status === "completed") return "done";
  return status === "failed" ? "failed" : "stopped";
}

/** Still has work, so its timer runs. */
export function isLive(status: AgentStatus): boolean {
  return status === "starting" || status === "working" || status === "needs you";
}

export function paintStatus(status: AgentStatus, text: string = status): string {
  switch (status) {
    case "starting":
    case "working":
      return style.active(text);
    case "needs you":
      return style.attention(text);
    case "done":
      return style.added(text);
    case "failed":
      return style.removed(text);
    case "stopped":
    case "idle":
      return style.muted(text);
  }
}

/** A dot in the status's color, as rows lead with. */
export function statusDot(status: AgentStatus): string {
  return paintStatus(status, status === "needs you" ? "◆" : "●");
}

/** `12s`, `1m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** When the thread's latest work started and ended; the end is null while it is live. */
export function agentSpan(thread: ThreadState): { startedAt: number; endedAt: number | null } {
  const run = thread.lastRun;
  const live = isLive(agentStatus(thread));
  return {
    startedAt: run?.startedAt ?? thread.createdAt,
    endedAt: live ? null : (run?.endedAt ?? run?.startedAt ?? thread.createdAt),
  };
}

/** An agent as a parent's transcript shows it, kept current as the agent works. */
export interface AgentRow {
  threadId: string;
  /** The parent's tool call that started the agent, which this row shows instead. */
  callId: string | null;
  /** What it runs on: `codex · gpt-6.1-sol · xhigh`. */
  label: string;
  title: string;
  status: AgentStatus;
  startedAt: number;
  endedAt: number | null;
  /** What it found or why it failed, or what it asks of the user. */
  detail: string;
}

export function agentRowOf(thread: ThreadState): AgentRow {
  const status = agentStatus(thread);
  const run = thread.lastRun;
  const asking = thread.requests[0];
  // Only what asks for something: a question or approval, or why it failed.
  const detail =
    status === "needs you"
      ? `${asking?.kind === "question" ? "Has a question" : "Needs approval"} · ctrl+o to answer`
      : status === "failed"
        ? plainLine(run?.error ?? thread.error ?? "")
        : "";
  return {
    threadId: thread.id,
    callId: thread.parentCallId,
    label: harnessLabel(thread),
    title: thread.title || thread.id,
    status,
    ...agentSpan(thread),
    detail,
  };
}

/** What a thread runs on, `codex · gpt-6.1-sol · xhigh`; a default model or effort is left out. */
export function runsOn(harness: string, model: string | null, effort: string | null): string {
  return [harness, model, effort].filter(Boolean).join(" · ");
}

/** What a live thread runs on, as `runsOn` says it. */
export function harnessLabel(thread: ThreadState): string {
  return runsOn(thread.harness, thread.info.model, thread.info.effort);
}

/** The first line of text with Markdown markers dropped, for one-line previews. */
export function plainLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const body = line.replace(/^\s*(?:#+\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "");
  return plainText(stripVTControlCharacters(inline(body)), true);
}

/**
 * Tree branches for threads in tree order, each one's children after it:
 * `├ ` and `└ ` before a child, `│ ` under a parent's later siblings.
 */
export function treePrefixes(threads: readonly ThreadState[]): string[] {
  const shown = new Set(threads.map((thread) => thread.id));
  const parentOf = (thread: ThreadState) =>
    thread.parentId && shown.has(thread.parentId) ? thread.parentId : null;
  const isLast = (index: number): boolean => {
    const thread = threads[index];
    if (!thread) return true;
    const parent = parentOf(thread);
    return !threads.slice(index + 1).some((other) => parentOf(other) === parent);
  };
  return threads.map((thread, index) => {
    const parts: string[] = [];
    let current: ThreadState | undefined = thread;
    let position = index;
    while (current && parentOf(current)) {
      const last = isLast(position);
      parts.unshift(current === thread ? (last ? "└ " : "├ ") : last ? "  " : "│ ");
      const parentId = parentOf(current);
      position = threads.findIndex((other) => other.id === parentId);
      current = threads[position];
    }
    return parts.join("");
  });
}
