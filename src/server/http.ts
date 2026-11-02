import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Host } from "../host/host.ts";
import {
  PROTOCOL_VERSION,
  RpcError,
  type HostEvent,
  type Method,
  type ServerHello,
} from "../protocol.ts";

/** The header a client names itself with on every request. */
export const CLIENT_HEADER = "x-1harness-client";
/** The header that carries a request's own ID, so a retry gets the first answer. */
export const REQUEST_HEADER = "x-1harness-request";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** An event stream sends a blank line this often, so idle connections stay open. */
const KEEPALIVE_MS = 15_000;
/** More than this waiting for a client to read means it is too slow; it reconnects and catches up. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** How long a client may be gone before it counts as having left, its picks dismissed. */
const LEAVE_GRACE_MS = 10_000;
/** How many answers to remember per client, for requests retried after a dropped connection. */
const REMEMBERED = 100;
/** How much of those answers to keep per client; pictures and pages would hold megabytes each. */
const REMEMBERED_BYTES = 1024 * 1024;
/**
 * Methods that change nothing, so a retry can run them again: their answers,
 * often the largest, such as images and transcripts, are not remembered.
 */
const READS: ReadonlySet<string> = new Set<Method>([
  "client.hello",
  "threads.list",
  "threads.search",
  "thread.attach",
  "harnesses.list",
  "commands.list",
  "commands.complete",
  "files.search",
  "files.image",
  "media.html",
  "page.frame",
]);

/** Who a listener says a caller is, or a reason to turn it away. */
export type Authorizer = (
  request: IncomingMessage,
) => Promise<{ identity: string | null } | { refused: string }>;

export interface ServerOptions {
  version: string;
  autostarted: boolean;
  /** Called on every request and stream change, so idle exit can tell. */
  onActivity?: () => void;
  /** How long a client may be gone before it counts as having left. */
  leaveGraceMs?: number;
}

interface Answer {
  status: number;
  body: string;
}

/** A client's remembered answers by request ID, and how large they are together. */
interface Remembered {
  answers: Map<string, Promise<Answer>>;
  sizes: Map<string, number>;
  bytes: number;
}

/**
 * The host over HTTP/1.1, on whatever listeners it is given: `GET /v1/hello`,
 * `POST /v1/rpc`, and `GET /v1/events?after=<seq>`, a stream of the host's
 * events as lines of JSON. Remote access is another listener with an
 * authorizer, not another protocol.
 */
export class HostServer {
  #host: Host;
  #options: ServerOptions;
  #servers: Server[] = [];
  /** Open event streams, by client. */
  #streams = new Map<string, Set<ServerResponse>>();
  /** Clients whose streams closed, and the timer that counts them gone. */
  #leaving = new Map<string, NodeJS.Timeout>();
  /** Clients counted as gone, which say hello again if they come back. */
  #departed = new Set<string>();
  /** Answers by client and request ID. */
  #answers = new Map<string, Remembered>();
  #startedAt = Date.now();

  constructor(host: Host, options: ServerOptions) {
    this.#host = host;
    this.#options = options;
  }

  /** How many clients have an event stream open. */
  get streaming(): number {
    return this.#streams.size;
  }

