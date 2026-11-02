import type { HarnessRequest, Item, RequestResponse } from "../core/events.ts";
import { appendDelta, type Message, type ThreadEvent } from "../core/thread.ts";
import type { LogEntry, LoggedEntry, TurnTokens } from "../protocol.ts";

/** How much of a reasoning item the log keeps: enough for its latest heading. */
const REASONING_CHARS = 2_000;

/** Rough tokens for text, as fx estimates its live counters. */
export function estimateTokens(text: string): number {
  return text.length / 4;
}

/** An item as the log keeps it: reasoning cut to its tail, which holds its heading. */
function kept(item: Item): Item {
  if (item.kind !== "reasoning" || item.text.length <= REASONING_CHARS) return item;
  return { ...item, text: item.text.slice(-REASONING_CHARS) };
}

/**
 * One thread's transcript as a log: what a client replays to show it. An item
 * is one entry, kept in place as it changes, at the point it first appeared,
 * which is where the transcript shows it; streamed text goes into that entry.
 * Todo lists keep one ID across turns but show once per turn, so a turn's end
 * closes them, and the next turn's list is an entry of its own.
 */
export class ThreadLog {
  readonly #entries: LoggedEntry[] = [];
  /** Item entries that later events change in place, by item ID. */
  #open = new Map<string, LoggedEntry>();
  #turn: TurnTokens | null = null;
  /** Entries changed since `flush`, for a store to write. */
  #dirty = new Set<LoggedEntry>();

  constructor(entries: readonly LoggedEntry[] = []) {
    for (const entry of entries) {
      this.#entries.push(entry);
      if (entry.entry.type === "item") this.#open.set(entry.entry.item.id, entry);
      if (entry.entry.type === "turn.ended") this.#closeTurn();
    }
  }

  get entries(): readonly LoggedEntry[] {
    return this.#entries;
  }

  /** The newest entries before `before`, up to `limit`, and whether earlier ones exist. */
  page(before: number | undefined, limit: number): { entries: LoggedEntry[]; more: boolean } {
    const end =
      before === undefined
        ? this.#entries.length
        : this.#entries.findIndex((entry) => entry.seq >= before);
    const stop = end === -1 ? this.#entries.length : end;
    const start = Math.max(0, stop - limit);
    return { entries: this.#entries.slice(start, stop), more: start > 0 };
  }

  /**
   * Records an event at `seq`, and returns the entry clients are sent live:
   * null for events that change only the thread's state, such as usage.
   * `message` finds the message a `user_message` echoes.
   */
  apply(
    event: ThreadEvent,
    seq: number,
    message: (id: string) => Message | undefined,
  ): LogEntry | null {
    switch (event.type) {
      case "turn.started":
        this.#turn = { up: 0, down: 0 };
        return this.#add(seq, { type: "turn.started", turnId: event.turnId, at: Date.now() });
      case "turn.ended": {
        const tokens = this.#turn ?? { up: 0, down: 0 };
        this.#turn = null;
        this.#closeTurn();
        return this.#add(seq, {
          type: "turn.ended",
          turnId: event.turnId,
          status: event.status,
          error: event.error,
          at: Date.now(),
          up: Math.ceil(tokens.up),
          down: Math.ceil(tokens.down),
        });
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = event.item;
        const sent =
          item.kind === "user_message" && item.inputId ? message(item.inputId) : undefined;
        return this.item(seq, item, event.type === "item.completed", sent);
      }
      case "item.delta": {
        const open = this.#open.get(event.itemId);
        if (this.#turn) this.#turn.down += estimateTokens(event.chunk);
        if (open?.entry.type === "item") {
          open.entry = { ...open.entry, item: kept(appendDelta(open.entry.item, event.chunk)) };
          this.#dirty.add(open);
        }
        return { type: "delta", itemId: event.itemId, chunk: event.chunk };
      }
      case "error":
        return this.item(
          seq,
          { kind: "notice", id: `error-${seq}`, level: "error", text: event.message },
          true,
        );
      case "session.closed":
        return this.#add(seq, { type: "session.ended", error: event.error });
      default:
        return null;
    }
  }

