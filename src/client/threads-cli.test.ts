import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { Host } from "../host/host.ts";
import type { LogEntry } from "../protocol.ts";
import { Store } from "../store/store.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { HostClient } from "./client.ts";
import { LocalConnection } from "./connection.ts";
import { THREADS_HELP, threadsCommand, transcriptText } from "./threads-cli.ts";

/**
 * A stream's `write` that keeps the text written to it. The test runner
 * reports on stdout too, in binary, and that still goes out.
 */
function keep(stream: NodeJS.WriteStream, onText: (text: string) => void) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return write(chunk, ...rest);
    onText(chunk);
    return true;
  };
}

const at = 0;
const tokens = { up: 0, down: 0 };

const message = (origin: object, text: string) => ({ id: "m", input: { text }, origin });

describe("transcriptText", () => {
  it("prints messages, replies, commands, file changes, answers, and how turns ended", () => {
    const entries: LogEntry[] = [
      {
        type: "item",
        done: true,
        item: { kind: "user_message", id: "u1", text: "fix it\nplease" },
      },
      { type: "item", done: false, item: { kind: "assistant_message", id: "r0", text: "half" } },
      {
        type: "item",
        done: true,
        item: {
          kind: "command",
          id: "c1",
          command: "pnpm test",
          output: "1 failing",
          exitCode: 1,
          status: "completed",
        },
      },
      {
        type: "item",
        done: true,
        item: {
          kind: "command",
          id: "c2",
          command: "sleep 9",
          output: "",
          exitCode: null,
          status: "failed",
        },
      },
      {
        type: "item",
        done: true,
        item: {
          kind: "file_change",
          id: "f1",
          status: "completed",
          changes: [
            { kind: "update", path: "src/a.ts", diff: "" },
            { kind: "update", path: "src/b.ts", movePath: "src/c.ts", diff: "" },
          ],
        },
      },
      {
        type: "decision",
        kind: "approval",
        title: "Run rm?",
        answer: "Yes",
        outcome: "allowed",
        at,
      },
      {
        type: "decision",
        kind: "question",
        title: "Which?",
        answer: "",
        outcome: "dismissed",
        at,
      },
      { type: "item", done: true, item: { kind: "assistant_message", id: "r1", text: " Fixed. " } },
      {
        type: "item",
        done: true,
        item: { kind: "notice", id: "n1", level: "warning", text: "low on context" },
      },
      { type: "turn.ended", turnId: "t1", status: "completed", error: null, at, ...tokens },
      { type: "turn.ended", turnId: "t2", status: "failed", error: "rate limited", at, ...tokens },
      { type: "turn.ended", turnId: "t3", status: "interrupted", error: null, at, ...tokens },
      { type: "session.ended", error: "crashed" },
    ];
    assert.equal(
      transcriptText(entries),
      [
        "> fix it",
        "> please",
        "",
        "  $ pnpm test  (exit 1)",
        "  $ sleep 9",
        "  update src/a.ts",
        "  update src/c.ts",
        "  Run rm? → Yes",
        "  Which? → dismissed",
        "Fixed.",
        "",
        "  · low on context",
        "",
        "  (failed: rate limited)",
        "",
        "  (interrupted)",
        "",
        "  (session ended: crashed)",
        "",
      ].join("\n"),
    );
  });

  it("shows delegated work as the task and the result, not the brief around them", () => {
    const entries = [
      {
        type: "item",
        done: true,
        item: { kind: "user_message", id: "u1", text: "<brief>…" },
        message: message({ type: "task", from: "thread-a", task: "count the tests" }, "<brief>…"),
      },
      {
        type: "item",
        done: true,
        item: { kind: "user_message", id: "u2", text: "<report>…" },
        message: message(
          { type: "report", from: "thread-b", status: "completed", result: "42" },
          "<report>…",
        ),
      },
      {
        type: "item",
        done: true,
        item: { kind: "user_message", id: "u3", text: "as the harness saw it" },
        message: message({ type: "user" }, "as typed"),
      },
    ] as LogEntry[];
    assert.equal(
      transcriptText(entries),
      "> [task from thread-a] count the tests\n\n> [result from thread-b] 42\n\n> as typed\n",
    );
  });
});

