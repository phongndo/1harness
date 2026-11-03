import { errorMessage } from "../core/errors.ts";
import { randomUUID } from "node:crypto";
import type { Host } from "../host/host.ts";
import { RpcError, type HostEvent, type Method, type Params, type Result } from "../protocol.ts";

/** What a connection tells its client besides the host's events. */
export type ConnectionEvent =
  | HostEvent
  /** Events were missed, as after a long disconnect; the client says hello again. */
  | { type: "resync" }
  | { type: "connection"; state: "connected" | "reconnecting"; error: string | null };

/**
 * How a client reaches a host: requests, and the host's events from a point
 * on. A connection to a server reconnects by itself and picks up from the
 * last event it delivered.
 */
export interface HostConnection {
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  /**
   * Live events after `after`, the newest one the client has, from the host
   * run `instance` names; a host that is another run says to resync.
   */
  listen(after: number, listener: (event: ConnectionEvent) => void, instance?: string): () => void;
  close(): Promise<void>;
}

export function newClientId(): string {
  return randomUUID();
}

/**
 * A connection to a host in the same process. Requests and events are copied
 * as JSON would copy them, so a client here behaves as it does over a socket.
 */
export class LocalConnection implements HostConnection {
  #host: Host;
  #clientId: string;
  /** Shut the host down on close, since nothing else uses it. */
  #owns: boolean;

  constructor(host: Host, clientId: string, options: { owns: boolean }) {
    this.#host = host;
    this.#clientId = clientId;
    this.#owns = options.owns;
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    try {
      const result = await this.#host.call(this.#clientId, method, copy(params));
      return copy(result);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new Error(errorMessage(error), { cause: error });
    }
  }

  listen(after: number, listener: (event: ConnectionEvent) => void): () => void {
    const mine = (event: HostEvent) =>
      (event.type !== "ui" && event.type !== "ui.done") || event.clientId === this.#clientId;
    const backlog = this.#host.since(after);
    if (backlog === null) {
      queueMicrotask(() => listener({ type: "resync" }));
      return () => {};
    }
    for (const event of backlog) if (mine(event)) listener(copy(event));
    return this.#host.subscribe((event) => {
      if (mine(event)) listener(copy(event));
    });
  }

  async close(): Promise<void> {
    await this.#host.disconnect(this.#clientId);
    if (this.#owns) await this.#host.shutdown();
  }
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
