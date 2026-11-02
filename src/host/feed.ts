import type { HostEvent } from "../protocol.ts";

/** How many recent events the host keeps for clients catching up after a gap. */
const RECENT_EVENTS = 20_000;
/** How much of them, as sent: one event can carry a whole item or page. */
const RECENT_BYTES = 32 * 1024 * 1024;

export type Unnumbered<E> = E extends unknown ? Omit<E, "seq"> : never;

/**
 * The host's events, numbered in order, with the recent ones kept so a client
 * that missed some can catch up instead of starting over.
 */
export class EventFeed {
  #listeners = new Set<(event: HostEvent) => void>();
  #recent: HostEvent[] = [];
  /** The size of each recent event, as sent, and of all of them. */
  #recentSizes: number[] = [];
  #recentBytes = 0;
  #seq: number;

  /** A feed whose first event follows `seq`, as one a store kept. */
  constructor(seq = 0) {
    this.#seq = seq;
  }

  /** The newest event's number. */
  get seq(): number {
    return this.#seq;
  }

  /** The number the next event gets, which a log entry made for it carries too. */
  get next(): number {
    return this.#seq + 1;
  }

  emit(event: Unnumbered<HostEvent>): void {
    const numbered = { ...event, seq: ++this.#seq } as HostEvent;
    const size = JSON.stringify(numbered).length;
    this.#recent.push(numbered);
    this.#recentSizes.push(size);
    this.#recentBytes += size;
    let drop = 0;
    while (
      this.#recent.length - drop > RECENT_EVENTS ||
      (this.#recentBytes > RECENT_BYTES && this.#recent.length - drop > 1)
    )
      this.#recentBytes -= this.#recentSizes[drop++]!;
    if (drop > 0) {
      this.#recent.splice(0, drop);
      this.#recentSizes.splice(0, drop);
    }
    for (const listener of this.#listeners) listener(numbered);
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The events after `after`, or null when some are no longer kept, or the
   * client has events this feed never sent, as after a crash lost the last
   * ones: it starts over from a snapshot.
   */
  since(after: number): HostEvent[] | null {
    if (after === this.#seq) return [];
    if (after > this.#seq) return null;
    const first = this.#recent[0];
    if (!first || first.seq > after + 1) return null;
    return this.#recent.filter((event) => event.seq > after);
  }
}
