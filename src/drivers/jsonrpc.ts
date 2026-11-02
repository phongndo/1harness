import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RequestId = number | string;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;
type ErrorHandler = (error: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const STDERR_TAIL_BYTES = 16_384;

export interface JsonRpcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** What to call the process in errors, such as `codex app-server`. */
  name: string;
  /** Send the `jsonrpc: "2.0"` member, which ACP requires and Codex leaves out. */
  jsonrpc?: boolean;
}

/**
 * One end of newline-delimited JSON-RPC 2.0 over a pair of streams: requests
 * and notifications both ways, as ACP and MCP over stdio need.
 */
export class JsonRpcPeer {
  #write: (line: string) => void;
  #nextId = 1;
  #pending = new Map<RequestId, Pending>();
  #onNotification: NotificationHandler = () => {};
  #onRequest: RequestHandler = () => Promise.reject(new RpcError(-32601, "Method not found"));
  #onError: ErrorHandler = () => {};
  /** Why the other end went away; a request sent after that fails at once. */
  #closedError: Error | null = null;
  #name: string;
  #jsonrpc: boolean;

  /** `write` sends one line; `jsonrpc` sends the `jsonrpc: "2.0"` member, which Codex leaves out. */
  constructor(
    input: NodeJS.ReadableStream,
    write: (line: string) => void,
    options: { name: string; jsonrpc: boolean },
  ) {
    this.#write = write;
    this.#name = options.name;
    this.#jsonrpc = options.jsonrpc;
    createInterface({ input }).on("line", (line) => this.#receive(line));
  }

  onNotification(handler: NotificationHandler): void {
    this.#onNotification = handler;
  }

  onRequest(handler: RequestHandler): void {
    this.#onRequest = handler;
  }

  /** Hears what a handler threw, which would otherwise crash the whole process. */
  onError(handler: ErrorHandler): void {
    this.#onError = handler;
  }

  /** Sends a request; with `timeoutMs`, rejects if no reply arrives in time. */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!this.#pending.delete(id)) return;
              reject(
                new Error(`${this.#name} did not answer ${method} within ${timeoutMs / 1000}s`),
              );
            }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  /** The other end went away: pending requests fail with `error`, and later ones at once. */
  closed(error: Error): void {
    this.#closedError ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send(message: object): void {
    if (this.#closedError) return;
    const framed = this.#jsonrpc ? { jsonrpc: "2.0", ...message } : message;
    this.#write(`${JSON.stringify(framed)}\n`);
  }

  #receive(line: string): void {
    if (line.trim() === "") return;
    let message: {
      id?: RequestId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const id = message.id;
      let answer: Promise<unknown>;
      try {
        answer = this.#onRequest(message.method, message.params, id);
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (result) => this.#send({ id, result }),
        (error: unknown) => {
          if (!(error instanceof RpcError)) this.#onError(error);
          const rpc = error instanceof RpcError ? error : new RpcError(-32603, String(error));
          this.#send({ id, error: { code: rpc.code, message: rpc.message } });
        },
      );
    } else if (message.method !== undefined) {
      try {
        this.#onNotification(message.method, message.params);
      } catch (error) {
        this.#onError(error);
      }
    } else if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
      else pending.resolve(message.result);
    }
  }
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio, as Codex's
 * app-server and ACP agents speak it. stdout is read continuously so the
 * child never blocks on a full pipe.
 */
export class JsonRpcProcess {
  #child: ChildProcessWithoutNullStreams;
  #peer: JsonRpcPeer;
  #stderr = "";
  #exited: Promise<string>;
  #name: string;

  constructor(command: string, args: string[], options: JsonRpcOptions) {
    this.#name = options.name;
    this.#child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
    // A write after the process died fails with EPIPE; the exit handler reports it.
    this.#child.stdin.on("error", () => {});
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    const stdin = this.#child.stdin;
    this.#peer = new JsonRpcPeer(
      this.#child.stdout,
      (line) => {
        if (stdin.writable) stdin.write(line);
      },
      { name: options.name, jsonrpc: options.jsonrpc ?? false },
    );
    this.#exited = new Promise((resolve) => {
      const finish = (reason: string) => {
        const error = new Error(this.#describeExit(reason));
        this.#peer.closed(error);
        resolve(error.message);
      };
      this.#child.on("error", (error) => finish(error.message));
      this.#child.on("exit", (code, signal) =>
        finish(signal ? `signal ${signal}` : `code ${code}`),
      );
    });
  }

  /** Resolves with a description once the process has exited. */
  get exited(): Promise<string> {
    return this.#exited;
  }

  onNotification(handler: NotificationHandler): void {
    this.#peer.onNotification(handler);
  }

  onRequest(handler: RequestHandler): void {
    this.#peer.onRequest(handler);
  }

  /** Hears what a handler threw, which would otherwise crash the whole process. */
  onError(handler: ErrorHandler): void {
    this.#peer.onError(handler);
  }

  /** Sends a request; with `timeoutMs`, rejects if no reply arrives in time. */
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.#peer.request(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.#peer.notify(method, params);
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    await this.#exited;
    clearTimeout(timer);
  }

  #describeExit(reason: string): string {
    const tail = this.#stderr.trim().split("\n").slice(-5).join("\n");
    return tail ? `${this.#name} exited (${reason}): ${tail}` : `${this.#name} exited (${reason})`;
  }
}
