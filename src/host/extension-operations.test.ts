import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HostClient } from "../client/client.ts";
import { LocalConnection } from "../client/connection.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { Host } from "./host.ts";

let root: string;
let host: Host;
let unregister: () => void;
let made = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-extension-operations-"));
  unregister = registerScripted();
});

afterEach(async () => {
  await host?.shutdown();
});

after(() => {
  unregister();
  rmSync(root, { recursive: true, force: true });
});

interface Setup {
  config: string;
  state: string;
  cwd: string;
  person: HostClient;
}

function setup(options: { settings?: object; modules?: string[] } = {}): Setup {
  const dir = join(root, String(++made));
  const config = join(dir, "config");
  const state = join(dir, "state");
  const cwd = join(dir, "work");
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ harness: "scripted", ...options.settings }),
  );
  host = new Host({
    version: "test",
    cwd,
    configDir: config,
    stateDir: state,
    idleCloseMs: 0,
    store: null,
    extensions: options.modules ?? [],
  });
  const person = new HostClient(
    new LocalConnection(host, `person-${made}`, { owns: false }),
    { cwd, version: "test", extensions: options.modules ?? [] },
    `person-${made}`,
  );
  return { config, state, cwd, person };
}

const op = async (person: HostClient, name: string, input: Record<string, unknown>) =>
  (await person.call("operations.call", { name, input })).result as Record<string, unknown>;

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Never saw ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
};

function module(text: string): string {
  const path = join(root, `module-${++made}.ts`);
  writeFileSync(path, text);
  return path;
}

describe("extensions calling operations", () => {
  it("open and follow a thread from a handler, which a person sees and can open", async () => {
    const path = module(`
      export default function (api) {
        let opened = false;
        api.on("turn.ended", async (_event, context) => {
          if (opened) return;
          opened = true;
          const names = (await api.operations()).map((operation) => operation.name);
          const { threadId } = await api.runOperation("thread_open", { harness: "scripted", title: "Second" });
          await api.runOperation("thread_send", { threadId, message: "look at it" });
          const waited = await api.runOperation("thread_wait", { threadId });
          api.storage.set("result", {
            from: context.threadId,
            threadId,
            canOpen: names.includes("thread_open"),
            reply: waited.latest.result,
          });
        });
      }`);
    const { person, cwd, state } = setup({ modules: [path] });
    const name = path.split("/").at(-1)!.replace(".ts", "");
    const thread = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });
    await person.call("thread.send", { threadId: thread.id, text: "start" });
    const file = join(state, "extensions", `${name}.json`);
    await until(() => {
      try {
        return "result" in (JSON.parse(readFileSync(file, "utf8")) as object);
      } catch {
        return false;
      }
    }, "the extension's result");
    const { result } = JSON.parse(readFileSync(file, "utf8")) as {
      result: { from: string; threadId: string; canOpen: boolean; reply: string };
    };
    assert.equal(result.from, thread.id);
    assert.equal(result.canOpen, true);
    assert.equal(result.reply, "Done with look at it");
    const { threads } = (await op(person, "thread_list", {})) as unknown as {
      threads: { threadId: string; title: string; cwd?: string }[];
    };
    const listed = threads.find((entry) => entry.threadId === result.threadId);
    assert.equal(listed?.title, "Second");
  });

  it("are refused while extensions load, rather than waiting on themselves", async () => {
    const path = module(`
      export default async function (api) {
        try {
          await api.runOperation("harness_list");
          api.storage.set("said", "ran");
        } catch (error) {
          api.storage.set("said", error.message);
        }
      }`);
    const { person, state } = setup({ modules: [path] });
    await person.call("commands.list", { threadId: null });
    const name = path.split("/").at(-1)!.replace(".ts", "");
    const stored = JSON.parse(readFileSync(join(state, "extensions", `${name}.json`), "utf8")) as {
      said: string;
    };
    assert.match(stored.said, /not available while extensions load/);
  });

  it("the review loop has another thread read what a turn changed, and passes on what it found", async () => {
    const path = resolve(import.meta.dirname, "../../examples/extensions/review-loop.ts");
    const { person, cwd, state } = setup({ modules: [path] });
    // The harnesses on this machine are not for tests.
    mkdirSync(join(state, "extensions"), { recursive: true });
    writeFileSync(
      join(state, "extensions", "review-loop.json"),
      JSON.stringify({ harness: "scripted" }),
    );
    const commands = await person.call("commands.list", { threadId: null });
    assert.equal(commands.find((entry) => entry.name === "review-loop")?.shortcut, "alt+r");
    const writer = await person.call("thread.open", {
      harness: "scripted",
      settings: { ...scriptedSettings, cwd },
    });

    // A turn that changes nothing gets no review.
    await person.call("thread.send", { threadId: writer.id, text: "just read it" });
    await until(() => host.manager.get(writer.id)?.runs.at(-1)?.status === "completed", "a run");
    assert.equal(host.manager.list().length, 1);

    await person.call("thread.send", { threadId: writer.id, text: "fix it EDIT" });
    const reviewed = () =>
      host.manager.get(writer.id)?.runs.some((run) => run.input.startsWith("Another agent"));
    await until(() => reviewed() === true, "the review reaching the writer");
    const review = host.manager
      .get(writer.id)!
      .runs.find((run) => run.input.startsWith("Another agent"))!;
    // The scripted reviewer repeats what it was asked, which is how we know what that was.
    assert.match(review.input, /Done with Review the uncommitted changes/);
    assert.match(review.input, /Do not change any files/);
    await until(() => review.status === "completed", "the writer's answer");
    // What the writer did about it changed nothing, so that is the end of it, and the reviewer closed.
    assert.equal(
      host.manager.get(writer.id)!.runs.filter((run) => run.input.startsWith("Another agent"))
        .length,
      1,
    );
    const reviewer = host.manager.list().find((entry) => entry.title === "Review");
    assert.equal(reviewer === undefined || reviewer.status === "closed", true);
  });
});
