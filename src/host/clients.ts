import type { CommandUI } from "../commands/registry.ts";
import type { NoticeLevel } from "../core/events.ts";
import type { Method, Params, Result, UiRequest } from "../protocol.ts";
import type { EventFeed, Unnumbered } from "./feed.ts";

type UiAsk =
  Unnumbered<UiRequest> extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** One client, such as a terminal, and what the host keeps for it. */
export interface Client {
  id: string;
  cwd: string;
  /** The thread it shows, whose extensions' UI it gets. */
  showing: string | null;
  /**
   * The empty thread it left for one still starting, dropped once that one
   * starts, and kept to go back to should it fail.
   */
  left: string | null;
  connected: boolean;
  /** Picks waiting for its answer. */
  picks: Map<string, (index: number | null) => void>;
  /** Picks it has not answered, sent again when it says hello. */
  pending: Map<string, UiRequest>;
  /** Lists commands keep, by thread and key. */
  lookups: Map<string, unknown[] | Promise<unknown[]>>;
  /** Message IDs by the client's request IDs, so a retried send sends nothing. */
  sent: Map<string, string>;
  /** Extension modules it named, which load for the threads it opens. */
  extensions: string[];
  /** It calls from another machine, so the modules it names are not loaded here. */
  remote: boolean;
  /** It is an agent 1harness does not run, held to what settings let such agents do. */
  agent: boolean;
}

/** How the host answers each request a client makes. */
export type Handlers = {
  [M in Method]: (client: Client, params: Params<M>) => Promise<Result<M>>;
};

/** The clients the host knows of, and the UI it sends them. */
export class Clients {
  #feed: EventFeed;
  #defaults: { cwd: string; extensions: readonly string[] };
  #clients = new Map<string, Client>();
  #asked = 0;

  /** A client starts in `cwd` with `extensions` until it says otherwise in its hello. */
  constructor(feed: EventFeed, defaults: { cwd: string; extensions: readonly string[] }) {
    this.#feed = feed;
    this.#defaults = defaults;
  }

  /** A client, known from its first request on. */
  get(id: string): Client {
    let client = this.#clients.get(id);
    if (!client) {
      client = {
        id,
        cwd: this.#defaults.cwd,
        showing: null,
        left: null,
        // Not until it says hello: a request alone is no one staying.
        connected: false,
        picks: new Map(),
        pending: new Map(),
        lookups: new Map(),
        sent: new Map(),
        extensions: [...this.#defaults.extensions],
        remote: false,
        agent: false,
      };
      this.#clients.set(id, client);
    }
    return client;
  }

  /** A client that has made a request, without counting one that has not. */
  find(id: string): Client | undefined {
    return this.#clients.get(id);
  }

  all(): Client[] {
    return [...this.#clients.values()];
  }

  /** The clients that said hello and have not left. */
  connected(): Client[] {
    return this.all().filter((client) => client.connected);
  }

  /** A connected client other than `except` that shows the thread. */
  showing(threadId: string, except?: Client): Client | undefined {
    return this.connected().find((client) => client !== except && client.showing === threadId);
  }

  /** A client left: its picks resolve as dismissed, and none are sent again. */
  leave(client: Client): void {
    client.connected = false;
    for (const resolve of client.picks.values()) resolve(null);
    client.picks.clear();
    client.pending.clear();
  }

  forget(id: string): void {
    this.#clients.delete(id);
  }

  /** Sends a client something to show or ask; returns the request's ID. */
  ask(client: Client, ask: UiAsk): string {
    const request = { ...ask, id: `ui-${++this.#asked}` } as UiRequest;
    if (request.method === "pick") client.pending.set(request.id, request);
    this.#feed.emit({ type: "ui", clientId: client.id, request });
    return request.id;
  }

  /** A client's answer to what it was asked, which every client of it hears was answered. */
  reply(client: Client, id: string, result: number | null): void {
    const resolve = client.picks.get(id);
    client.picks.delete(id);
    client.pending.delete(id);
    resolve?.(result);
    this.#feed.emit({ type: "ui.done", clientId: client.id, id });
  }

  /** The UI that commands and extensions' handlers get for one client. */
  ui(client: Client): CommandUI {
    return {
      notify: (level, text) => void this.ask(client, { method: "notify", level, text }),
      report: (report) => void this.ask(client, { method: "report", report }),
      panel: (title, rows) => void this.ask(client, { method: "panel", title, rows }),
      pick: (title, entries, options) =>
        new Promise((resolve) => {
          if (!client.connected) {
            resolve(null);
            return;
          }
          const id = this.ask(client, {
            method: "pick",
            title,
            entries,
            initial: options?.initial ?? 0,
            filter: options?.filter ?? false,
            tabs: options?.tabs ?? false,
          });
          client.picks.set(id, resolve);
        }),
      progress: (text) => {
        const id = this.ask(client, { method: "progress", text });
        return (level, outcome) =>
          void this.ask(client, { method: "settle", progress: id, level, text: outcome });
      },
      setInput: (text) => void this.ask(client, { method: "setInput", text }),
      setStatus: (key, text) => void this.ask(client, { method: "status", key, text }),
    };
  }

  /** Something every client shows, such as an extension that failed. */
  broadcast(level: NoticeLevel, text: string): void {
    this.#feed.emit({ type: "notice", level, text });
  }

  /** The UI for no client in particular: what it says, every client shows, and it asks nothing. */
  everyone(): CommandUI {
    return {
      notify: (level, text) => this.broadcast(level, text),
      report: (report) => this.broadcast("info", report.title),
      panel: (title) => this.broadcast("info", title),
      pick: async () => null,
      progress: (text) => {
        this.broadcast("info", text);
        return (level, outcome) => this.broadcast(level, outcome);
      },
      setInput: () => {},
    };
  }
}
