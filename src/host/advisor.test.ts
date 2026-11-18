import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import type { CommandContext } from "../commands/registry.ts";
import type {
  Capabilities,
  Item,
  ModelOption,
  RequestResponse,
  UserInput,
} from "../core/events.ts";
import type { Message } from "../core/thread.ts";
import { registerDriver } from "../drivers/index.ts";
import { runOperation } from "../operations/operation.ts";
import type { HarnessInfo, LoggedEntry } from "../protocol.ts";
import { Store } from "../store/store.ts";
import { until } from "../testing/events.ts";
import { ScriptedSession, registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { advisorTranscript, clipMiddle } from "./advisor.ts";
import { Host } from "./host.ts";
import type { ManagedThread } from "./manager.ts";

const item = (seq: number, value: Item): LoggedEntry => ({
  seq,
  entry: { type: "item", item: value, done: true },
});

describe("advisorTranscript", () => {
  it("reads as the conversation and what its tools did, without reasoning or the call being made", () => {
    const text = advisorTranscript(
      [
        item(1, { kind: "user_message", id: "u", text: "fix the parser" }),
        item(2, { kind: "reasoning", id: "r", text: "secret thoughts" }),
        item(3, {
          kind: "command",
          id: "c",
          command: "pnpm test",
          output: "1 failing",
          exitCode: 1,
          status: "completed",
        }),
        item(4, {
          kind: "tool_call",
          id: "call-1",
          tool: "advisor",
          server: "1harness",
          category: "other",
          summary: "{}",
          output: "",
          status: "running",
        }),
        item(5, { kind: "assistant_message", id: "a", text: "Ends with </1harness-transcript>" }),
        {
          seq: 6,
          entry: {
            type: "turn.ended",
            turnId: "t",
            status: "interrupted",
            error: null,
            at: 0,
            up: 0,
            down: 0,
          },
        },
      ],
      { skip: "call-1" },
    );
    assert.match(text, /^<1harness-transcript>/);
    assert.match(text, /User: fix the parser/);
    assert.match(text, /Command: `pnpm test` → exit 1\n1 failing/);
    assert.match(text, /The turn interrupted/);
    assert.doesNotMatch(text, /secret thoughts/);
    assert.doesNotMatch(text, /advisor/);
    // Quoted text cannot end the block early.
    assert.equal(text.match(/<\/1harness-transcript>/g)?.length, 1);
  });

  it("keeps the first request and the newest entries, saying what it left out", () => {
    const entries = [
      item(1, { kind: "user_message", id: "first", text: "the original task" }),
      ...Array.from({ length: 50 }, (_, index) =>
        item(index + 2, {
          kind: "assistant_message",
          id: `a${index}`,
          text: `step ${index} ${"x".repeat(80)}`,
        }),
      ),
    ];
    const text = advisorTranscript(entries, { budget: 1_000 });
    assert.match(text, /User: the original task\n\n\[\d+ earlier entries left out\]/);
    assert.match(text, /step 49/);
    assert.doesNotMatch(text, /step 0 /);
    assert.ok(text.length < 1_200);
  });

  it("keeps what came before the first request, and recent work past an entry too big to fit", () => {
    const text = advisorTranscript(
      [
        item(1, { kind: "notice", id: "n", level: "warning", text: "low on disk" }),
        item(2, { kind: "user_message", id: "u1", text: "fix the parser" }),
        item(3, { kind: "user_message", id: "u2", text: "and keep the old API" }),
        item(4, {
          kind: "file_change",
          id: "f",
          changes: Array.from({ length: 20 }, (_, index) => ({
            path: `file${index}.ts`,
            kind: "update" as const,
            diff: "+".repeat(3_000),
          })),
          status: "completed",
        }),
      ],
      { budget: 8_000 },
    );
    assert.match(text, /Notice \(warning\): low on disk/);
    assert.match(text, /User: and keep the old API/);
    assert.match(text, /File change:\nupdate file0\.ts/);
    assert.ok(text.length < 9_000);
  });

  it("says when a message had images, which the advisor does not see", () => {
    const message = {
      id: "m",
      input: { text: "what is wrong here?", images: ["/tmp/a.png", "/tmp/b.png"] },
      origin: { type: "user" },
    } as Message;
    const text = advisorTranscript([
      {
        seq: 1,
        entry: {
          type: "item",
          item: { kind: "user_message", id: "u", text: "what is wrong here?" },
          done: true,
          message,
        },
      },
    ]);
    assert.match(text, /User: what is wrong here\?\n\[2 images attached, not shown\]/);
  });

  it("clips long output in the middle, keeping both ends", () => {
    const clipped = clipMiddle(`start${"-".repeat(5_000)}end`, 100);
    assert.match(clipped, /^start/);
    assert.match(clipped, /end$/);
    assert.match(clipped, /characters cut/);
  });
});

let root: string;
let host: Host | undefined;
let unregister: () => void;
let made = 0;

/** A scripted harness whose one model has efforts to choose from. */
class EffortfulSession extends ScriptedSession {
  override async listModels(): Promise<ModelOption[]> {
    return [
      {
        id: "deep",
        aliases: [],
        label: "Deep",
        description: "thinks",
        efforts: ["low", "high"],
        defaultEffort: "low",
        isDefault: true,
      },
    ];
  }
}

/** How each approval a recording session asked for was answered. */
const answered: RequestResponse[] = [];

/** A scripted harness that remembers how its approvals were answered. */
class RecordingSession extends ScriptedSession {
  override async respond(requestId: string, response: RequestResponse): Promise<void> {
    answered.push(response);
    await super.respond(requestId, response);
  }
}

/** A harness with no permission modes, as some ACP agents are, which nothing holds back. */
class ModelessSession extends ScriptedSession {
  override readonly capabilities: Capabilities = {
    steer: false,
    planMode: false,
    runtimeModes: [],
    images: false,
    toolChecks: false,
    nativeSlashCommands: false,
    mcpActions: [],
  };
}

/** A model as the fallback harness lists it, `big` its default. */
const fallbackOption = (id: string): ModelOption => ({
  id,
  aliases: [],
  label: id,
  description: "",
  efforts: [],
  defaultEffort: null,
  isDefault: id === "big",
});

/** A harness that lists the model asked for but runs its own, as one that falls back might. */
class FallbackSession extends ScriptedSession {
  constructor(options: ConstructorParameters<typeof ScriptedSession>[0]) {
    super(options);
    this.info.model = "big";
  }

  override async listModels(): Promise<ModelOption[]> {
    return [fallbackOption("big"), fallbackOption("huge")];
  }
}

/** A harness that works on every message until it is interrupted. */
class HangingSession extends ScriptedSession {
  #turn = 0;

  override async startTurn(input: UserInput): Promise<void> {
    this.prompts.push(input.text);
    this.events.push({ type: "turn.started", turnId: `hang-${++this.#turn}` });
  }

  override async interrupt(): Promise<void> {
    this.events.push({
      type: "turn.ended",
      turnId: `hang-${this.#turn}`,
      status: "interrupted",
      error: null,
    });
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-advisor-"));
  const removers = [
    registerScripted(),
    ...(
      [
        ["effortful", EffortfulSession],
        ["recording", RecordingSession],
        ["modeless", ModelessSession],
        ["hanging", HangingSession],
        ["fallback", FallbackSession],
      ] as const
    ).map(([id, Session]) =>
      registerDriver({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        unavailable: () => null,
        create: (options) => new Session(options),
      }),
    ),
  ];
  unregister = () => {
    for (const remove of removers) remove();
  };
});

afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

function setup(
  settings: object = {},
  options: { store?: Store; modules?: string[]; dir?: string } = {},
) {
  const dir = options.dir ?? join(root, String(++made));
  const config = join(dir, "config");
  const cwd = join(dir, "work");
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ harness: "scripted", ...settings }),
  );
  const started = new Host({
    version: "test",
    cwd,
    configDir: config,
    stateDir: join(dir, "state"),
    idleCloseMs: 0,
    store: options.store ?? null,
    extensions: options.modules ?? [],
  });
  host = started;
  const person = new HostClient(
    new LocalConnection(started, `person-${made}`, { owns: false }),
    { cwd, version: "test", extensions: options.modules ?? [] },
    `person-${made}`,
  );
  const op = async (name: string, input: Record<string, unknown> = {}) =>
    (await person.call("operations.call", { name, input })).result;
  const open = async (harness = "scripted") => {
    const opened = await person.call("thread.open", {
      harness,
      settings: { ...scriptedSettings, cwd },
    });
    return started.manager.get(opened.id)!;
  };
  /** The advisor threads started under `caller`, as they are created. */
  const advisors = (caller: ManagedThread) => {
    const found: ManagedThread[] = [];
    started.manager.subscribe((event) => {
      if (event.type === "thread.created" && event.thread.parentId === caller.id)
        found.push(event.thread);
    });
    return found;
  };
  return { host: started, person, op, cwd, config, dir, open, advisors };
}

