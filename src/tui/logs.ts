import type { HostClient } from "../client/client.ts";
import { errorMessage } from "../core/errors.ts";
import { appendDelta } from "../core/thread.ts";
import type { LogEntry, ThreadState } from "../protocol.ts";
import { agentRowOf } from "./agents.ts";
import type { RenderContext } from "./transcript.ts";
import { ThreadView, type ViewContext } from "./view.ts";

// Threads' views built from the host's logs of them, for threads the
// terminal did not see start: the newest page first, and earlier pages as
// the user scrolls up to them.

/** How many log entries a thread's view loads at a time. */
const PAGE_ENTRIES = 400;
/** The line over a view whose earlier turns are not loaded yet. */
const EARLIER_ABOVE = "Earlier turns are above; scroll up to load them.";

type Logged = { seq: number; entry: LogEntry };

/** What a thread's view shows of a log too long to load at once. */
interface Paged {
  /** Entries without streamed chunks, which their items hold. */
  entries: Logged[];
  /** Where each item's latest entry is in `entries`, for chunks to go into. */
  items: Map<string, number>;
  /** The first entry loaded, which the page before ends at. */
  oldest: number | null;
  more: boolean;
  children: Map<string, ThreadState>;
}

/**
 * Keeps an entry for building a view again: a streamed chunk goes into the
 * entry of the item it streams into, so the item's text stays whole.
 */
function keep(paged: Paged, logged: Logged): void {
  const given = logged.entry;
  if (given.type === "delta") {
    const at = paged.items.get(given.itemId);
    const kept = at === undefined ? undefined : paged.entries[at];
    if (kept?.entry.type === "item")
      kept.entry = { ...kept.entry, item: appendDelta(kept.entry.item, given.chunk) };
    return;
  }
  paged.entries.push(logged);
  if (given.type === "item") paged.items.set(given.item.id, paged.entries.length - 1);
}

/** What the logs need from the terminal around them. */
export interface LogHost {
  client: HostClient;
  /** Each thread's view, which a load fills in or builds again. */
  views: Map<string, ThreadView>;
  /** A new view for a thread whose log has loaded. */
  newView(id: string): ThreadView;
  /** A view built again with earlier turns takes the place of `old`. */
  replaced(old: ThreadView, view: ThreadView): void;
  renderContext(): RenderContext;
  notice(level: "error", text: string): void;
  schedule(): void;
}

export class ThreadLogs {
  #host: LogHost;
  /** Threads whose logs are loading, and the live entries that arrived meanwhile. */
  #loading = new Map<string, Logged[]>();
  /** Threads whose views show only the newest part of their logs. */
  #paged = new Map<string, Paged>();
  /** Loads of threads' logs in flight, which later callers wait for too. */
  #loads = new Map<string, Promise<void>>();
  /** Threads whose earlier turns are loading. */
  #earlierLoading = new Set<string>();
  /** Counts catch-ups with the host, so a load begun before one is dropped. */
  #generation = 0;

  constructor(host: LogHost) {
    this.#host = host;
  }

