import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { JsonRpcPeer, JsonRpcProcess } from "./jsonrpc.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-jsonrpc-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function peer(name: string, source: string): JsonRpcProcess {
  const script = join(root, `${name}.mjs`);
  writeFileSync(script, source);
  return new JsonRpcProcess(process.execPath, [script], {
    cwd: root,
    env: process.env,
    name,
  });
}

describe("JsonRpcPeer", () => {
  it("ignores malformed messages and keeps reading the next notification", () => {
    const input = new PassThrough();
    const rpc = new JsonRpcPeer(input, () => {}, { name: "test", jsonrpc: true });
    const heard: string[] = [];
    rpc.onNotification((method) => heard.push(method));
    try {
      assert.doesNotThrow(() => {
        for (const value of [null, [], 42, "text", { method: 7 }, { id: {}, method: "bad" }])
          input.write(`${JSON.stringify(value)}\n`);
        input.write('{"method":"good"}\n');
      });
      assert.deepEqual(heard, ["good"]);
    } finally {
      input.end();
    }
  });
});

describe("JsonRpcProcess", () => {
  it("survives handlers that throw, and answers a request whose handler threw", async () => {
    // The peer sends a notification and a request, then echoes the answer back.
    const rpc = peer(
      "thrower",
      `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ method: "boom", params: {} });
send({ id: "r1", method: "ask", params: {} });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === "r1") send({ method: "answered", params: message });
}
`,
    );
    try {
      const errors: string[] = [];
      rpc.peer.onError((error) => errors.push(String(error)));
      const answered = new Promise<unknown>((resolve) => {
        rpc.peer.onNotification((method, params) => {
          if (method === "answered") resolve(params);
          else throw new TypeError("Cannot read properties of undefined (reading 'text')");
        });
      });
      rpc.peer.onRequest(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'type')");
      });
      const reply = (await answered) as { error: { code: number; message: string } };
      assert.equal(reply.error.code, -32603);
      assert.match(reply.error.message, /reading 'type'/);
      assert.equal(errors.length, 2);
      assert.match(errors[0] ?? "", /reading 'text'/);
      assert.match(errors[1] ?? "", /reading 'type'/);
    } finally {
      await rpc.close();
    }
  });

  it("refuses a request once the process has exited", async () => {
    const rpc = peer("quitter", "process.exit(3);\n");
    await rpc.exited;
    const late = rpc.peer.request("ping", {});
    const timeout = new Promise((resolve) => setTimeout(resolve, 1_000, "still waiting"));
    const outcome = await Promise.race([
      late.then(
        () => "answered",
        (error: unknown) => String(error),
      ),
      timeout,
    ]);
    assert.match(String(outcome), /quitter exited \(code 3\)/);
  });
});