  /**
   * Listens on a Unix socket path, an inherited file descriptor, or a TCP
   * port; `authorize` decides who may call on that listener.
   */
  async listen(
    target: { path: string } | { fd: number } | { port: number; host: string },
    authorize: Authorizer = async () => ({ identity: null }),
  ): Promise<AddressInfo | string | null> {
    const server = createServer((request, response) => {
      void this.#handle(request, response, authorize).catch((error: unknown) => {
        if (!response.headersSent) send(response, 500, { error: errorBody(error) });
        else response.destroy();
      });
    });
    // Event streams stay open as long as the client wants them.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if ("path" in target) server.listen(target.path, resolve);
      else if ("fd" in target) server.listen({ fd: target.fd }, resolve);
      else server.listen(target.port, target.host, resolve);
    });
    this.#servers.push(server);
    return server.address();
  }

  async close(): Promise<void> {
    for (const streams of this.#streams.values()) for (const stream of streams) stream.end();
    this.#streams.clear();
    for (const timer of this.#leaving.values()) clearTimeout(timer);
    this.#leaving.clear();
    await Promise.all(
      this.#servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    this.#servers = [];
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    authorize: Authorizer,
  ): Promise<void> {
    this.#options.onActivity?.();
    const decision = await authorize(request);
    if ("refused" in decision) {
      send(response, 403, { error: { code: "forbidden", message: decision.refused } });
      return;
    }
    const url = new URL(request.url ?? "/", "http://1harness");
    if (request.method === "GET" && url.pathname === "/v1/hello") {
      const hello: ServerHello = {
        name: "1harness",
        version: this.#options.version,
        protocol: PROTOCOL_VERSION,
        minProtocol: 1,
        pid: process.pid,
        startedAt: this.#startedAt,
        instance: this.#host.instance,
        autostarted: this.#options.autostarted,
        store: this.#host.storePath,
        identity: decision.identity,
      };
      send(response, 200, hello);
      return;
    }
    const client = header(request, CLIENT_HEADER);
    if (!client || client.length > 128) {
      send(response, 400, {
        error: { code: "invalid_request", message: `${CLIENT_HEADER} names the client` },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/rpc") {
      await this.#rpc(client, request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const instance = url.searchParams.get("instance");
      // Events from another run of the host, or a client counted as gone, start over.
      const stale =
        (instance !== null && instance !== this.#host.instance) || this.#departed.delete(client);
      this.#events(client, stale ? null : Number(url.searchParams.get("after") ?? "0"), response);
      return;
    }
    send(response, 404, { error: { code: "not_found", message: `No ${url.pathname}` } });
  }

  async #rpc(client: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: { method?: unknown; params?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch (error) {
      send(response, 400, {
        error: { code: "invalid_request", message: errorBody(error).message },
      });
      return;
    }
    const method = String(body.method);
    const requestId = READS.has(method) ? null : header(request, REQUEST_HEADER);
    const remembered = requestId ? this.#remembered(client) : null;
    let answer = requestId ? remembered?.answers.get(requestId) : undefined;
    if (!answer) {
      answer = this.#answer(client, method, body.params ?? {});
      if (requestId && remembered) this.#remember(remembered, requestId, answer);
    }
    const { status, body: text } = await answer;
    response.writeHead(status, { "Content-Type": "application/json" }).end(text);
  }

  #remembered(client: string): Remembered {
    let remembered = this.#answers.get(client);
    if (!remembered) {
      remembered = { answers: new Map(), sizes: new Map(), bytes: 0 };
      this.#answers.set(client, remembered);
    }
    return remembered;
  }

  /** Keeps an answer for a retry, letting the oldest go past the count or the size. */
  #remember(remembered: Remembered, requestId: string, answer: Promise<Answer>): void {
    const { answers, sizes } = remembered;
    answers.set(requestId, answer);
    void answer.then(({ body }) => {
      if (answers.get(requestId) !== answer) return;
      sizes.set(requestId, body.length);
      remembered.bytes += body.length;
      evict();
    });
    const evict = () => {
      while (
        answers.size > REMEMBERED ||
        (remembered.bytes > REMEMBERED_BYTES && answers.size > 1)
      ) {
        const oldest = answers.keys().next().value!;
        answers.delete(oldest);
        remembered.bytes -= sizes.get(oldest) ?? 0;
        sizes.delete(oldest);
      }
    };
    evict();
  }

  async #answer(client: string, method: string, params: unknown): Promise<Answer> {
    try {
      // The client says which method; the host refuses ones it has not.
      const result = await this.#host.call(client, method as Method, params as never);
      if (method === "client.hello") this.#arrived(client);
      if (method === "client.bye") this.#forget(client);
      return { status: 200, body: JSON.stringify({ result: result ?? null }) };
    } catch (error) {
      return {
        status: error instanceof RpcError && error.code === "unknown_method" ? 404 : 400,
        body: JSON.stringify({ error: errorBody(error) }),
      };
    }
  }

  /** A stream of events after `after`; null tells the client to say hello again. */
  #events(client: string, after: number | null, response: ServerResponse): void {
    const backlog = after === null ? null : this.#host.since(Number.isFinite(after) ? after : 0);
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    });
    response.flushHeaders();
    if (backlog === null) {
      // Too far behind to catch up from the kept events: the client says hello again.
      response.end(`${JSON.stringify({ type: "resync" })}\n`);
      return;
    }
    this.#arrived(client);
    const streams = this.#streams.get(client) ?? new Set<ServerResponse>();
    streams.add(response);
    this.#streams.set(client, streams);
    const mine = (event: HostEvent) =>
      (event.type !== "ui" && event.type !== "ui.done") || event.clientId === client;
    const write = (event: HostEvent) => {
      if (!mine(event) || response.destroyed) return;
      // A client this far behind would hold the host up; it reconnects and catches up.
      if (response.writableLength > MAX_BUFFERED_BYTES) {
        response.destroy();
        return;
      }
      response.write(`${JSON.stringify(event)}\n`);
    };
    for (const event of backlog) write(event);
    const unsubscribe = this.#host.subscribe(write);
    const keepalive = setInterval(() => response.write("\n"), KEEPALIVE_MS);
    response.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      streams.delete(response);
      if (streams.size === 0 && this.#streams.get(client) === streams) {
        this.#streams.delete(client);
        this.#left(client);
      }
      this.#options.onActivity?.();
    });
  }

  /** A client is here: it is no longer counted as leaving. */
  #arrived(client: string): void {
    const timer = this.#leaving.get(client);
    if (timer) clearTimeout(timer);
    this.#leaving.delete(client);
  }

  /** A client's streams closed; unless it comes back soon, it has left. */
  #left(client: string): void {
    if (this.#leaving.has(client)) return;
    const timer = setTimeout(() => {
      this.#leaving.delete(client);
      if (this.#streams.has(client)) return;
      this.#forget(client);
      this.#departed.add(client);
      // It may be back: the thread it showed stays, though nothing is in it.
      void this.#host.disconnect(client, { discard: false });
      this.#options.onActivity?.();
    }, this.#options.leaveGraceMs ?? LEAVE_GRACE_MS);
    timer.unref();
    this.#leaving.set(client, timer);
  }

  #forget(client: string): void {
    this.#answers.delete(client);
  }
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function errorBody(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof RpcError ? error.code : "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
