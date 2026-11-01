import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  RpcError,
  type HostEvent,
  type Method,
  type Params,
  type Result,
  type ServerHello,
} from "../protocol.ts";
import { CLIENT_HEADER, REQUEST_HEADER } from "../server/http.ts";
import type { ConnectionEvent, HostConnection } from "./connection.ts";

/** Where a server listens: its Unix socket, or an address such as a tailnet one. */
export type ServerTarget = { socket: string } | { url: string; headers?: Record<string, string> };

const RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
/** How many times a request is tried while the server cannot be reached. */
const ATTEMPTS = 10;

function backoff(failures: number): number {
  return Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.max(0, failures - 1));
}

function describe(target: ServerTarget): string {
  return "socket" in target ? target.socket : target.url;
}

/** Whether a request failed for want of a server, so trying again may work. */
function unreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    (error instanceof Error && /socket hang up/.test(error.message))
  );
}

interface Call {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
  agent?: Agent;
  timeoutMs?: number;
}

/** Starts a request to the server. */
function open(target: ServerTarget, call: Call): ClientRequest {
  const headers = {
    ...("headers" in target ? target.headers : {}),
    ...call.headers,
    ...(call.body === undefined
      ? {}
      : {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(call.body)),
        }),
  };
  if ("socket" in target)
    return request({
      socketPath: target.socket,
      path: call.path,
      method: call.method,
      headers,
      ...(call.agent ? { agent: call.agent } : {}),
      ...(call.timeoutMs ? { timeout: call.timeoutMs } : {}),
    });
  const url = new URL(call.path, target.url);
  const make = url.protocol === "https:" ? httpsRequest : request;
  return make(url, {
    method: call.method,
    headers,
    ...(call.agent && url.protocol === "http:" ? { agent: call.agent } : {}),
    ...(call.timeoutMs ? { timeout: call.timeoutMs } : {}),
  });
}

/** One request, resolving with its status and body. */
function fetchText(target: ServerTarget, call: Call): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = open(target, call);
    outgoing.on("timeout", () =>
      outgoing.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    outgoing.on("error", reject);
    outgoing.on("response", (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
      response.on("error", reject);
    });
    outgoing.end(call.body);
  });
}

/** What a server says about itself, or a rejection when nothing answers. */
export async function serverHello(target: ServerTarget, timeoutMs = 2_000): Promise<ServerHello> {
  const { status, body } = await fetchText(target, {
    method: "GET",
    path: "/v1/hello",
    timeoutMs,
  });
  if (status === 403)
    throw new RpcError(
      "forbidden",
      (JSON.parse(body) as { error: { message: string } }).error.message,
    );
  if (status !== 200) throw new Error(`${describe(target)} answered ${status}`);
  const hello = JSON.parse(body) as ServerHello;
  if (hello.name !== "1harness") throw new Error(`${describe(target)} is not a 1harness server`);
  return hello;
}

/**
 * A connection to a 1harness server. Requests carry an ID, so one retried
 * after a dropped connection gets the first answer; the event stream
 * reconnects by itself, with backoff, and picks up after the last event it
 * delivered.
 */
export class SocketConnection implements HostConnection {
  #target: ServerTarget;
  #clientId: string;
  #agent = new Agent({ keepAlive: true });
  #count = 0;
  #closed = false;
  /** Starts the server again when nothing answers, as for the local one. */
  #revive: (() => Promise<unknown>) | null;
  #reviving: Promise<unknown> | null = null;

  constructor(
    target: ServerTarget,
    clientId: string,
    options: { revive?: () => Promise<unknown> } = {},
  ) {
    this.#target = target;
    this.#clientId = clientId;
    this.#revive = options.revive ?? null;
  }

  /** Nothing is listening: a server that can be started again is, once at a time. */
  #gone(error: unknown, failures: number): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!this.#revive || this.#reviving || failures < 2) return;
    if (code !== "ECONNREFUSED" && code !== "ENOENT") return;
    this.#reviving = this.#revive()
      .catch(() => {})
      .finally(() => {
        this.#reviving = null;
      });
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const requestId = `${this.#clientId}:${++this.#count}`;
    const body = JSON.stringify({ method, params });
    for (let attempt = 1; ; attempt++) {
      let answer: { status: number; body: string };
      try {
        answer = await fetchText(this.#target, {
          method: "POST",
          path: "/v1/rpc",
          headers: { [CLIENT_HEADER]: this.#clientId, [REQUEST_HEADER]: requestId },
          body,
          agent: this.#agent,
        });
      } catch (error) {
        if (this.#closed || attempt >= ATTEMPTS || !unreachable(error)) throw error;
        this.#gone(error, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
        continue;
      }
      const parsed = JSON.parse(answer.body || "{}") as {
        result?: Result<M>;
        error?: { code: string; message: string };
      };
      if (parsed.error) throw new RpcError(parsed.error.code, parsed.error.message);
      if (answer.status !== 200) throw new Error(`The server answered ${answer.status}`);
      return parsed.result as Result<M>;
    }
  }

  listen(after: number, listener: (event: ConnectionEvent) => void): () => void {
    let cursor = after;
    let stopped = false;
    let failures = 0;
    let current: ClientRequest | null = null;
    let timer: NodeJS.Timeout | null = null;
    const retry = (error: string, cause?: unknown) => {
      if (stopped || this.#closed) return;
      current = null;
      failures++;
      this.#gone(cause, failures);
      if (failures === 1) listener({ type: "connection", state: "reconnecting", error });
      timer = setTimeout(connect, backoff(failures));
    };
    const connect = () => {
      timer = null;
      if (stopped || this.#closed) return;
      const outgoing = open(this.#target, {
        method: "GET",
        path: `/v1/events?after=${cursor}`,
        headers: { [CLIENT_HEADER]: this.#clientId },
      });
      current = outgoing;
      outgoing.on("error", (error) => retry(error.message, error));
      outgoing.on("response", (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          retry(`the server answered ${response.statusCode}`);
          return;
        }
        if (failures > 0) listener({ type: "connection", state: "connected", error: null });
        failures = 0;
        let buffered = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffered += chunk;
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
            // Blank lines keep the stream open.
            if (line === "" || stopped) continue;
            const event = JSON.parse(line) as HostEvent | { type: "resync" };
            if (event.type === "resync") {
              stopped = true;
              listener({ type: "resync" });
              continue;
            }
            cursor = event.seq;
            listener(event);
          }
        });
        response.on("close", () => retry("the server closed the stream"));
      });
      outgoing.end();
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.destroy();
    };
  }

  /** Leaves: the server lets go of this client at once, and its threads keep working. */
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await fetchText(this.#target, {
        method: "POST",
        path: "/v1/rpc",
        headers: { [CLIENT_HEADER]: this.#clientId },
        body: JSON.stringify({ method: "client.bye", params: {} }),
        timeoutMs: 2_000,
      });
    } catch {
      // A server that is gone has let go already.
    }
    this.#closed = true;
    this.#agent.destroy();
  }
}
