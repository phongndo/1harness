import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { Host } from "../host/host.ts";
import { Store } from "../store/store.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { App } from "./app.ts";

/**
 * A terminal for the App to draw on: it keeps the rows the screen last wrote,
 * so a test reads the screen as the user would see it.
 */
class Terminal extends Writable {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
  /** The screen's text, row by row, styling stripped. */
  screen: string[] = [];
  /** Everything written outside the screen's rows, such as what quitting prints. */
  raw = "";
  #row = 0;

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    const text = String(chunk);
    this.raw += text;
    // Cursor moves start a row; styles, modes, and terminal queries draw nothing.
    const pattern =
      // oxlint-disable-next-line no-control-regex
      /\x1b\[(\d+);(\d+)H|\x1b\[H|\x1b\[2J|\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[=>]|([^\x1b]+)/g;
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) {
        this.#row = Number(match[1]) - 1;
        if (match[2] === "1") this.screen[this.#row] = "";
      } else if (match[0] === "\x1b[2J") this.screen = [];
      else if (match[3] !== undefined && this.#row < this.rows)
        this.screen[this.#row] = (this.screen[this.#row] ?? "") + match[3];
    }
    done();
  }

  text(): string {
    return Array.from({ length: this.rows }, (_, row) => this.screen[row] ?? "").join("\n");
  }
}

class Keyboard extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
}

const settle = (ms = 10) => new Promise((done) => setTimeout(done, ms));

let root: string;
let unregister: () => void;
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const env = { ...process.env };

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-app-"));
  unregister = registerScripted();
  // The terminal's replies to queries would only make each start wait for them.
  process.env["ONEHARNESS_THEME"] = "dark";
  process.env["ONEHARNESS_PROGRAM_STATUS"] = "0";
  process.env["ONEHARNESS_IMAGES"] = "0";
});

after(() => {
  unregister();
  process.env = env;
  rmSync(root, { recursive: true, force: true });
});

interface Session {
  app: App;
  terminal: Terminal;
  keyboard: Keyboard;
  client: HostClient;
  done: Promise<string | undefined>;
  /** Types text, as keys or as one chunk. */
  type(text: string): Promise<void>;
  /** Waits until the screen shows something. */
  sees(pattern: RegExp | string, timeoutMs?: number): Promise<string>;
  quit(): Promise<string | undefined>;
}

const sessions: Session[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.keyboard.write("\x03\x03");
    await Promise.race([session.done, settle(500)]);
  }
  Object.defineProperty(process, "stdout", realStdout);
  Object.defineProperty(process, "stdin", realStdin);
});

async function start(
  options: { prompt?: string | null; store?: Store | null } = {},
): Promise<Session> {
  const terminal = new Terminal();
  const keyboard = new Keyboard();
  // The App draws on the process's terminal; these stand in for it.
  Object.defineProperty(process, "stdout", { value: terminal, configurable: true });
  Object.defineProperty(process, "stdin", { value: keyboard, configurable: true });
  const host = new Host({
    version: "test",
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
    store: options.store ?? null,
  });
  const client = new HostClient(
    new LocalConnection(host, "tui", { owns: true }),
    { cwd: root, version: "test", extensions: [] },
    "tui",
  );
  const app = new App({
    client,
    harness: "scripted",
    session: { ...scriptedSettings, cwd: root },
    version: "test",
    prompt: options.prompt ?? null,
    warnings: [],
  });
  const done = app.run();
  const session: Session = {
    app,
    terminal,
    keyboard,
    client,
    done,
    async type(text) {
      keyboard.write(text);
      await settle(30);
    },
    async sees(pattern, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = terminal.text();
        if (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) return text;
        if (Date.now() > deadline)
          throw new Error(`The screen never showed ${String(pattern)}:\n${text}`);
        await settle(10);
      }
    },
    async quit() {
      keyboard.write("/quit\r");
      return done;
    },
  };
  sessions.push(session);
  return session;
}

/** The screen's rows from the one showing `text` on, for checking what follows it. */
function rowsFrom(screen: string, text: string): string {
  const at = screen.indexOf(text);
  assert.notEqual(at, -1, `the screen shows ${text}`);
  return screen.slice(at);
}

describe("App", () => {
  it("runs a prompt given on start, then says how to resume its thread on quitting", async () => {
    const session = await start({ prompt: "fix the parser" });
    const screen = await session.sees("Done with fix the parser");
    // The user's message, then what the turn did, then the reply.
    assert.match(
      rowsFrom(screen, "┃ fix the parser"),
      /Ran 1 command[\s\S]*Done with fix the parser/,
    );
    assert.match(screen, /supervised · scripted/);
    assert.equal(await session.quit(), undefined);
    // The terminal gets its own screen back, and the way back to the thread.
    assert.ok(session.terminal.raw.includes("\x1b[?1049l"));
    assert.match(
      session.terminal.raw,
      /Resume with: 1harness --harness scripted --resume native-\d+/,
    );
  });

  it("sends what is typed in the composer, and keeps the transcript in order", async () => {
    const session = await start();
    await session.sees("Ask anything");
    await session.type("first message");
    assert.match(await session.sees("first message"), /┃ first message/);
    await session.type("\r");
    await session.sees("Done with first message");
    await session.type("second\r");
    const screen = await session.sees("Done with second");
    assert.ok(screen.indexOf("Done with first message") < screen.indexOf("┃ second"));
    // The composer empties once a message is sent.
    assert.match(screen, /┃ Ask anything/);
  });

  it("offers no way back on quitting before any turn ran", async () => {
    const session = await start();
    await session.sees("Ask anything");
    await session.quit();
    assert.doesNotMatch(session.terminal.raw, /Resume with/);
  });
});