describe("threadsCommand", () => {
  let root: string;
  let unregister: () => void;
  let store: Store;
  let host: Host;
  let output: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "1harness-threads-"));
    unregister = registerScripted();
  });

  after(() => {
    unregister();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    output = "";
    store = Store.memory();
    host = new Host({
      version: "test",
      cwd: root,
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      idleCloseMs: 0,
      store,
    });
  });

  /** Runs the command against the host, with what it prints kept in `output`. */
  async function run(args: string[]): Promise<number> {
    const write = mock.method(
      process.stdout,
      "write",
      keep(process.stdout, (chunk) => (output += chunk)),
    );
    try {
      return await threadsCommand(args, async () => client("cli"));
    } finally {
      write.mock.restore();
    }
  }

  function client(id: string): HostClient {
    return new HostClient(
      new LocalConnection(host, id, { owns: false }),
      { cwd: process.cwd(), version: "test", extensions: [] },
      id,
    );
  }

  /** Opens a thread in `cwd`, runs one message, and returns its ID. */
  async function thread(cwd: string, text: string): Promise<string> {
    const opener = client("opener");
    await opener.connect();
    const opened = await opener.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    await opener.call("thread.send", { threadId: opened.id, text });
    for (let tries = 0; tries < 200; tries++) {
      const state = opener.threads.get(opened.id);
      if (state && state.runCount > 0 && !state.busy) break;
      await new Promise((done) => setTimeout(done, 5));
    }
    await opener.close();
    return opened.id;
  }

  it("prints its help without reaching the host", async () => {
    let connected = false;
    const write = mock.method(
      process.stdout,
      "write",
      keep(process.stdout, (chunk) => (output += chunk)),
    );
    try {
      assert.equal(
        await threadsCommand(["--help"], async () => {
          connected = true;
          return client("cli");
        }),
        0,
      );
    } finally {
      write.mock.restore();
    }
    assert.equal(output, THREADS_HELP);
    assert.equal(connected, false);
  });

  it("lists this folder's threads, or every folder's with --all", async () => {
    const here = await thread(process.cwd(), "parser work");
    const there = await thread(root, "elsewhere");
    assert.equal(await run([]), 0);
    const lines = output.trim().split("\n");
    assert.equal(lines.length, 1);
    // Runs nobody has looked at yet are news.
    assert.match(lines[0]!, /\s+idle\s+scripted\s+.*\s+parser work {2}\[new\]$/);
    assert.ok(lines[0]!.startsWith(here.slice(0, 4)));
    output = "";
    assert.equal(await run(["--all"]), 0);
    // Threads elsewhere say where they are.
    assert.ok(output.includes(`elsewhere  [new]  ${root}\n`));
    output = "";
    assert.equal(await run(["--all", "--json"]), 0);
    const listed = JSON.parse(output) as { id: string }[];
    assert.deepEqual(listed.map((listing) => listing.id).toSorted(), [here, there].toSorted());
  });

  it("says when there are no threads to list", async () => {
    assert.equal(await run([]), 0);
    assert.equal(output, "No threads in this folder; --all lists every folder's.\n");
    output = "";
    assert.equal(await run(["--all"]), 0);
    assert.equal(output, "No threads.\n");
  });

  it("searches what threads said", async () => {
    await thread(process.cwd(), "the tokenizer");
    await thread(process.cwd(), "the renderer");
    assert.equal(await run(["tokenizer"]), 0);
    assert.match(output, /the tokenizer/);
    assert.doesNotMatch(output, /the renderer/);
  });

  it("prints a thread's transcript with show", async () => {
    const id = await thread(process.cwd(), "explain the parser");
    assert.equal(await run(["show", id]), 0);
    assert.match(output, new RegExp(`^${id} · scripted · \\w+ · ${process.cwd()}\\n`));
    assert.match(
      output,
      /> explain the parser\n\n {2}\$ pnpm test {2}\(exit 0\)\nDone with explain/,
    );
    output = "";
    assert.equal(await run(["show", id, "--json"]), 0);
    assert.equal((JSON.parse(output) as { thread: { id: string } }).thread.id, id);
    await assert.rejects(run(["show"]), /Usage: 1harness threads show <id>/);
  });
});
