import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "node:test";
import type { HostClient } from "../client/client.ts";
import type { ApprovalOption, ApprovalRequest } from "../core/events.ts";
import type { ThreadState } from "../protocol.ts";
import { ChoicePrompt } from "./prompt.ts";
import { Requests } from "./requests.ts";

/** Opens an approval to run `command`, and says what enter answers and what the prompt shows. */
async function answerAtOnce(
  command: string,
  options: readonly ApprovalOption[] = [
    { id: "yes", label: "Yes", effect: "allow" },
    { id: "no", label: "No", effect: "deny" },
  ],
  cwd: string | null = null,
) {
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
    action: { type: "command", command, cwd },
    options: [...options],
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
    assert.doesNotMatch(shown, /No +tab gives a reason/);
    assert.match(shown, /tab add a reason/);
    assert.deepEqual(answer, { kind: "approval", optionId: "no" });
  });

  it("marks the selected choice, and says what refusing does and how to say why", async () => {
    const { shown } = await answerAtOnce("pnpm test");
    assert.match(shown, /› 1 {2}Yes/);
    assert.match(shown, /No +tab gives a reason; the agent goes on/);
    assert.match(shown, /esc refuse/);
  });

  it("never offers to allow for good a command that can lose work", async () => {
    const options = [
      { id: "yes", label: "Yes", effect: "allow" },
      { id: "always", label: "Yes, always", effect: "allow-always" },
      { id: "no", label: "No", effect: "deny" },
    ] as const;
    const risky = await answerAtOnce("rm -rf dist", options, "/work/app");
    assert.doesNotMatch(risky.shown, /always/);
    assert.match(risky.shown, /⚠ Deletes files, which may not come back · in app/);
    assert.deepEqual(risky.answer, { kind: "approval", optionId: "no" });
    const routine = await answerAtOnce("pnpm test", options, "/work/app");
    assert.match(routine.shown, /Yes, always/);
  });

  it("keeps the warning to a line, with the folder under it where it will not fit", () => {
    const prompt = new ChoicePrompt(
      {
        header: "Permission needed",
        tag: "",
        title: "Run?",
        warning: "Deletes files, which may not come back",
        where: "in parser-app",
        detail: [],
        options: [{ label: "No", description: "" }],
        multiSelect: false,
        allowOther: false,
        secret: false,
        initial: 0,
        commentable: () => false,
      },
      () => {},
    );
    const at = (width: number) =>
      prompt.render(width).rows.map((row) => stripVTControlCharacters(row));
    assert.ok(at(80).some((row) => row.endsWith("come back · in parser-app")));
    const narrow = at(50);
    const warned = narrow.findIndex((row) => row.includes("⚠"));
    assert.equal(narrow[warned], "  ⚠ Deletes files, which may not come back");
    assert.equal(narrow[warned + 1], "  in parser-app");
  });

  it("starts where the harness says for any other command", async () => {
    const { shown, answer } = await answerAtOnce("pnpm test");
    assert.doesNotMatch(shown, /⚠/);
    assert.deepEqual(answer, { kind: "approval", optionId: "yes" });
  });
});
