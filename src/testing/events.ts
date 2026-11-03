import type { HarnessEvent, NoticeLevel } from "../core/events.ts";

/** Reads a session's events as they come; `ended` settles when they stop. */
export function collect(session: { events: AsyncIterable<HarnessEvent> }): {
  events: HarnessEvent[];
  ended: Promise<void>;
} {
  const events: HarnessEvent[] = [];
  const ended = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, ended };
}

export async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return Promise.race([
    promise,
    new Promise<"timed out">((resolve) => setTimeout(resolve, ms, "timed out").unref()),
  ]);
}

/** The text of the notices at `level` among `events`. */
export function notices(events: readonly HarnessEvent[], level: NoticeLevel): string[] {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.item.kind === "notice" && event.item.level === level
      ? [event.item.text]
      : [],
  );
}
