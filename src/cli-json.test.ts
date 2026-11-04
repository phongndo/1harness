import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const scripted = new URL("./testing/scripted.ts", import.meta.url).href;
let root: string;
let extension: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1h-json-"));
  mkdirSync(join(root, "work"));
  extension = join(root, "scripted.ts");
  writeFileSync(
    extension,
    `import { ScriptedSession } from ${JSON.stringify(scripted)};
     export default function (api) {
       api.registerDriver({
         id: "scripted", label: "Scripted", unavailable: () => null,
         create: (options) => new ScriptedSession(options),
       });
     }`,
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: join(root, "work"),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
        },
      },
      (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

describe("--print --json", () => {
  it("writes every event as a JSON line, ending with the result", async () => {
    const { code, stdout } = await run(["-p", "--json", "-x", extension, "-H", "scripted", "hi"]);
    assert.equal(code, 0);
    const lines = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const entries = lines
      .filter((line) => line["type"] === "entry")
      .map((line) => (line["entry"] as { type: string }).type);
    assert.ok(entries.includes("turn.started"));
    assert.ok(entries.includes("item"));
    assert.ok(entries.includes("turn.ended"));
    assert.ok(lines.some((line) => line["type"] === "thread"));
    const result = lines.at(-1)!;
    assert.equal(result["type"], "result");
    assert.equal(result["ok"], true);
    assert.equal(result["reply"], "Done with hi");
    assert.equal(result["error"], null);
    assert.equal(typeof result["threadId"], "string");
  });

  it("leaves plain --print as the reply alone", async () => {
    const { code, stdout } = await run(["-p", "-x", extension, "-H", "scripted", "hi"]);
    assert.equal(code, 0);
    assert.equal(stdout, "Done with hi\n");
  });

  it("goes only with --print", async () => {
    const { code, stderr } = await run(["--json", "hi"]);
    assert.notEqual(code, 0);
    assert.match(stderr, /--json goes with --print/);
  });
});
