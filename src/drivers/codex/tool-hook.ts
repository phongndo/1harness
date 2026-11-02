// Codex runs this as 1harness's PreToolUse hook. It passes the call to the
// 1harness session that started Codex, through the address and token in its
// environment, and prints 1harness's answer for Codex. With no answer the call
// goes ahead: 1harness only stops answering when its session is gone.

import { env, stdin, stdout } from "node:process";
import { denyHookOutput } from "../../core/tools.ts";
import { HOOK_TIMEOUT_SEC, LATE_ANSWER } from "./hook-server.ts";

const url = env["ONEHARNESS_HOOK_URL"];
const token = env["ONEHARNESS_HOOK_TOKEN"];
let input = "";
for await (const chunk of stdin) input += String(chunk);
if (url && token) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: input,
      // Before Codex gives up on the hook, which would let the call through.
      signal: AbortSignal.timeout((HOOK_TIMEOUT_SEC - 10) * 1000),
    });
    if (response.ok) stdout.write(await response.text());
  } catch (error) {
    // A session that is there but never answers blocks the call; one that is gone leaves it to Codex.
    if (error instanceof DOMException && error.name === "TimeoutError")
      stdout.write(JSON.stringify(denyHookOutput(LATE_ANSWER)));
  }
}
