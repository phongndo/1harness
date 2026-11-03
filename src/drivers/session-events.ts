import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../core/async-queue.ts";
import { errorMessage } from "../core/errors.ts";
import type {
  HarnessEvent,
  HarnessRequest,
  Item,
  NoticeLevel,
  RequestResponse,
  SessionInfo,
} from "../core/events.ts";
import { appendDelta } from "../core/thread.ts";

/** The harness's ID for the session, which its requests name; it has none until it starts. */
export function started(info: SessionInfo): string {
  if (!info.threadId) throw new Error("The session has not started");
  return info.threadId;
}

/**
 * A notice from a driver; `source` starts its ID, such as `codex`. IDs are
 * random, since a resumed thread already holds notices from its earlier sessions.
 */
export function noticeEvent(source: string, level: NoticeLevel, text: string): HarnessEvent {
  return {
    type: "item.completed",
    item: { kind: "notice", id: `${source}-notice-${randomUUID()}`, level, text },
  };
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
  /** What sends the harness the user's answer, for each request still open. */
  #answers = new Map<string, (response: RequestResponse) => unknown>();
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
    this.emit(noticeEvent(this.#prefix, level, text));
  }

  /** Opens a request; `answer` sends the harness the user's response, or a cancel. */
  ask(request: HarnessRequest, answer: (response: RequestResponse) => unknown): void {
    this.#answers.set(request.id, answer);
    this.emit({ type: "request.opened", request });
  }

  /**
   * Answers an open request and resolves it. One whose answer the harness did
   * not take stays open, to be answered again.
   */
  async answer(requestId: string, response: RequestResponse): Promise<void> {
    const answer = this.#answers.get(requestId);
    if (!answer) return;
    this.#answers.delete(requestId);
    try {
      await answer(response);
    } catch (error) {
      if (this.#requests.has(requestId)) this.#answers.set(requestId, answer);
      throw error;
    }
    this.withdraw(requestId);
  }

  /** Resolves a request the harness settled itself, without answering it. */
  withdraw(requestId: string): void {
    this.#answers.delete(requestId);
    if (this.#requests.has(requestId)) this.emit({ type: "request.resolved", requestId });
  }

  /** Answers every open request as cancelled, as for a turn or session that stops. */
  cancelAll(): void {
    for (const requestId of this.#answers.keys()) {
      this.answer(requestId, { kind: "cancel" }).catch((error: unknown) =>
        this.notice("warning", `Could not cancel a request: ${errorMessage(error)}`),
      );
    }
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
    this.#answers.clear();
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
