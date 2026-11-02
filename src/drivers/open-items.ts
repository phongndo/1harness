import type { HarnessEvent, Item } from "../core/events.ts";
import { appendDelta } from "../core/thread.ts";

/**
 * The items a session has started and not completed, as it has sent them, so
 * a session whose process dies can end them rather than leave them spinning.
 */
export class OpenItems {
  #items = new Map<string, Item>();

  track(event: HarnessEvent): void {
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
    }
  }

  /** Completes every open item; work still running failed, since it never finished. */
  settle(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const item of this.#items.values()) {
      const settled =
        "status" in item && item.status === "running"
          ? { ...item, status: "failed" as const }
          : item;
      events.push({ type: "item.completed", item: settled });
    }
    this.#items.clear();
    return events;
  }
}