const agent = (thread: ManagedThread) => ({
  kind: "agent" as const,
  thread: thread.thread,
  callId: null,
});

async function toolNames(started: Host): Promise<string[]> {
  const grant = await started.tools.grant();
  assert.ok(grant && grant.config.type === "http");
  try {
    const response = await fetch(grant.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...grant.config.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((tool) => tool.name);
  } finally {
    grant.revoke();
  }
}

describe("the advisor tool", () => {
  it("is offered, by name, only while an advisor is chosen", async () => {
    const { host: started, op } = setup();
    assert.equal((await toolNames(started)).includes("advisor"), false);
    assert.deepEqual(await op("advisor_set", { harness: "scripted" }), {
      advisor: { harness: "scripted", model: null, effort: null },
      reload: true,
    });
    assert.ok((await toolNames(started)).includes("advisor"));
    assert.deepEqual(await op("advisor_get"), {
      advisor: { harness: "scripted", model: null, effort: null },
    });
    await assert.rejects(op("advisor_set", { harness: "nowhere" }), /no harness named nowhere/);
  });

  it("sends the advisor the caller's conversation, returns its advice, and closes its thread", async () => {
    const {
      host: started,
      person,
      cwd,
    } = setup({
      advisor: { harness: "scripted", model: "big", effort: null },
    });
    const opened = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    await person.call("thread.send", { threadId: opened.id, text: "fix the parser" });
    const caller = started.manager.get(opened.id)!;
    await until(() => caller.runs[0]?.status === "completed", "the first turn");

    let child: ManagedThread | undefined;
    const refusals: Promise<unknown>[] = [];
    started.manager.subscribe((event) => {
      if (event.type === "thread.created" && event.thread.parentId === opened.id)
        child = event.thread;
      // While it advises, it may neither hand work on nor consult an advisor of its own.
      if (
        event.type === "thread.updated" &&
        event.thread === child &&
        child.status === "working" &&
        refusals.length === 0
      )
        for (const name of ["delegate_task", "advisor"])
          refusals.push(
            runOperation(
              started.operations.find((operation) => operation.name === name),
              name,
              { task: "more" },
              { kind: "agent", thread: child.thread, callId: null },
            ).then(
              () => "allowed",
              (error: Error) => error.message,
            ),
          );
    });
    const advisor = started.operations.find((operation) => operation.name === "advisor");
    const advice = (await runOperation(
      advisor,
      "advisor",
      { question: "is this right?" },
      { kind: "agent", thread: caller.thread, callId: null },
    )) as string;
    // The scripted harness answers with what it was sent.
    assert.match(advice, /^Advice from scripted · big:/);
    assert.match(advice, /User: fix the parser/);
    assert.match(advice, /Agent: Done with fix the parser/);
    assert.match(advice, /The agent asks: is this right\?/);
    assert.doesNotMatch(advice, /Reading the parser/);
    // It ran on the chosen model, narrowly, and closed once it answered.
    assert.ok(child);
    assert.equal(child.thread.info.model, "big");
    assert.equal(child.thread.info.runtimeMode, "supervised");
    assert.equal(child.status, "closed");
    // Its records kept the question, not another copy of the conversation, and are dropped now.
    assert.equal(child.runs[0]?.input, "is this right?");
    assert.equal(child.ephemeral, true);
    const gone = child.id;
    await until(() => started.manager.get(gone) === undefined, "the advisor dropped");
    const refused = await Promise.all(refusals);
    assert.match(refused[0] as string, /an advisor advises; it does not delegate/);
    assert.match(refused[1] as string, /an advisor cannot consult an advisor/);
  });

  it("declines what the advisor asks to do before any extension can approve it", async () => {
    const approver = join(root, "approve.mjs");
    writeFileSync(
      approver,
      `export default (api) => api.onRequest((request) =>
        request.kind === "approval" ? { kind: "approval", optionId: "yes" } : undefined);\n`,
    );
    const { host: started, open } = setup({}, { modules: [approver] });
    const caller = await open();
    answered.length = 0;
    // The scripted harness asks for an approval for a message ending in ASK.
    const { advice } = await started.orchestrator.advise(
      caller,
      { harness: "recording", model: null, effort: null },
      { text: "check this ASK", summary: "check this" },
      null,
      5_000,
    );
    assert.equal(advice, "Done with check this ASK");
    assert.equal(answered[0]?.kind, "decline");
  });

  it("sends nothing to a model other than the one chosen", async () => {
    const { host: started, open, advisors } = setup();
    const caller = await open();
    const created = advisors(caller);
    await assert.rejects(
      started.orchestrator.advise(
        caller,
        { harness: "scripted", model: "huge", effort: null },
        { text: "the conversation", summary: "q" },
        null,
      ),
      /scripted offers no model huge, so nothing was sent/,
    );
    assert.equal(created[0]?.runs.length, 0);
    assert.equal(created[0]?.status, "closed");
  });

  it("sends nothing to a harness that would run another model than the one chosen", async () => {
    const { host: started, open, advisors } = setup();
    const caller = await open();
    const created = advisors(caller);
    await assert.rejects(
      started.orchestrator.advise(
        caller,
        { harness: "fallback", model: "huge", effort: null },
        { text: "the conversation", summary: "q" },
        null,
      ),
      /fallback would advise on big, not huge, so nothing was sent/,
    );
    assert.equal(created[0]?.runs.length, 0);
  });

  it("stops advising once the turn asking ends", async () => {
    const { host: started, person, open, advisors } = setup();
    const caller = await open("hanging");
    await person.call("thread.send", { threadId: caller.id, text: "work" });
    await until(() => caller.runs[0]?.status === "running", "the caller's turn");
    const found = advisors(caller);
    const asked = started.orchestrator
      .advise(
        caller,
        { harness: "hanging", model: null, effort: null },
        { text: "the conversation", summary: "q" },
        null,
      )
      .then(
        () => "advised",
        (error: Error) => error.message,
      );
    await until(() => found[0]?.status === "working", "the advisor working");
    await caller.thread.interrupt();
    assert.match(await asked, /the turn asking for advice has ended/);
    const child = found[0]!;
    await until(() => started.manager.get(child.id) === undefined, "the advisor dropped");
  });

  it("refuses a harness with no modes, which nothing would keep to reading", async () => {
    const { host: started, open } = setup();
    await assert.rejects(
      started.orchestrator.advise(
        await open(),
        { harness: "modeless", model: null, effort: null },
        { text: "the conversation", summary: "q" },
        null,
      ),
      /modeless has no permission modes/,
    );
  });

  it("stops advising once the thread asking closes", async () => {
    const { host: started, open, advisors } = setup();
    const caller = await open();
    const found = advisors(caller);
    const asked = started.orchestrator
      .advise(
        caller,
        { harness: "hanging", model: null, effort: null },
        { text: "the conversation", summary: "q" },
        null,
      )
      .then(
        () => "advised",
        (error: Error) => error.message,
      );
    await until(() => found[0]?.status === "working", "the advisor working");
    await started.manager.close(caller.id);
    assert.match(await asked, /the turn asking for advice has ended/);
    const child = found[0]!;
    await until(() => started.manager.get(child.id) === undefined, "the advisor dropped");
  });

  it("stores nothing of the advisor, so a restart brings none back", async () => {
    const dir = join(root, String(++made));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "1harness.db");
    const first = setup(
      { advisor: { harness: "scripted", model: null, effort: null } },
      { store: Store.open(file), dir },
    );
    const caller = await first.open();
    await first.person.call("thread.send", { threadId: caller.id, text: "fix the parser" });
    await until(() => caller.runs[0]?.status === "completed", "the first turn");
    const found = first.advisors(caller);
    await runOperation(
      first.host.operations.find((operation) => operation.name === "advisor"),
      "advisor",
      {},
      agent(caller),
    );
    const child = found[0]!;
    await until(() => first.host.manager.get(child.id) === undefined, "the advisor dropped");
    await first.host.shutdown();
    host = undefined;

    const store = Store.open(file);
    assert.equal(store.thread(child.id), null);
    assert.deepEqual(store.log(child.id), []);
    assert.ok(store.thread(caller.id));
    // The caller's transcript points at no thread that is not there.
    assert.ok(store.log(caller.id).every(({ entry }) => entry.type !== "agent"));
    store.close();
    const second = setup({}, { store: Store.open(file), dir });
    await second.host.start();
    assert.deepEqual(
      second.host.manager.list().map((thread) => thread.id),
      [caller.id],
    );
  });

  it("says how to choose an advisor when none is", async () => {
    const { host: started, person, cwd } = setup();
    const opened = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    const advisor = started.operations.find((operation) => operation.name === "advisor");
    await assert.rejects(
      runOperation(
        advisor,
        "advisor",
        {},
        {
          kind: "agent",
          thread: started.manager.get(opened.id)!.thread,
          callId: null,
        },
      ),
      /\/advisor sets one/,
    );
  });
});

