import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { errorMessage } from "../core/errors.ts";
import type { SessionOptions, UserInput } from "../core/events.ts";
import { RpcError } from "../protocol.ts";
import { Host } from "../host/host.ts";
import { Store } from "../store/store.ts";
import { registerDriver } from "../drivers/index.ts";
import { registerScripted, ScriptedSession, scriptedSettings } from "../testing/scripted.ts";
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
  /** A move to a row's start, which the text drawn next replaces the row with. */
  #fresh = false;

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
        // Only text replaces the row: the cursor moves to a row's start too.
        this.#fresh = match[2] === "1";
      } else if (match[0] === "\x1b[2J") this.screen = [];
      else if (match[0] === "\x1b[K" && this.#fresh) this.screen[this.#row] = "";
      else if (match[3] !== undefined && this.#row < this.rows) {
        this.screen[this.#row] = (this.#fresh ? "" : (this.screen[this.#row] ?? "")) + match[3];
        this.#fresh = false;
      }
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
  options: {
    prompt?: string | null;
    store?: Store | null;
    /** Null asks, as the first run does. */
    harness?: string | null;
    setDefault?: (harness: string) => string;
    onHarness?: (harness: string) => void;
    /** Where the host looks for harnesses. */
    env?: NodeJS.ProcessEnv;
    /** Extension modules the terminal names, as `-x` does. */
    extensions?: string[];
    /** The config folder, for a test that needs its own. */
    configDir?: string;
  } = {},
): Promise<Session> {
  const terminal = new Terminal();
  const keyboard = new Keyboard();
  // The App draws on the process's terminal; these stand in for it.
  Object.defineProperty(process, "stdout", { value: terminal, configurable: true });
  Object.defineProperty(process, "stdin", { value: keyboard, configurable: true });
  const host = new Host({
    version: "test",
    cwd: root,
    configDir: options.configDir ?? join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
    store: options.store ?? null,
    ...(options.env ? { env: options.env } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });
  const client = new HostClient(
    new LocalConnection(host, "tui", { owns: true }),
    { cwd: root, version: "test", extensions: options.extensions ?? [] },
    "tui",
  );
  const app = new App({
    client,
    harness: options.harness === undefined ? "scripted" : options.harness,
    ...(options.setDefault ? { setDefault: options.setDefault } : {}),
    ...(options.onHarness ? { onHarness: options.onHarness } : {}),
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
      // The App reads keys as the stream hands them over, and draws what they did at once.
      while (keyboard.readableLength > 0) await new Promise(setImmediate);
      await new Promise(setImmediate);
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

function extension(text: string): string {
  const path = join(root, `screen-extension-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(path, text);
  return path;
}

describe("extensions on screen", () => {
  it("runs a command from its key, writes on the status line, and lists the key in /help", async () => {
    const path = extension(`
      export default function (api) {
        api.registerCommand({
          name: "ping",
          description: "pings",
          group: "Tools",
          shortcut: "alt+y",
          run(context) {
            context.ui.setStatus("ping", "pinged once");
            context.ui.notify("info", "ran ping");
          },
        });
        api.registerCommand({
          name: "clear-ping",
          description: "clears",
          group: "Tools",
          run(context) {
            context.ui.setStatus("ping", null);
          },
        });
      }`);
    const session = await start({ extensions: [path] });
    await session.sees(/scripted/);
    await settle(50);
    await session.type("half typed");
    await session.type("\x1by");
    await session.sees("ran ping");
    await session.sees("pinged once");
    // The key's letter did not land in what was being typed.
    assert.match(session.terminal.text(), /half typed\s/);
    assert.doesNotMatch(session.terminal.text(), /half typedy/);

    await session.type("\x15/clear-ping\r");
    for (let tries = 0; tries < 100 && session.terminal.text().includes("pinged once"); tries++)
      await settle(10);
    assert.doesNotMatch(session.terminal.text(), /pinged once/);
  });

  it("takes no extension's key over a list that is open", async () => {
    const path = extension(`
      export default function (api) {
        api.registerCommand({
          name: "ping",
          description: "pings",
          group: "Tools",
          shortcut: "alt+y",
          run(context) { context.ui.notify("info", "ran ping"); },
        });
      }`);
    const session = await start({ extensions: [path] });
    await session.sees(/scripted/);
    await settle(50);
    await session.type("/help\r");
    await session.sees("Commands");
    await session.type("\x1by");
    await settle(30);
    assert.doesNotMatch(session.terminal.text(), /ran ping/);
  });

  it("shows a tool call as its renderer says", async () => {
    const path = extension(`
      export default function (api) {
        api.registerToolRenderer((item) =>
          item.tool === "search" ? "Looked through the docs for parsers" : undefined,
        );
      }`);
    const session = await start({ extensions: [path], prompt: "go TOOL" });
    await session.sees("Done with go TOOL");
    await session.type("\x18");
    await session.sees("Looked through the docs for parsers");
  });
});

describe("skills on screen", () => {
  it("sends a skill 1harness offers with $, and leaves other dollars as messages", async () => {
    const config = join(root, "skills-config");
    mkdirSync(join(config, "skills", "tidy"), { recursive: true });
    writeFileSync(
      join(config, "skills", "tidy", "SKILL.md"),
      "---\ndescription: Tidies a file\n---\nTidy it well.\n",
    );
    const session = await start({ configDir: config });
    await session.sees(/scripted/);
    await settle(50);
    await session.type("$ti");
    await session.sees("Tidies a file");
    await session.type("\x15$tidy the parser\r");
    await session.sees("Tidy it well");
    await session.sees(/Done with <skill name="tidy"/);
    await session.type("$5 a month\r");
    await session.sees("Done with $5 a month");
  });
});

describe("App", () => {
  it("runs a prompt given on start, then says how to resume its thread on quitting", async () => {
    const session = await start({ prompt: "fix the parser" });
    const screen = await session.sees("Done with fix the parser");
    // The user's message, then what the turn did, then the reply.
    assert.match(
      rowsFrom(screen, "┃ fix the parser"),
      /Ran 1 command[\s\S]*Done with fix the parser/,
    );
    assert.match(screen, /\S+ {2,}supervised · scripted/);
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
    assert.match(await session.sees("first message"), /^first message/m);
    await session.type("\r");
    await session.sees("Done with first message");
    await session.type("second\r");
    const screen = await session.sees("Done with second");
    assert.ok(screen.indexOf("Done with first message") < screen.indexOf("┃ second"));
    // The composer empties once a message is sent.
    assert.match(screen, /^Ask anything/m);
  });

  it("sends a message typed while the first thread is still starting once it opens", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const unregisterSlow = registerDriver({
      id: "slow",
      label: "Slow",
      unavailable: () => null,
      create: (options) => Object.assign(new ScriptedSession(options), { start: () => opened }),
    });
    try {
      const session = await start({ harness: "slow" });
      await session.sees("Ask anything");
      await session.type("early\r");
      // Once the starting thread is shown, what is typed must still wait its turn.
      while (session.client.threads.size === 0) await settle();
      await session.type("later\r");
      assert.doesNotMatch(session.terminal.text(), /No thread is open/);
      open();
      const screen = await session.sees(/Done with early[\s\S]*Done with later/);
      assert.ok(screen.indexOf("Done with early") < screen.indexOf("┃ later"));
      // Neither message is left behind in the composer.
      assert.match(screen, /^Ask anything/m);
    } finally {
      unregisterSlow();
    }
  });

  it("hands what it held back to the composer, with the draft, when no thread opens", async () => {
    let fail!: (error: Error) => void;
    const failed = new Promise<void>((_, reject) => (fail = reject));
    const unregisterBroken = registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) => Object.assign(new ScriptedSession(options), { start: () => failed }),
    });
    try {
      const session = await start({ harness: "broken" });
      await session.sees("Ask anything");
      await session.type("held\r");
      await session.type("draft");
      fail(new Error("no harness"));
      const screen = await session.sees("Could not start broken");
      assert.match(screen, /^held\n\s*\n?draft/m);
    } finally {
      unregisterBroken();
    }
  });

  it("asks which harness to start when none is named, saying where each stands", async () => {
    const unregisterSignedOut = registerDriver({
      id: "signedout",
      label: "Signed Out",
      unavailable: () => null,
      signIn: async () => ({ state: "signed-out", detail: "run `signedout login` to sign in" }),
      create: (options) => new ScriptedSession(options),
    });
    const used: string[] = [];
    const defaults: string[] = [];
    try {
      // No real harness is found on this PATH, so none is asked anything.
      const session = await start({
        harness: null,
        env: { PATH: "" },
        onHarness: (harness) => used.push(harness),
        setDefault: (harness) => {
          defaults.push(harness);
          return "~/.config/1harness/settings.json";
        },
      });
      const picker = await session.sees("Which harness should 1harness start?");
      assert.match(picker, /claude\s+Claude Code · install with `npm i -g .*not installed/);
      assert.match(
        picker,
        /signedout\s+Signed Out · run `signedout login` to sign in\s+needs sign-in/,
      );
      assert.match(picker, /scripted\s+Scripted\s+installed/);
      assert.match(picker, /ctrl\+s use and make default/);
      await session.type("signedout\r");
      const screen = await session.sees(/Once it is, send your\s+message again/);
      // Enter uses it, and the next run starts on it as the one used last; it is no default.
      assert.deepEqual(used, ["signedout"]);
      assert.deepEqual(defaults, []);
      assert.match(screen, /1harness starts Signed Out next time too, as the harness used last/);
      assert.match(
        screen,
        /Signed Out is not signed in: run `signedout login` to sign in\. Once it is, send your\s+message again\./,
      );
    } finally {
      unregisterSignedOut();
    }
  });

  it("keeps a harness -H named as the one used last", async () => {
    const used: string[] = [];
    const session = await start({ onHarness: (harness) => used.push(harness) });
    // Shown, the thread's session is up, and the harness it runs was told.
    await session.sees("supervised · scripted · big");
    assert.deepEqual(used, ["scripted"]);
  });

  it("makes the harness ctrl+s chooses the default, there and in /harness", async () => {
    const defaults: string[] = [];
    const session = await start({
      harness: null,
      env: { PATH: "" },
      setDefault: (harness) => {
        defaults.push(harness);
        return "~/.config/1harness/settings.json";
      },
    });
    await session.sees("Which harness should 1harness start?");
    await session.type("scripted\x13");
    await session.sees(
      /Scripted is your default harness, in ~\/\.config\/1harness\/settings\.json/,
    );
    assert.deepEqual(defaults, ["scripted"]);
    await session.type("/harness\r");
    const picker = await session.sees("Harnesses");
    assert.match(picker, /scripted\s+Scripted\s+current · default · installed/);
    await session.type("\x1b");
  });

  it("quits without a thread when the first run's question goes unanswered", async () => {
    const session = await start({ harness: null, env: { PATH: "" } });
    await session.sees("Which harness should 1harness start?");
    await session.type("\x1b");
    assert.equal(await session.done, undefined);
    assert.equal(session.client.threads.size, 0);
  });

  it("says once that the harness in use must sign in, through its own CLI", async () => {
    const unregisterSignedOut = registerDriver({
      id: "signedout",
      label: "Signed Out",
      unavailable: () => null,
      signIn: async () => ({ state: "signed-out", detail: "run `signedout login` to sign in" }),
      create: (options) => new ScriptedSession(options),
    });
    try {
      const session = await start({ harness: "signedout" });
      const screen = await session.sees(/Once it is, send your\s+message again/);
      assert.match(screen, /Signed Out is not signed in: run `signedout login` to sign in\./);
      assert.equal(screen.match(/is not signed in/g)?.length, 1);
    } finally {
      unregisterSignedOut();
    }
  });

  it("offers no way back on quitting before any turn ran", async () => {
    const session = await start();
    await session.sees("Ask anything");
    await session.quit();
    assert.doesNotMatch(session.terminal.raw, /Resume with/);
  });
});

describe("App commands", () => {
  it("narrows the command menu to what is typed after the slash", async () => {
    const session = await start();
    await session.sees("Ask anything");
    await session.type("/");
    const all = await session.sees(/Commands \d+/);
    assert.match(all, /\/new\s+start a new thread/);
    assert.match(all, /\/quit\s+exit/);
    await session.type("he");
    const narrowed = await session.sees("Commands 1");
    assert.match(narrowed, /\/help\s+show commands and keys/);
    assert.doesNotMatch(narrowed, /\/new/);
  });

  it("keeps the harness's skills to `$`, apart from the commands `/` lists", async () => {
    const unregisterSkilled = registerDriver({
      id: "skilled",
      label: "Skilled",
      unavailable: () => null,
      create: (options) => {
        const scripted = new ScriptedSession(options);
        const startTurn = scripted.startTurn.bind(scripted);
        return Object.assign(scripted, {
          listCommands: async () => [
            {
              name: "tidy",
              aliases: [],
              description: "tidy the docs",
              argumentHint: "",
              kind: "skill" as const,
              startsTurn: true,
            },
          ],
          // A turn that runs until stopped, so what is sent meanwhile queues.
          startTurn: async (input: UserInput) => {
            if (input.text !== "hold") return startTurn(input);
            scripted.events.push({ type: "turn.started", turnId: "held" });
          },
          interrupt: async () => {
            scripted.events.push({
              type: "turn.ended",
              turnId: "held",
              status: "interrupted",
              error: null,
            });
          },
        });
      },
    });
    try {
      const session = await start({ harness: "skilled" });
      await session.sees("supervised · skilled · big");
      await session.type("/");
      assert.doesNotMatch(await session.sees(/Commands \d+/), /tidy/);
      await session.type("\x15$");
      assert.match(await session.sees("Skills 1"), /\$tidy\s+tidy the docs/);
      await session.type("\x15/tidy\r");
      await session.sees("Unknown command /tidy. $tidy runs the skill.");
      await session.type("$tidy the docs\r");
      await session.sees("Done with /tidy the docs");
      // A `$` that names no skill is a message.
      await session.type("$5 a month\r");
      await session.sees("Done with $5 a month");
      // So is a path, as an image that is not there leaves.
      await session.type("/tmp/gone.png\r");
      await session.sees("Done with /tmp/gone.png");
      // A queued skill comes back as typed.
      await session.type("hold\r");
      await session.sees("Add to the turn");
      await session.type("$tidy later\r");
      await session.sees("queued: /tidy later");
      await session.type("/unqueue\r");
      await session.sees(/^\$tidy later/m);
    } finally {
      unregisterSkilled();
    }
  });

  it("lists commands with their arguments, and keys, in /help", async () => {
    const session = await start();
    // Some commands are listed only once the thread's session runs.
    await session.sees("supervised · scripted · big");
    await session.type("/help\r");
    const help = await session.sees("tab category");
    assert.match(help, /\[All\]\s+Threads\s+Model\s+Permissions\s+Tools\s+General\s+Keys/);
    assert.match(help, /\/rename <title>\s+rename this thread/);
    // Esc closes the panel and leaves the composer as it was.
    await session.type("\x1b");
    assert.doesNotMatch(session.terminal.text(), /tab category/);
    assert.match(session.terminal.text(), /^Ask anything/m);
  });

  it("shows the session in /status and switches modes from /mode", async () => {
    const session = await start({ prompt: "hello" });
    await session.sees("Done with hello");
    await session.type("/status\r");
    const status = await session.sees(/Status\n/);
    assert.match(status, /Harness\s+Scripted/);
    assert.match(status, /Session\s+native-\d+/);
    assert.match(status, /Model\s+big \(default\)/);
    assert.match(status, /Server\s+in this process, keeping nothing/);
    await session.type("\x1b");
    await session.type("/mode\r");
    const modes = await session.sees("Permission modes 2");
    assert.match(modes, /supervised\s+read freely; ask before edits and commands\s+current/);
    await session.type("\x1b[B");
    await session.type("\r");
    await session.sees("Mode: full-access");
  });
});

describe("App threads and keys", () => {
  it("attaches an image whose path is pasted as [Image #N], and sends it with the message", async () => {
    const received: UserInput[] = [];
    const unregisterSeeing = registerDriver({
      id: "seeing",
      label: "Seeing",
      unavailable: () => null,
      create: (options) => {
        const scripted = new ScriptedSession(options);
        const startTurn = scripted.startTurn.bind(scripted);
        return Object.assign(scripted, {
          capabilities: { ...scripted.capabilities, images: true },
          startTurn: async (input: UserInput) => {
            received.push(input);
            return startTurn(input);
          },
        });
      },
    });
    try {
      const shot = join(root, "Screen shot.png");
      writeFileSync(shot, "png bytes");
      const session = await start({ harness: "seeing" });
      await session.sees("supervised · seeing · big");
      // As a terminal writes a dropped file's path, in a bracketed paste.
      await session.type(`what is \x1b[200~${shot.replaceAll(" ", "\\ ")}\x1b[201~`);
      await session.sees(/^what is \[Image #1\]/m);
      await session.type("\r");
      await session.sees("Done with what is [Image #1]");
      const [image] = received.at(-1)?.images ?? [];
      assert.ok(image);
      assert.equal(readFileSync(image, "utf8"), "png bytes");
      // Together, one message's images stay under what a server takes.
      const big = [join(root, "big-1.png"), join(root, "big-2.png")];
      for (const path of big) writeFileSync(path, Buffer.alloc(6 * 1024 * 1024));
      await session.type(`\x1b[200~${big.join(" ")}\x1b[201~`);
      const refused = await session.sees("images can be at most 10 MB together");
      assert.match(refused, /^\[Image #2\] $/m);
      assert.doesNotMatch(refused, /\[Image #3\]/);
    } finally {
      unregisterSeeing();
    }
  });

  it("shows a long paste as a placeholder, and sends it whole", async () => {
    const received: UserInput[] = [];
    const unregisterReading = registerDriver({
      id: "reading",
      label: "Reading",
      unavailable: () => null,
      create: (options) => {
        const scripted = new ScriptedSession(options);
        const startTurn = scripted.startTurn.bind(scripted);
        return Object.assign(scripted, {
          startTurn: async (input: UserInput) => {
            received.push(input);
            return startTurn(input);
          },
        });
      },
    });
    try {
      const log = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
      const session = await start({ harness: "reading" });
      await session.sees("supervised · reading · big");
      await session.type(`why \x1b[200~${log}\x1b[201~`);
      await session.sees(/^why \[Pasted text #1 \+12 lines\]/m);
      // Pasted again, it shows in place; backspace takes a placeholder whole.
      await session.type(`\x1b[200~${log}\x1b[201~`);
      await session.sees(/^line 12/m);
      await session.type("\x15\x7f");
      await session.type(` \x1b[200~${log}\x1b[201~\x7f`);
      const gone = await session.sees(/^line 11 $/m);
      assert.doesNotMatch(gone, /Pasted text/);
      await session.type(`\x1b[200~${log}\x1b[201~`);
      await session.sees(/^line 11 \[Pasted text #3 \+12 lines\]/m);
      await session.type("\r");
      await session.sees("Done with why line 1");
      assert.equal(received.at(-1)?.text, `why ${log.split("\n").slice(0, 11).join("\n")} ${log}`);
    } finally {
      unregisterReading();
    }
  });

  it("opens another thread with /new, and switches back to the first from ctrl+t", async () => {
    const session = await start({ prompt: "alpha" });
    await session.sees("Done with alpha");
    await session.type("/new\r");
    await session.sees("New scripted thread");
    await session.type("beta\r");
    const second = await session.sees("Done with beta");
    // A new thread starts with an empty transcript.
    assert.doesNotMatch(second, /Done with alpha/);
    await session.type("\x14");
    const picker = await session.sees("enter resume");
    assert.match(picker, /Resume\s+◉ This folder\s+○ All\s+○ Archived/);
    // Most recent first: the thread on screen, then the one before it.
    assert.match(picker, /› now\s+beta\s+scripted\n\s+now\s+alpha\s+scripted/);
    await session.type("\x1b[B");
    await session.type("\r");
    await session.sees("Done with alpha");
    assert.doesNotMatch(session.terminal.text(), /Done with beta/);
  });

  it("starts /new on the harness, model, and effort it names", async () => {
    const session = await start({ prompt: "alpha" });
    await session.sees("Done with alpha");
    await session.type("/new scripted small high\r");
    await session.sees("New scripted thread");
    await session.type("/status\r");
    assert.match(await session.sees(/Status\n/), /Model\s+small · high/);
    await session.type("\x1b");
    await session.type("/new nowhere\r");
    await session.sees("No harness named nowhere");
    await session.type("/new scripted big high extra\r");
    await session.sees("Usage: /new [harness] [model] [effort]");
  });

  it("says why the thread list could not load, rather than that there are no threads", async () => {
    const session = await start({ prompt: "alpha" });
    await session.sees("Done with alpha");
    const call = session.client.call.bind(session.client);
    session.client.call = ((method: string, params: unknown) =>
      method === "threads.list"
        ? Promise.reject(new Error("the store is locked"))
        : call(method as never, params as never)) as typeof session.client.call;
    await session.type("\x14");
    const screen = await session.sees("the store is locked");
    assert.doesNotMatch(screen, /No threads yet/);
  });

  it("says once why a move to another harness failed, through a server too", async () => {
    const unregisterBroken = registerDriver({
      id: "broken",
      label: "Broken",
      unavailable: () => null,
      create: (options) =>
        Object.assign(new ScriptedSession(options), {
          start: () => Promise.reject(new Error("the broken harness is broken")),
        }),
    });
    try {
      const session = await start({ prompt: "alpha" });
      await session.sees("Done with alpha");
      // A server sends back every error as an RpcError.
      const call = session.client.call.bind(session.client);
      session.client.call = ((method: string, params: unknown) =>
        call(method as never, params as never).catch((error: unknown) => {
          throw error instanceof RpcError ? error : new RpcError("error", errorMessage(error));
        })) as typeof session.client.call;
      await session.type("/harness broken\r");
      const screen = await session.sees("Could not move to Broken");
      assert.equal(screen.match(/the broken harness is broken/g)?.length, 1, screen);
    } finally {
      unregisterBroken();
    }
  });

  it("asks for an approval in the composer's place, and goes on once it is given", async () => {
    const session = await start();
    await session.sees("supervised · scripted · big");
    await session.type("look ASK\r");
    const asked = await session.sees("Permission needed");
    assert.match(asked, /Run\?/);
    assert.doesNotMatch(asked, /Ask anything/);
    // Keys typed as the prompt came were meant for what it covered; after a pause they count.
    await settle(450);
    await session.type("\r");
    const screen = await session.sees("Done with look ASK");
    assert.doesNotMatch(screen, /Permission needed/);
  });

  it("starts the harness's session over with /reload, resuming its thread", async () => {
    const resumed: (string | null)[] = [];
    const servers: SessionOptions["mcpServers"][] = [];
    /** Holds the next session's start, while set. */
    let starting: Promise<void> | null = null;
    const mcp = (command: string) =>
      writeFileSync(
        join(root, "config", "mcp.json"),
        JSON.stringify({ mcpServers: { docs: { command } } }),
      );
    mkdirSync(join(root, "config"), { recursive: true });
    mcp("before");
    const unregisterCounted = registerDriver({
      id: "counted",
      label: "Counted",
      unavailable: () => null,
      create: (options) => {
        resumed.push(options.resume);
        servers.push(options.mcpServers);
        const scripted = new ScriptedSession(options);
        const held = starting;
        return held ? Object.assign(scripted, { start: () => held }) : scripted;
      },
    });
    try {
      const session = await start({ harness: "counted", prompt: "alpha" });
      await session.sees("Done with alpha");
      mcp("after");
      await session.type("/reload\r");
      await session.sees("Reloaded the harness's session.");
      assert.equal(resumed.length, 2);
      assert.equal(resumed[0], null);
      assert.match(resumed[1] ?? "", /^native-\d+$/);
      // It reads the MCP config again too.
      assert.deepEqual(
        servers.map((each) => (each?.["docs"] as { command?: string } | undefined)?.command),
        ["before", "after"],
      );
      await session.type("beta\r");
      await session.sees("Done with beta");
      // A second /reload while the first starts the session is refused, and
      // leaves the first's 1harness MCP server working.
      const hold = Promise.withResolvers<void>();
      starting = hold.promise;
      await session.type("/reload\r");
      while (resumed.length < 3) await settle();
      await session.type("/reload\r");
      await session.sees("is already starting");
      starting = null;
      hold.resolve();
      await session.sees(/Reloaded the harness's session\.[\s\S]*Reloaded the harness's session\./);
      assert.equal(resumed.length, 3);
      const tools = servers.at(-1)?.["1harness"];
      assert.ok(tools?.type === "http");
      const listed = await fetch(tools.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tools.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(listed.status, 200);
    } finally {
      rmSync(join(root, "config", "mcp.json"), { force: true });
      unregisterCounted();
    }
  });

  it("renames the thread with /rename", async () => {
    const session = await start({ prompt: "alpha" });
    await session.sees("Done with alpha");
    await session.type("/rename Parser work\r");
    await session.sees(/Renamed \w+: Parser work/);
    const id = [...session.client.threads.keys()][0]!;
    assert.equal(session.client.threads.get(id)?.title, "Parser work");
  });

  it("shows tool output whole with ctrl+x, and in brief again", async () => {
    const session = await start({ prompt: "alpha" });
    const brief = await session.sees("Done with alpha");
    assert.match(brief, /Ran 1 command/);
    assert.doesNotMatch(brief, /ok 1/);
    await session.type("\x18");
    const whole = await session.sees("details · ctrl+x");
    assert.match(whole, /Ran pnpm test\n+\s+ok 1/);
    await session.type("\x18");
    await session.sees("Ran 1 command");
    assert.doesNotMatch(session.terminal.text(), /details · ctrl\+x/);
  });

  it("clears the composer with ctrl+c, then exits on ctrl+c twice", async () => {
    const session = await start();
    await session.sees("supervised · scripted · big");
    await session.type("half a thought");
    await session.sees(/^half a thought/m);
    await session.type("\x03");
    await session.sees(/^Ask anything/m);
    await session.type("\x03");
    await session.sees("Press ctrl+c again to exit");
    await session.type("\x03");
    assert.equal(await session.done, undefined);
  });
});
