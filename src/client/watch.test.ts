import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { Host } from "../host/host.ts";
import { registerScripted, scriptedSettings } from "../testing/scripted.ts";
import { HostClient } from "./client.ts";
import { LocalConnection } from "./connection.ts";
import { watch } from "./watch.ts";

const settle = (ms = 10) => new Promise((done) => setTimeout(done, ms));

/** What `watch` writes, with the screen as its last frame left it. */
class Out {
  written = "";
  write(data: string): boolean {
    this.written += data;
    return true;
  }
  /** The last frame: what follows the last clear-screen, program status records removed. */
  get frame(): string {
    const last = this.written.split("\x1b[H\x1b[2J").at(-1) ?? "";
    // oxlint-disable-next-line no-control-regex
    return last.replace(/\x1b\]7501;[^\x1b]*\x1b\\/g, "");
  }
}

async function until(out: Out, pattern: RegExp): Promise<string> {
  for (let tries = 0; tries < 300; tries++) {
    if (pattern.test(out.frame)) return out.frame;
    await settle(10);
  }
  throw new Error(`watch never showed ${String(pattern)}:\n${out.frame}`);
}

describe("watch", () => {
  let root: string;
  let unregister: () => void;
  let host: Host;
  const status = process.env["ONEHARNESS_PROGRAM_STATUS"];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "1harness-watch-"));
    unregister = registerScripted();
  });

  after(() => {
    unregister();
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (status === undefined) delete process.env["ONEHARNESS_PROGRAM_STATUS"];
    else process.env["ONEHARNESS_PROGRAM_STATUS"] = status;
    await host.shutdown();
  });

  function client(id: string): HostClient {
    return new HostClient(
      new LocalConnection(host, id, { owns: false }),
      { cwd: root, version: "test", extensions: [] },
      id,
    );
  }

  function startHost(): void {
    host = new Host({
      version: "test",
      cwd: root,
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      idleCloseMs: 0,
    });
  }

  it("lists the host's threads with what each is doing, until a signal stops it", async () => {
    process.env["ONEHARNESS_PROGRAM_STATUS"] = "0";
    startHost();
    const user = client("user");
    await user.connect();
    const thread = await user.call("thread.open", {
      harness: "scripted",
      settings: scriptedSettings,
    });
    const out = new Out();
    const watching = watch(client("watch"), out as unknown as NodeJS.WriteStream);
    const first = await until(out, /1 thread/);
    assert.match(
      first,
      new RegExp(`^1harness · 1 thread\\n\\n${thread.id}\\s+idle\\s+scripted\\s+`),
    );
    await user.call("thread.send", { threadId: thread.id, text: "please ASK" });
    const waiting = await until(out, /needs you/);
    assert.match(
      waiting,
      new RegExp(`${thread.id}\\s+needs you\\s+scripted\\s+.* · needs approval`),
    );
    // Without program status, it writes only the list.
    assert.ok(!out.written.includes("\x1b]7501;"));
    process.emit("SIGINT");
    await watching;
    assert.ok(out.written.endsWith("\n"));
    await user.close();
  });

  it("reports each thread as a program status record where the terminal takes them", async () => {
    delete process.env["ONEHARNESS_PROGRAM_STATUS"];
    startHost();
    const user = client("user");
    await user.connect();
    await user.call("thread.open", { harness: "scripted", settings: scriptedSettings });
    const out = new Out();
    const watching = watch(client("watch"), out as unknown as NodeJS.WriteStream);
    await until(out, /1 thread/);
    assert.ok(out.written.includes("\x1b]7501;"));
    process.emit("SIGTERM");
    await watching;
    await user.close();
  });
});