describe("harness_models", () => {
  it("lists a harness's models with no thread running on it", async () => {
    const { op } = setup();
    const models = (await op("harness_models", { harness: "scripted" })) as { id: string }[];
    assert.deepEqual(
      models.map((model) => model.id),
      ["big"],
    );
  });
});

/** A harness that can run. */
const ready = (id: string, label: string): HarnessInfo => ({
  id,
  label,
  state: "ready",
  detail: null,
  unavailable: null,
  path: null,
});

describe("/advisor", () => {
  const command = BUILTIN_COMMANDS.find((entry) => entry.name === "advisor")!;
  const harnesses: HarnessInfo[] = [
    ready("scripted", "Scripted"),
    ready("effortful", "Effortful"),
    {
      ...ready("gone", "Gone"),
      state: "missing",
      detail: "not installed",
      unavailable: "Gone is not installed",
    },
  ];

  /** A context whose picks choose `picks` in turn, keeping what each was offered. */
  function context(
    op: (name: string, input: Record<string, unknown>) => Promise<unknown>,
    picks: number[] = [],
  ) {
    const notices: string[] = [];
    const offered: { title: string; labels: string[] }[] = [];
    const value = {
      thread: null,
      harnesses: () => harnesses,
      checkHarnesses: async () => harnesses,
      forget: () => {},
      fetch: (_key: string, load: () => Promise<unknown[]>) => load(),
      ui: {
        notify: (_level: string, text: string) => notices.push(text),
        progress: () => () => {},
        pick: async (title: string, entries: { label: string }[]) => {
          offered.push({ title, labels: entries.map((entry) => entry.label) });
          return picks.shift() ?? null;
        },
      },
      runOperation: op,
    } as unknown as CommandContext;
    return { value, notices, offered };
  }

  it("walks from a harness to its models to their efforts", async () => {
    const { op, config } = setup();
    // effortful, then its model Deep, then high.
    const { value, notices, offered } = context(op, [2, 1, 2]);
    await command.run(value, "");
    assert.deepEqual(offered, [
      { title: "Advisor harness", labels: ["off", "scripted", "effortful", "gone"] },
      { title: "Advisor model on Effortful", labels: ["default", "Deep"] },
      { title: "Advisor effort", labels: ["default", "low", "high"] },
    ]);
    assert.deepEqual(
      (JSON.parse(readFileSync(join(config, "settings.json"), "utf8")) as Record<string, unknown>)[
        "advisor"
      ],
      { harness: "effortful", model: "deep", effort: "high" },
    );
    assert.match(notices[0] ?? "", /^Advisor: effortful · deep · high\./);
  });

  it("completes words that need nothing after them, so enter runs what is typed", () => {
    const models: ModelOption[] = [
      {
        id: "deep",
        aliases: [],
        label: "Deep",
        description: "",
        efforts: ["low", "high"],
        defaultEffort: "low",
        isDefault: true,
      },
    ];
    const value = {
      harness: "scripted",
      thread: null,
      harnesses: () => harnesses,
      lookup: () => models,
    } as unknown as CommandContext;
    const harnessWords = command.complete!(value, "")!.items;
    assert.deepEqual(
      harnessWords.map((word) => word.value),
      ["scripted", "effortful", "gone", "off"],
    );
    const modelWords = command.complete!(value, "scripted ")!.items;
    const effortWords = command.complete!(value, "scripted deep ")!.items;
    assert.deepEqual(
      effortWords.map((word) => word.value),
      ["low", "high"],
    );
    for (const word of [...harnessWords, ...modelWords, ...effortWords])
      assert.equal(word.more, false, word.value);
    // Another harness's models would take starting it; the picker lists them.
    assert.deepEqual(command.complete!(value, "effortful ")!.items, []);
  });

  it("refuses a harness that cannot run, picked or named", async () => {
    const { op } = setup();
    await assert.rejects(
      Promise.resolve(command.run(context(op, [3]).value, "")),
      /Gone cannot advise: Gone is not installed/,
    );
    await assert.rejects(
      Promise.resolve(command.run(context(op).value, "gone")),
      /Gone cannot advise/,
    );
  });

  it("names a harness, model, and effort, or turns the advisor off", async () => {
    const { op, config } = setup();
    const { value, notices } = context(op);
    const saved = () =>
      (JSON.parse(readFileSync(join(config, "settings.json"), "utf8")) as Record<string, unknown>)[
        "advisor"
      ];
    await command.run(value, "scripted big high");
    assert.deepEqual(saved(), { harness: "scripted", model: "big", effort: "high" });
    assert.match(
      notices[0] ?? "",
      /^Advisor: scripted · big · high\. .*\/reload gives it to this one/,
    );
    await command.run(value, "scripted");
    assert.deepEqual(saved(), { harness: "scripted", model: null, effort: null });
    // Already on, so no reload is needed for the tool.
    assert.equal(notices[1], "Advisor: scripted · default model.");
    await command.run(value, "off");
    assert.equal(saved(), null);
    assert.match(notices[2] ?? "", /^Advisor off\. \/reload takes/);
    await assert.rejects(
      Promise.resolve(command.run(value, "nowhere")),
      /No harness named nowhere/,
    );
  });
});
