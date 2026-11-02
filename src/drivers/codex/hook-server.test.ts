import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ANSWER_WITHIN_MS, HOOK_TIMEOUT_SEC, HookServer, LATE_ANSWER } from "./hook-server.ts";

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

  it("blocks a call whose check is still running when its time is up", async () => {
    // Codex lets the call through once it gives up on the hook, so 1harness answers first.
    assert.ok(ANSWER_WITHIN_MS < HOOK_TIMEOUT_SEC * 1000);
    // Node's fetch fails after 300s without headers, which the hook takes for 1harness being gone.
    assert.ok(HOOK_TIMEOUT_SEC * 1000 < 300_000);
    const server = await HookServer.start(() => new Promise(() => {}), 50);
    try {
      const output = await runHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
        { ONEHARNESS_HOOK_URL: server.url, ONEHARNESS_HOOK_TOKEN: server.token },
      );
      assert.deepEqual(JSON.parse(output), {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: LATE_ANSWER,
        },
      });
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
