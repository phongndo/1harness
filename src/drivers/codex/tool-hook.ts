// Codex runs this as 1harness's PreToolUse hook. It passes the call to the
// 1harness session that started Codex, through the address and token in its
// environment, and prints 1harness's answer for Codex. With no answer the call
// goes ahead: 1harness only stops answering when its session is gone.

import { env, stdin, stdout } from "node:process";

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
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) stdout.write(await response.text());
  } catch {
    // Unreachable or slow: leave the decision to Codex.
  }
}
