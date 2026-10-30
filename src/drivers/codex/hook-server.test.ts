import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { HookServer } from "./hook-server.ts";

const SCRIPT = fileURLToPath(new URL("./tool-hook.ts", import.meta.url));

/** Runs the hook script as Codex would: input on stdin, output from stdout. */
function runHook(input: object, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, ...env } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(JSON.stringify(input));
  });
}

describe("Codex tool hook", () => {
  it("passes the call to 1harness and prints its answer", async () => {
    const seen: unknown[] = [];
    const server = await HookServer.start(async (input) => {
      seen.push(input);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };
    });
    try {
      const output = await runHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sudo ls" } },
        { ONEHARNESS_HOOK_URL: server.url, ONEHARNESS_HOOK_TOKEN: server.token },
      );
      assert.deepEqual(JSON.parse(output), {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
      assert.equal((seen[0] as { tool_name: string }).tool_name, "Bash");
      const wrongToken = await runHook(
        {},
        { ONEHARNESS_HOOK_URL: server.url, ONEHARNESS_HOOK_TOKEN: "x" },
      );
      assert.equal(wrongToken, "", "a refused call leaves the decision to Codex");
    } finally {
      await server.close();
    }
  });

  it("stays silent when 1harness is gone", async () => {
    const output = await runHook(
      {},
      { ONEHARNESS_HOOK_URL: "http://127.0.0.1:9/hook", ONEHARNESS_HOOK_TOKEN: "t" },
    );
    assert.equal(output, "");
  });
});
