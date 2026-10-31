import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { OcEvent } from "./translate.ts";

const START_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 4_096;
// The server sends a heartbeat every ten seconds or so, so a minute of silence means it is gone.
const SILENCE_MS = 60_000;

/**
 * A private `opencode serve` for one session: on a free localhost port, with a
 * password only this process knows, in the session's folder.
 */
export class OpenCodeServer {
  #child: ChildProcess;
  #password = randomBytes(24).toString("base64url");
  #url: Promise<string>;
  #cwd: string;
  #stderr = "";
  #exited: Promise<string>;
  #stream: AbortController | null = null;

  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.#cwd = cwd;
    // The password variable of OpenCode 1 would take the place of this one.
    const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = env;
    this.#child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd,
      env: { ...rest, OPENCODE_PASSWORD: this.#password },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.#exited = new Promise((resolve) => {
      this.#child.on("error", (error) => resolve(this.#describeExit(error.message)));
      this.#child.on("exit", (code, signal) =>
        resolve(this.#describeExit(signal ? `signal ${signal}` : `code ${code}`)),
      );
    });
    this.#url = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("OpenCode did not start its server in time")),
        START_TIMEOUT_MS,
      );
      const lines = createInterface({ input: this.#child.stdout! });
      lines.on("line", (line) => {
        const url = /listening on (http:\/\/\S+)/.exec(line)?.[1];
        if (!url) return;
        clearTimeout(timer);
        resolve(url.replace(/\/$/, ""));
      });
      void this.#exited.then((reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      });
    });
    // Rejections reach whoever awaits the URL; this one only keeps Node from reporting it.
    this.#url.catch(() => {});
  }

  /** Resolves with a description once the server has exited. */
  get exited(): Promise<string> {
    return this.#exited;
  }

  ready(): Promise<string> {
    return this.#url;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = await this.#url;
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...this.#headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      // Errors come as JSON with a message, or as text.
      let message = text || `HTTP ${response.status}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON; the body is the message.
      }
      throw new Error(message);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Reads the server's events until the stream ends or goes silent. Resolves
   * once the server has accepted the subscription, since events sent before
   * that are lost; `done` settles when the stream stops.
   */
  async subscribe(onEvent: (event: OcEvent) => void): Promise<{ done: Promise<void> }> {
    const url = await this.#url;
    const controller = new AbortController();
    this.#stream = controller;
    const response = await fetch(`${url}/api/event`, {
      headers: { ...this.#headers(), accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`OpenCode refused the event stream (HTTP ${response.status})`);
    const body = response.body;
    const done = (async () => {
      let silence: NodeJS.Timeout | undefined;
      let silent = false;
      const watch = () => {
        clearTimeout(silence);
        silence = setTimeout(() => {
          silent = true;
          controller.abort();
        }, SILENCE_MS);
      };
      watch();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of body) {
          watch();
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            let event: OcEvent;
            try {
              event = JSON.parse(data) as OcEvent;
            } catch {
              // An event that is not JSON is skipped.
              continue;
            }
            onEvent(event);
          }
        }
      } catch (error) {
        if (silent) throw new Error("OpenCode stopped sending events", { cause: error });
        // Closing aborts the stream, which is no failure.
        if (!controller.signal.aborted) throw error;
      } finally {
        clearTimeout(silence);
      }
    })();
    return { done };
  }

  async close(): Promise<void> {
    this.#stream?.abort();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 3_000);
    await this.#exited;
    clearTimeout(timer);
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`opencode:${this.#password}`, "utf8").toString("base64")}`,
      // Every request is about the session's folder, sent encoded as OpenCode's clients do.
      "x-opencode-directory": encodeURIComponent(this.#cwd),
    };
  }

  #describeExit(reason: string): string {
    const tail = this.#stderr.trim().split("\n").slice(-5).join("\n");
    return tail ? `OpenCode exited (${reason}): ${tail}` : `OpenCode exited (${reason})`;
  }
}
