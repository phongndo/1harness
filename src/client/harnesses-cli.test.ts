import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { HarnessInfo } from "../protocol.ts";
import type { HostClient } from "./client.ts";
import { HARNESSES_HELP, harnessesCommand, harnessesText } from "./harnesses-cli.ts";

const harnesses: HarnessInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    state: "ready",
    detail: null,
    unavailable: null,
    path: "/usr/local/bin/claude",
  },
  {
    id: "codex",
    label: "Codex",
    state: "signed-out",
    detail: "run `codex login` to sign in",
    unavailable: "Codex is not signed in: run `codex login` to sign in",
    path: "/usr/local/bin/codex",
  },
  {
    id: "acme",
    label: "Acme",
    state: "unchecked",
    detail: null,
    unavailable: null,
    path: "/opt/acme",
  },
  {
    id: "fx",
    label: "fx",
    state: "missing",
    detail: "fx is not installed: no `fx` on PATH",
    unavailable: "fx is not installed: no `fx` on PATH",
    path: null,
  },
];

describe("harnessesText", () => {
  it("says where each harness stands, and what to do about it or where it is", () => {
    assert.equal(
      harnessesText(harnesses, { chosen: "codex", last: "claude" }),
      [
        "claude  ready          /usr/local/bin/claude",
        "codex   needs sign-in  run `codex login` to sign in",
        "acme    installed      /opt/acme",
        "fx      not installed  fx is not installed: no `fx` on PATH",
        "",
        "1harness starts codex, your default, unless -H names another.",
        "",
      ].join("\n"),
    );
  });

  it("says nothing can start until one is installed", () => {
    const missing = harnesses.filter((harness) => harness.state === "missing");
    assert.match(
      harnessesText(missing, { chosen: null, last: null }),
      /Nothing can start yet: install one of these, then run 1harness\./,
    );
  });

  it("says which variable finds a missing harness installed off PATH", () => {
    const missing = {
      id: "codex",
      label: "Codex",
      state: "missing",
      detail: "install with `npm i -g @openai/codex`",
      unavailable: "Codex is not installed",
      path: null,
      override: "ONEHARNESS_CODEX_PATH",
    } as const;
    assert.match(
      harnessesText([missing], { chosen: null, last: null }),
      /Installed off PATH\? Set ONEHARNESS_CODEX_PATH\./,
    );
  });

  it("says it starts the harness used last without a default, and when it will ask", () => {
    assert.match(
      harnessesText(harnesses, { chosen: null, last: "claude" }),
      /starts claude, the harness used last, unless -H names another; ctrl\+s in \/harness sets a default/,
    );
    assert.match(
      harnessesText(harnesses, { chosen: null, last: null }),
      /asks which to start the next time it opens/,
    );
    assert.match(
      harnessesText(harnesses, { chosen: "gone", last: null }),
      /settings\.json names gone, which is none of these/,
    );
  });
});

describe("harnessesCommand", () => {
  it("prints its help without reaching a server", async () => {
    let output = "";
    const write = mock.method(process.stdout, "write", (chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    try {
      const status = await harnessesCommand(
        ["--help"],
        async () => {
          throw new Error("reached a server");
        },
        { chosen: null, last: null },
      );
      assert.equal(status, 0);
    } finally {
      write.mock.restore();
    }
    assert.equal(output, HARNESSES_HELP);
  });

  it("asks the server for every harness", async () => {
    let output = "";
    const asked: unknown[] = [];
    const client = {
      connect: async () => {},
      close: async () => {},
      call: async (method: string, params: unknown) => {
        asked.push([method, params]);
        return harnesses;
      },
    } as unknown as HostClient;
    const write = mock.method(process.stdout, "write", (chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    try {
      assert.equal(
        await harnessesCommand(["--json"], async () => client, { chosen: null, last: null }),
        0,
      );
    } finally {
      write.mock.restore();
    }
    assert.deepEqual(asked, [["harnesses.list", {}]]);
    assert.deepEqual(JSON.parse(output), harnesses);
  });
});