  /**
   * Builds the view of a thread the terminal did not see start, from the
   * host's log of it, then follows it live.
   */
  load(id: string): Promise<void> {
    const loading = this.#loads.get(id);
    if (loading) return loading;
    const load = this.#loadNow(id).finally(() => {
      if (this.#loads.get(id) === load) this.#loads.delete(id);
    });
    this.#loads.set(id, load);
    return load;
  }

  /**
   * Takes a live entry of a thread's log: held while the log loads, kept
   * for building a paged view again. Returns whether the view is to show it
   * now, which one still loading does once it has loaded.
   */
  live(threadId: string, logged: Logged): boolean {
    const loading = this.#loading.get(threadId);
    if (loading) {
      loading.push(logged);
      return false;
    }
    const paged = this.#paged.get(threadId);
    if (paged) keep(paged, logged);
    return true;
  }

  /** Forgets a thread gone from the host. */
  forget(id: string): void {
    this.#paged.delete(id);
  }

  /** The host caught the terminal up: every view is built again, and loads begun before are dropped. */
  resync(): void {
    this.#generation++;
    this.#loads.clear();
    this.#loading.clear();
    this.#paged.clear();
  }

  async #loadNow(id: string): Promise<void> {
    this.#loading.set(id, []);
    const generation = this.#generation;
    const { client, views } = this.#host;
    try {
      const page = await client.call("thread.attach", { threadId: id, limit: PAGE_ENTRIES });
      const children = new Map(page.children.map((child) => [child.id, child]));
      const live = (this.#loading.get(id) ?? []).filter((logged) => logged.seq > page.cursor);
      // A load from before a resync is out of date; the one the resync started stands.
      if (generation !== this.#generation) return;
      const paged: Paged = {
        entries: [...page.entries, ...live],
        items: new Map(),
        oldest: page.entries[0]?.seq ?? null,
        more: page.more,
        children,
      };
      const view = views.get(id) ?? this.#host.newView(id);
      if (paged.more) view.notice("info", EARLIER_ABOVE);
      const context = this.#replayContext(paged);
      for (const logged of paged.entries) view.apply(logged.entry, context);
      // Kept to build the view again with earlier pages; chunks go into their items.
      const entries = paged.entries;
      paged.entries = [];
      for (const logged of entries) keep(paged, logged);
      if (paged.more) this.#paged.set(id, paged);
      view.awaiting(client.threads.get(id)?.requests ?? []);
    } catch (error) {
      this.#host.notice("error", `Could not load ${id}: ${errorMessage(error)}`);
    } finally {
      // A resync since may have begun a load of its own, whose buffer this is not.
      if (generation === this.#generation) this.#loading.delete(id);
      this.#host.schedule();
    }
  }

  /**
   * Loads the page of a thread's log before what its view shows, and shows
   * the view again from there, keeping the rows on screen where they were.
   */
  async loadEarlier(id: string): Promise<void> {
    const paged = this.#paged.get(id);
    // Live entries go on into the view meanwhile, since the page goes above them.
    if (!paged?.more || paged.oldest === null || this.#loading.has(id) || this.#loads.has(id))
      return;
    if (this.#earlierLoading.has(id)) return;
    this.#earlierLoading.add(id);
    const generation = this.#generation;
    const { client, views } = this.#host;
    try {
      const page = await client.call("thread.attach", {
        threadId: id,
        limit: PAGE_ENTRIES,
        before: paged.oldest,
      });
      for (const child of page.children) paged.children.set(child.id, child);
      if (generation !== this.#generation) return;
      const shift = page.entries.length;
      paged.entries = [...page.entries, ...paged.entries];
      paged.items = new Map();
      paged.entries.forEach((logged, index) => {
        if (logged.entry.type === "item") paged.items.set(logged.entry.item.id, index);
      });
      paged.oldest = page.entries[0]?.seq ?? paged.oldest;
      paged.more = page.more;
      if (!paged.more) this.#paged.delete(id);
      const old = views.get(id);
      if (!old) return;
      // Built again as one log, so a turn across the pages' cut reads whole, with the
      // terminal's own lines back in their places.
      const view = new ThreadView(id);
      view.rebuild(
        old,
        paged.entries.map((logged) => logged.entry),
        shift,
        this.#replayContext(paged),
        paged.more ? EARLIER_ABOVE : null,
      );
      view.turn = old.turn;
      // Rows count from the bottom, so the same scroll shows the same rows; the rows
      // added above are not new output for the view to hold still against.
      view.scroll = old.scroll;
      view.total = view.transcript.view(this.#host.renderContext(), 0, 0).total;
      view.awaiting(client.threads.get(id)?.requests ?? []);
      views.set(id, view);
      this.#host.replaced(old, view);
    } catch (error) {
      this.#host.notice("error", `Could not load earlier turns: ${errorMessage(error)}`);
    } finally {
      this.#earlierLoading.delete(id);
      this.#host.schedule();
    }
  }

  /** How a view replays a log: as finished work, with the agents it knows of. */
  #replayContext(paged: Paged): ViewContext {
    return {
      busy: false,
      agent: (childId) => {
        const child = this.#host.client.threads.get(childId) ?? paged.children.get(childId);
        return child ? agentRowOf(child) : null;
      },
    };
  }
}