  /** Records an item, such as a notice of the host's own; one with an open ID changes in place. */
  item(seq: number, item: Item, done: boolean, message?: Message): LogEntry {
    const open = this.#open.get(item.id);
    const previous = open?.entry.type === "item" ? open.entry.item : undefined;
    if (this.#turn) {
      if (item.kind === "user_message" && !previous) this.#turn.up += estimateTokens(item.text);
      if (item.kind === "assistant_message") {
        const before = previous?.kind === "assistant_message" ? previous.text.length : 0;
        if (item.text.length > before) this.#turn.down += estimateTokens(item.text.slice(before));
      }
    }
    const entry: LogEntry = {
      type: "item",
      item: kept(item),
      done,
      ...(message ? { message } : {}),
    };
    if (open) {
      // A message the harness echoes again keeps what it was matched to.
      if (!message && open.entry.type === "item" && open.entry.message)
        entry.message = open.entry.message;
      open.entry = entry;
      this.#dirty.add(open);
      return entry;
    }
    const logged = this.#add(seq, entry);
    this.#open.set(item.id, this.#entries.at(-1)!);
    return logged;
  }

  /** Records a thread this one started. */
  agent(seq: number, threadId: string): LogEntry {
    return this.#add(seq, { type: "agent", threadId });
  }

  /** Records how the user answered a request. */
  decision(seq: number, entry: Extract<LogEntry, { type: "decision" }>): LogEntry {
    return this.#add(seq, entry);
  }

  /** Records a page the agent showed the user. */
  html(seq: number, title: string, html: string, at: number): LogEntry {
    return this.#add(seq, { type: "html", title, html, at });
  }

  /** Entries added or changed since they were last written. */
  unwritten(): LoggedEntry[] {
    return [...this.#dirty];
  }

  /** Marks entries written, once the store has committed them. */
  written(entries: readonly LoggedEntry[]): void {
    for (const entry of entries) this.#dirty.delete(entry);
  }

  #add(seq: number, entry: LogEntry): LogEntry {
    const logged = { seq, entry };
    this.#entries.push(logged);
    this.#dirty.add(logged);
    return entry;
  }

  #closeTurn(): void {
    for (const [id, open] of this.#open)
      if (open.entry.type === "item" && open.entry.item.kind === "todo_list") this.#open.delete(id);
  }
}

type Decision = Extract<LogEntry, { type: "decision" }>;

/**
 * How a response answers a request, as the transcript records it: the choice
 * made on an approval, or each question's answer. Secret answers stay out.
 */
export function decisions(
  request: HarnessRequest,
  response: RequestResponse,
  at = Date.now(),
): Decision[] {
  if (request.kind === "approval") {
    const base = { type: "decision", kind: "approval", title: request.title, at } as const;
    switch (response.kind) {
      case "approval": {
        const option = request.options.find((candidate) => candidate.id === response.optionId);
        const effect = option?.effect ?? "other";
        const outcome =
          effect === "deny" ? "declined" : effect === "other" ? "answered" : "allowed";
        return [{ ...base, answer: option?.label ?? response.optionId, outcome }];
      }
      case "decline":
        return [{ ...base, answer: response.reason, outcome: "declined" }];
      case "cancel":
        return [{ ...base, answer: "", outcome: "dismissed" }];
      case "question":
        return [];
    }
  }
  const base = { type: "decision", kind: "question", at } as const;
  if (response.kind !== "question") {
    const [first] = request.questions;
    return [{ ...base, title: first?.question ?? "Question", answer: "", outcome: "dismissed" }];
  }
  return request.questions.map((question) => ({
    ...base,
    title: question.question,
    answer: question.secret ? "(hidden)" : (response.answers[question.id] ?? []).join(", "),
    outcome: "answered",
  }));
}
