import type { LogEntry, ThreadState } from "../protocol.ts";
import { StatusReporter, statusRecords, threadStatusInput } from "../tui/program-status.ts";
import type { HostClient } from "./client.ts";

/** Reports go out at most this often, coalescing bursts of events. */
const INTERVAL_MS = 250;

const STATES: Record<ThreadState["status"], string> = {
  starting: "starting",
  idle: "idle",
  working: "working",
  waiting: "needs you",
  parked: "parked",
  closed: "closed",
};

/** The last bold heading in reasoning text, as Codex writes its summaries. */
function heading(text: string): string | null {
  const found = [...text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)];
  return found.at(-1)?.[1]?.trim() ?? null;
}

/** What an entry says a thread is doing, or undefined when it says nothing new. */
function activityOf(entry: LogEntry): string | null | undefined {
  switch (entry.type) {
    case "turn.started":
    case "turn.ended":
    case "session.ended":
      return null;
    case "item": {
      const item = entry.item;
      if (item.kind === "reasoning") return heading(item.text) ?? undefined;
      if (item.kind === "command" && item.status === "running") return `Running ${item.command}`;
      if (item.kind === "tool_call" && item.status === "running")
        return item.summary || `Using ${item.tool}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Threads in tree order, each one's children after it. */
function ordered(threads: ThreadState[]): { thread: ThreadState; depth: number }[] {
  const open = threads.filter((thread) => thread.status !== "closed");
  const ids = new Set(open.map((thread) => thread.id));
  const under = (parent: string | null, depth: number): { thread: ThreadState; depth: number }[] =>
    open
      .filter(
        (thread) =>
          (thread.parentId && ids.has(thread.parentId) ? thread.parentId : null) === parent,
      )
      .flatMap((thread) => [{ thread, depth }, ...under(thread.id, depth + 1)]);
  return under(null, 0);
}

/**
 * Follows every thread on a host and reports each as a program status
 * record (OSC 7501), as the terminal UI does for its own, for a terminal
 * such as a Rex tab with no 1harness UI open in it. It also lists them.
 */
export async function watch(
  client: HostClient,
  out: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  const reporter =
    process.env["ONEHARNESS_PROGRAM_STATUS"] === "0"
      ? null
      : new StatusReporter((data) => out.write(data));
  const activity = new Map<string, string | null>();
  let timer: NodeJS.Timeout | null = null;
  let connected = true;
  const render = () => {
    timer = null;
    const threads = [...client.threads.values()];
    reporter?.update(
      statusRecords(
        threads.map((thread) => threadStatusInput(thread, activity.get(thread.id) ?? null)),
        (id) => client.threads.get(id)?.seenRuns ?? 0,
      ),
    );
    const rows = ordered(threads).map(({ thread, depth }) => {
      const doing = activity.get(thread.id);
      const state = STATES[thread.status];
      const detail =
        thread.status === "waiting"
          ? thread.requests[0]?.kind === "question"
            ? "has a question"
            : "needs approval"
          : thread.status === "working" && doing
            ? doing
            : "";
      return `${"  ".repeat(depth)}${thread.id.padEnd(5)} ${state.padEnd(10)} ${thread.harness.padEnd(9)} ${thread.title || "untitled"}${detail ? ` · ${detail}` : ""}`;
    });
    out.write(
      `\x1b[H\x1b[2J1harness · ${rows.length} ${rows.length === 1 ? "thread" : "threads"}${connected ? "" : " · reconnecting…"}\n\n${rows.join("\n")}\n`,
    );
  };
  const schedule = () => {
    timer ??= setTimeout(render, INTERVAL_MS);
  };
  client.on((event) => {
    if (event.type === "entry") {
      const doing = activityOf(event.entry);
      if (doing === undefined) return;
      activity.set(event.threadId, doing);
    }
    if (event.type === "connection") connected = event.state === "connected";
    schedule();
  });
  await client.connect();
  render();
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (timer) clearTimeout(timer);
      reporter?.clear();
      out.write("\n");
      void client.close().finally(resolve);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  });
}
