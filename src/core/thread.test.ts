import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AsyncQueue } from "./async-queue.ts";
import type {
  HarnessEvent,
  HarnessSession,
  NativeCommand,
  SessionInfo,
  UserInput,
} from "./events.ts";
import { Thread, type ThreadEvent } from "./thread.ts";

class FakeSession {
  readonly capabilities = {
    steer: true,
    planMode: false,
    runtimeModes: ["supervised"] as const,
    nativeSlashCommands: false,
  };
  readonly info: SessionInfo = {
    harness: "codex",
    threadId: "t",
    cwd: "/",
    model: null,
    effort: null,
    runtimeMode: "supervised",
    interactionMode: "default",
    version: null,
  };
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly turns: string[] = [];
  readonly steered: string[] = [];
  readonly commands: string[] = [];
  /** What the harness was sent, turns and steers alike. */
  readonly sent: UserInput[] = [];
  steerFails = false;

  async start(): Promise<void> {}
  async startTurn(input: UserInput): Promise<void> {
    this.turns.push(input.text);
    this.sent.push(input);
  }
  async steer(input: UserInput): Promise<void> {
    if (this.steerFails) throw new Error("turn ended");
    this.steered.push(input.text);
    this.sent.push(input);
  }
  async runCommand(name: string, args: string): Promise<void> {
    this.commands.push(`${name} ${args}`);
  }
  async close(): Promise<void> {
    this.events.end();
  }
}

function command(name: string, startsTurn: boolean): NativeCommand {
  return { name, aliases: [], description: "", argumentHint: "", kind: "command", startsTurn };
}

function approval(id: string, shell: string): HarnessEvent {
  return {
    type: "request.opened",
    request: {
      kind: "approval",
      id,
      title: "",
      detail: "",
      action: { type: "command", command: shell, cwd: null },
      options: [
        { id: "once", label: "Yes", effect: "allow" },
        { id: "always", label: "Always", effect: "allow-always" },
      ],
      defaultOptionId: "once",
    },
  };
}

