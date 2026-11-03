import type { ChildProcess } from "node:child_process";

// Only the last lines are shown; the rest is room for long ones, such as a stack trace.
const STDERR_TAIL_BYTES = 16_384;
const STDERR_TAIL_LINES = 5;
// Time for a harness to save its state on SIGTERM before it is killed.
const KILL_AFTER_MS = 3_000;

/** The end of what a process wrote to stderr, which says why it stopped. */
export class StderrTail {
  #text = "";

  append(chunk: string): void {
    this.#text = (this.#text + chunk).slice(-STDERR_TAIL_BYTES);
  }

  /** The last few lines, or "" if it wrote none. */
  toString(): string {
    return this.#text.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
  }
}

/** A harness's process: why it exited, from its stderr, and a close that does not hang. */
export class HarnessProcess {
  readonly child: ChildProcess;
  /** Resolves with a description once the process has exited. */
  readonly exited: Promise<string>;
  #stderr = new StderrTail();

  /** `name` says which process exited, such as `OpenCode`. */
  constructor(child: ChildProcess, name: string) {
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.#stderr.append(chunk));
    this.exited = new Promise((resolve) => {
      const exit = (reason: string) => {
        const tail = this.#stderr.toString();
        resolve(tail ? `${name} exited (${reason}): ${tail}` : `${name} exited (${reason})`);
      };
      child.on("error", (error) => exit(error.message));
      child.on("exit", (code, signal) => exit(signal ? `signal ${signal}` : `code ${code}`));
    });
  }

  /** Asks the process to stop, kills it if it will not, and waits for it to exit. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), KILL_AFTER_MS);
    await this.exited;
    clearTimeout(timer);
  }
}
