import type { ThreadState } from "../protocol.ts";

/** A thread as quitting names it, to come back to. */
type Leaving = Pick<ThreadState, "id" | "harness" | "runCount"> &
  Partial<Pick<ThreadState, "title">> & {
    info: Pick<ThreadState["info"], "threadId">;
  };

/** How much of a 1harness thread ID to type: enough to tell it apart, as `--resume` matches a prefix. */
const SHORT_ID = 8;
/** The most of a thread's title quitting repeats. */
const TITLE_LENGTH = 50;

/**
 * What quitting says under the screen it gives back: the server /connect
 * moves to, or what was still working, and the command that comes back to
 * the thread on screen, or to one still working when that one has nothing
 * to go back to.
 */
export function goodbye(state: {
  /** The server /connect chose, "" for this machine's, or undefined. */
  next: string | undefined;
  server: { label: string; local: boolean; inProcess: boolean };
  /** Whether the host keeps threads, so one comes back by its 1harness ID. */
  stored: boolean;
  current: Leaving | undefined;
  working: readonly Leaving[];
}): string[] {
  const { next, server, working } = state;
  if (next !== undefined) return [`Connecting to ${next || "this machine's 1harness"}…`];
  const on = server.local ? "" : ` -S ${server.label}`;
  const target = state.current && state.current.runCount > 0 ? state.current : working[0];
  const hint = !target
    ? null
    : state.stored
      ? `1harness${on} --resume ${target.id.slice(0, SHORT_ID)}`
      : target.info.threadId
        ? `1harness${on} --harness ${target.harness} --resume ${target.info.threadId}`
        : null;
  const lines: string[] = [];
  const ids = working.map((thread) => thread.id).join(", ");
  const one = working.length === 1;
  const they = one ? "it" : "they";
  // A server keeps what was working going; this process takes it down with it.
  if (working.length > 0)
    lines.push(
      server.inProcess
        ? `${ids} stopped working: without a server, ${they} ran in this 1harness.`
        : `${ids} ${one ? "is" : "are"} still working; ${they} ${one ? "carries" : "carry"} on in 1harness's server${server.local ? "" : ` on ${server.label}`}.`,
    );
  // Otherwise nothing says whether what was on screen survives quitting.
  if (hint && state.stored && working.length === 0) {
    const title = target?.title?.trim();
    const named =
      title && title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;
    lines.push(`${named ? `Saved "${named}"` : "Saved this thread"}; nothing is still running.`);
  }
  if (hint)
    lines.push(`${working.length > 0 && !server.inProcess ? "Come back" : "Resume"} with: ${hint}`);
  return lines;
}