/** Lets the thread consume the events pushed so far. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function setup() {
  const session = new FakeSession();
  const thread = new Thread(session as unknown as HarnessSession);
  const seen: string[] = [];
  thread.subscribe((event) => seen.push(event.type));
  await thread.start();
  return { session, thread, seen };
}

describe("Thread", () => {
  it("queues sends while busy and starts the next turn when one ends", async () => {
    const { session, thread } = await setup();
    thread.send({ text: "first" });
    thread.send({ text: "second" });
    assert.deepEqual(session.turns, ["first"]);
    assert.deepEqual(
      thread.queue.map((message) => message.input.text),
      ["second"],
    );
    session.events.push({ type: "turn.started", turnId: "1" });
    session.events.push({ type: "turn.ended", turnId: "1", status: "completed", error: null });
    await settle();
    assert.deepEqual(session.turns, ["first", "second"]);
    assert.equal(thread.queue.length, 0);
    assert.equal(thread.busy, true);
  });

  it("steers the running turn and queues when steering loses the race", async () => {
    const { session, thread } = await setup();
    thread.send({ text: "work" });
    await thread.steer({ text: "faster" });
    assert.deepEqual(session.steered, ["faster"]);
    session.steerFails = true;
    await thread.steer({ text: "late" });
    assert.deepEqual(
      thread.queue.map((message) => message.input.text),
      ["late"],
    );
  });

  it("ignores the end of a turn it is not tracking", async () => {
    const { session, thread } = await setup();
    thread.send({ text: "a" });
    session.events.push({ type: "turn.started", turnId: "2" });
    session.events.push({ type: "turn.ended", turnId: "old", status: "completed", error: null });
    await settle();
    assert.equal(thread.busy, true);
  });

  it("applies deltas to open items and forgets completed ones", async () => {
    const { session, thread } = await setup();
    session.events.push({
      type: "item.started",
      item: {
        kind: "command",
        id: "c",
        command: "ls",
        output: "",
        exitCode: null,
        status: "running",
      },
    });
    session.events.push({ type: "item.delta", itemId: "c", chunk: "a\n" });
    session.events.push({ type: "item.delta", itemId: "c", chunk: "b\n" });
    await settle();
    const item = thread.item("c");
    assert.equal(item?.kind === "command" && item.output, "a\nb\n");
    session.events.push({
      type: "item.completed",
      item: {
        kind: "command",
        id: "c",
        command: "ls",
        output: "a\nb\n",
        exitCode: 0,
        status: "completed",
      },
    });
    await settle();
    assert.equal(thread.item("c"), undefined);
  });

  it("sends turn commands as messages and runs the rest at once, even mid-turn", async () => {
    const { session, thread } = await setup();
    await thread.command(command("review", true), "the parser");
    await thread.command(command("init", true), "");
    await thread.command(command("ps", false), "");
    assert.deepEqual(session.turns, ["/review the parser"]);
    assert.deepEqual(
      thread.queue.map((message) => message.input.text),
      ["/init"],
    );
    assert.deepEqual(session.commands, ["ps "]);
    await thread.close();
  });

  it("approves an action again once the user chose to always allow it", async () => {
    const { session, thread } = await setup();
    const responses: [string, unknown][] = [];
    (session as unknown as { respond: (id: string, response: unknown) => Promise<void> }).respond =
      async (id, response) => {
        responses.push([id, response]);
      };
    const opened: string[] = [];
    thread.subscribe((event) => {
      if (event.type === "request.opened") opened.push(event.request.id);
    });
    session.events.push(approval("a", "npm test"));
    await settle();
    await thread.respond("a", { kind: "approval", optionId: "always" });
    session.events.push(approval("b", "npm test"));
    session.events.push(approval("c", "npm run build"));
    await settle();
    assert.deepEqual(opened, ["a", "c"], "only a different command asks");
    assert.deepEqual(responses.at(-1), ["b", { kind: "approval", optionId: "always" }]);
    await thread.close();
  });

  it("keeps messages in order while slow input handlers run", async () => {
    const { session, thread } = await setup();
    thread.addInputHandler(async (input) => {
      if (input.text === "slow") await new Promise((done) => setTimeout(done, 20));
      return undefined;
    });
    thread.send({ text: "slow" });
    thread.send({ text: "fast" });
    await new Promise((done) => setTimeout(done, 40));
    assert.deepEqual(session.turns, ["slow"]);
    assert.deepEqual(
      thread.queue.map((message) => message.input.text),
      ["fast"],
    );
    await thread.close();
  });

  it("gives the harness each message's ID, and keeps who sent it", async () => {
    const { session, thread } = await setup();
    thread.addInputHandler((input) => ({ text: input.text.toUpperCase() }));
    thread.send({ text: "brief" }, { type: "task", from: "t1", task: "fix it" });
    // The handlers pass it on a tick later, and its turn is running once they have.
    await settle();
    await thread.steer({ text: "hurry" }, { type: "message", from: "t1" });
    assert.deepEqual(session.turns, ["BRIEF"]);
    assert.deepEqual(session.steered, ["HURRY"]);
    const [first, second] = session.sent.map((input) => thread.message(input.id ?? ""));
    // The message keeps what was sent, before the handlers changed it.
    assert.deepEqual(first?.input, { text: "brief" });
    assert.deepEqual(first?.origin, { type: "task", from: "t1", task: "fix it" });
    assert.deepEqual(second?.origin, { type: "message", from: "t1" });
    // Only what the user wrote goes to the harness as theirs.
    await thread.steer({ text: "mine" });
    assert.deepEqual(
      session.sent.map((input) => input.fromUser),
      [false, false, true],
    );
    await thread.close();
  });

  it("drops only the queued messages a filtered clear picks, in the handlers too", async () => {
    const { thread } = await setup();
    const report = { type: "report", from: "t2", status: "completed", result: "ok" } as const;
    thread.send({ text: "work" });
    thread.send({ text: "mine" });
    thread.send({ text: "[1harness] Task" }, report);
    thread.addInputHandler(async () => {
      await new Promise((done) => setTimeout(done, 10));
      return undefined;
    });
    thread.send({ text: "late [1harness] Task" }, report);
    thread.send({ text: "also mine" });
    thread.clearQueue((message) => message.origin.type !== "user");
    await new Promise((done) => setTimeout(done, 40));
    assert.deepEqual(
      thread.queue.map((message) => message.input.text),
      ["mine", "also mine"],
    );
    await thread.close();
  });

  it("takes back the message the user queued last, not a report", async () => {
    const { thread } = await setup();
    thread.send({ text: "work" });
    thread.send({ text: "mine" });
    thread.send(
      { text: "[1harness] Task" },
      { type: "report", from: "t2", status: "failed", result: "boom" },
    );
    assert.equal(thread.unqueue()?.input.text, "mine");
    assert.equal(thread.unqueue(), undefined);
    assert.deepEqual(
      thread.queue.map((message) => message.origin.type),
      ["report"],
    );
    await thread.close();
  });

  it("moves to another session, keeping its notices but not the history it replays", async () => {
    const { session, thread } = await setup();
    const next = new FakeSession();
    next.info.harness = "claude";
    // What a resumed harness sends while starting: the old conversation, and a notice.
    next.events.push({
      type: "item.completed",
      item: { kind: "user_message", id: "old", text: "an old question" },
    });
    next.events.push({
      type: "item.completed",
      item: { kind: "notice", id: "n", level: "warning", text: "runs in supervised" },
    });
    const events: ThreadEvent[] = [];
    thread.subscribe((event) => events.push(event));
    await thread.replaceSession(next as unknown as HarnessSession);
    assert.equal(thread.session, next as unknown as HarnessSession);
    assert.equal(session.events.ended, true);
    const shown = events.flatMap((event) =>
      event.type === "session.replaced"
        ? [`replaced ${event.previous.harness}`]
        : event.type === "item.completed"
          ? [event.item.kind]
          : [],
    );
    assert.deepEqual(shown, ["replaced codex", "notice"]);
    await thread.close();
  });

  it("puts the handoff in front of the next message only, after any harness command", async () => {
    const { thread } = await setup();
    const next = new FakeSession();
    await thread.replaceSession(next as unknown as HarnessSession, { handoff: "HANDOFF" });
    const finish = async (turnId: string) => {
      next.events.push({ type: "turn.started", turnId });
      next.events.push({ type: "turn.ended", turnId, status: "completed", error: null });
      await settle();
    };
    thread.send({ text: "/review" });
    await finish("1");
    thread.send({ text: "go on" });
    await finish("2");
    thread.send({ text: "again" });
    assert.deepEqual(next.turns, ["/review", "HANDOFF\n\ngo on", "again"]);
    // The thread keeps the message as it was sent, for transcripts and records.
    const id = next.sent[1]?.id;
    assert.ok(id);
    assert.equal(thread.message(id)?.input.text, "go on");
    assert.equal(thread.handoff, null);
    await thread.close();
  });

  it("refuses to move while working, and stays put when the new session fails", async () => {
    const { session, thread } = await setup();
    thread.send({ text: "work" });
    await assert.rejects(
      thread.replaceSession(new FakeSession() as unknown as HarnessSession),
      /working/,
    );
    session.events.push({ type: "turn.started", turnId: "1" });
    session.events.push({ type: "turn.ended", turnId: "1", status: "completed", error: null });
    await settle();
    const broken = Object.assign(new FakeSession(), {
      start: () => Promise.reject(new Error("cannot start")),
    });
    const moving = thread.replaceSession(broken as unknown as HarnessSession, { handoff: "H" });
    // A message sent meanwhile waits to see which session runs the thread.
    thread.send({ text: "meanwhile" });
    assert.equal(thread.switching, true);
    assert.equal(thread.idle, false);
    assert.deepEqual(session.turns, ["work"]);
    await assert.rejects(moving, /cannot start/);
    assert.equal(thread.session, session as unknown as HarnessSession);
    assert.deepEqual(session.turns, ["work", "meanwhile"]);
    assert.equal(thread.handoff, null);
    await thread.close();
  });
});
