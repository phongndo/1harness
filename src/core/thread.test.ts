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
import { Thread } from "./thread.ts";

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
  steerFails = false;

  async start(): Promise<void> {}
  async startTurn(input: UserInput): Promise<void> {
    this.turns.push(input.text);
  }
  async steer(input: UserInput): Promise<void> {
    if (this.steerFails) throw new Error("turn ended");
    this.steered.push(input.text);
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
      thread.queue.map((input) => input.text),
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
      thread.queue.map((input) => input.text),
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
      thread.queue.map((input) => input.text),
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
      thread.queue.map((input) => input.text),
      ["fast"],
    );
    await thread.close();
  });
});
