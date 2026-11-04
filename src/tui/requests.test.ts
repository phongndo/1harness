import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { HostClient } from "../client/client.ts";
import type { ApprovalRequest } from "../core/events.ts";
import type { ThreadState } from "../protocol.ts";
import { Requests } from "./requests.ts";

/** Opens an approval to run `command`, and says what enter answers and what the prompt shows. */
async function answerAtOnce(command: string) {
  const answers: unknown[] = [];
  const client = {
    call: async (_method: string, params: { response: unknown }) => answers.push(params.response),
  } as unknown as HostClient;
  const requests = new Requests({
    client,
    currentId: () => "thread",
    typedAt: () => 0,
    prompted() {},
    notice() {},
    schedule() {},
  });
  const request: ApprovalRequest = {
    kind: "approval",
    id: "ask",
    title: "Run this command?",
    detail: `$ ${command}`,
    action: { type: "command", command, cwd: null },
    options: [
      { id: "yes", label: "Yes", effect: "allow" },
      { id: "no", label: "No", effect: "deny" },
    ],
    defaultOptionId: "yes",
  };
  requests.sync({ id: "thread", requests: [request] } as unknown as ThreadState);
  const shown = requests
    .prompt!.render(80)
    .rows.map((row) => stripVTControlCharacters(row))
    .join("\n");
  requests.key({ name: "return", ctrl: false, meta: false, shift: false, text: "" }, 1000);
  await new Promise(setImmediate);
  return { shown, answer: answers[0] };
}

describe("an approval", () => {
  it("warns of a command that can lose work, and starts on refusing it", async () => {
    const { shown, answer } = await answerAtOnce("rm -rf dist");
    assert.match(shown, /⚠ Deletes files/);
    // Selected, the hint line says what the row would.
    assert.doesNotMatch(shown, /No +tab to say why/);
    assert.match(shown, /tab say why/);
    assert.deepEqual(answer, { kind: "approval", optionId: "no" });
  });

  it("marks the selected choice, and says what refusing does and how to say why", async () => {
    const { shown } = await answerAtOnce("pnpm test");
    assert.match(shown, /› 1 {2}Yes/);
    assert.match(shown, /No +tab to say why; the agent goes on/);
    assert.match(shown, /esc refuse/);
  });

  it("starts where the harness says for any other command", async () => {
    const { shown, answer } = await answerAtOnce("pnpm test");
    assert.doesNotMatch(shown, /⚠/);
    assert.deepEqual(answer, { kind: "approval", optionId: "yes" });
  });
});
