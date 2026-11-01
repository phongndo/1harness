import type {
  HarnessInfo,
  HelloParams,
  HelloResult,
  HostEvent,
  Method,
  Params,
  Result,
  ThreadState,
} from "../protocol.ts";
import { newClientId, type ConnectionEvent, type HostConnection } from "./connection.ts";

/** What a client hears: the host's events, applied to its copy of the threads first. */
export type ClientEvent =
  | HostEvent
  /** The client caught up again after missing events; its threads were replaced. */
  | { type: "resync"; hello: HelloResult }
  | { type: "connection"; state: "connected" | "reconnecting"; error: string | null };

/**
 * A client's side of the host: every thread's state, kept current from the
 * feed, and requests. Terminals and watchers build on it.
 */
export class HostClient {
  readonly id: string;
  readonly threads = new Map<string, ThreadState>();
  harnesses: HarnessInfo[] = [];
  #connection: HostConnection;
  #hello: Omit<HelloParams, "clientId">;
  #seq = 0;
  #listeners = new Set<(event: ClientEvent) => void>();
  #unlisten: (() => void) | null = null;
  #closed = false;

  constructor(
    connection: HostConnection,
    hello: Omit<HelloParams, "clientId">,
    id: string = newClientId(),
  ) {
    this.#connection = connection;
    this.#hello = hello;
    this.id = id;
  }

  /** Says hello, takes the snapshot, and follows the feed from there. */
  async connect(): Promise<HelloResult> {
    const hello = await this.#connection.call("client.hello", {
      ...this.#hello,
      clientId: this.id,
    });
    this.#take(hello);
    this.#unlisten = this.#connection.listen(hello.seq, (event) => this.#event(event));
    return hello;
  }

  on(listener: (event: ClientEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.#connection.call(method, params);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unlisten?.();
    await this.#connection.close();
  }

  #take(hello: HelloResult): void {
    this.#seq = hello.seq;
    this.threads.clear();
    for (const thread of hello.threads) this.threads.set(thread.id, thread);
    this.harnesses = hello.harnesses;
  }

  #event(event: ConnectionEvent): void {
    if (event.type === "resync") {
      void this.#resync();
      return;
    }
    if (event.type === "connection") {
      this.#tell(event);
      return;
    }
    // A reconnect may deliver events again.
    if (event.seq <= this.#seq) return;
    this.#seq = event.seq;
    switch (event.type) {
      case "thread":
        this.threads.set(event.thread.id, event.thread);
        break;
      case "removed":
        this.threads.delete(event.threadId);
        break;
      case "harnesses":
        this.harnesses = event.harnesses;
        break;
      default:
        break;
    }
    this.#tell(event);
  }

  async #resync(): Promise<void> {
    this.#unlisten?.();
    this.#unlisten = null;
    if (this.#closed) return;
    try {
      const hello = await this.#connection.call("client.hello", {
        ...this.#hello,
        clientId: this.id,
      });
      this.#take(hello);
      this.#unlisten = this.#connection.listen(hello.seq, (event) => this.#event(event));
      this.#tell({ type: "resync", hello });
    } catch (error) {
      this.#tell({
        type: "connection",
        state: "reconnecting",
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => void this.#resync(), 1000).unref();
    }
  }

  #tell(event: ClientEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
