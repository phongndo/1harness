import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../core/async-queue.ts";
import type { HarnessEvent, Item, SessionInfo } from "../core/events.ts";
import { appendDelta } from "../core/thread.ts";

type NoticeLevel = "info" | "warning" | "error";

/** The harness's ID for the session, which its requests name; it has none until it starts. */
export function started(info: SessionInfo): string {
  if (!info.threadId) throw new Error("The session has not started");
  return info.threadId;
}

/**
 * A session's event stream. It keeps the items and requests the session has
 * opened and not ended, so a session that closes, or whose process dies, ends
 * them rather than leave work spinning and approvals waiting.
 */
export class SessionEvents {
  readonly stream = new AsyncQueue<HarnessEvent>();
  #prefix: string;
  #items = new Map<string, Item>();
  #requests = new Set<string>();
  #closed = false;

  /** `prefix` starts the IDs of the session's notices, such as `codex`. */
  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  get closed(): boolean {
    return this.#closed;
  }

  emit(...events: HarnessEvent[]): void {
    for (const event of events) {
      this.#track(event);
      this.stream.push(event);
    }
  }

  info(info: SessionInfo): void {
    this.emit({ type: "session.updated", info: { ...info } });
  }

  notice(level: NoticeLevel, text: string): void {
    this.emit({
      type: "item.completed",
      item: { kind: "notice", id: `${this.#prefix}-notice-${randomUUID()}`, level, text },
    });
  }

  /**
   * Ends the session: its open items, its turn, and its open requests, which
   * nothing will answer now. A session closed on purpose ends its turn as
   * interrupted; otherwise `reason` is why it failed.
   */
  close(turnId: string | null, reason: string, closing: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = closing ? null : reason;
    for (const requestId of this.#requests) this.emit({ type: "request.resolved", requestId });
    for (const item of this.#items.values()) {
      // Work still running failed, since it never finished.
      const settled =
        "status" in item && item.status === "running"
          ? { ...item, status: "failed" as const }
          : item;
      this.emit({ type: "item.completed", item: settled });
    }
    if (turnId !== null)
      this.emit({ type: "turn.ended", turnId, status: error ? "failed" : "interrupted", error });
    this.emit({ type: "session.closed", error });
    this.stream.end();
  }

  #track(event: HarnessEvent): void {
    switch (event.type) {
      case "item.started":
      case "item.updated":
        // A todo list stays open across a turn by design; nothing about it is running.
        if (event.item.kind !== "todo_list") this.#items.set(event.item.id, event.item);
        break;
      case "item.delta": {
        const item = this.#items.get(event.itemId);
        if (item) this.#items.set(event.itemId, appendDelta(item, event.chunk));
        break;
      }
      case "item.completed":
        this.#items.delete(event.item.id);
        break;
      case "request.opened":
        this.#requests.add(event.request.id);
        break;
      case "request.resolved":
        this.#requests.delete(event.requestId);
        break;
    }
  }
}
