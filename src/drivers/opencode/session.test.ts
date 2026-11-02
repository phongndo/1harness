import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HarnessEvent } from "../../core/events.ts";
import { OpenCodeSession, type OpenCodeSessionConfig } from "./session.ts";

let root: string;
let opencode: string;

/**
 * A stand-in for `opencode serve`, with one session. A prompt of "ask" starts
 * a turn that asks a permission. Interrupting always fails, and a turn starts
 * just after, as when the stop came before OpenCode began the turn.
 */
const FAKE = `import { createServer } from "node:http";
const streams = [];
const event = (type, data) => {
  for (const stream of streams) stream.write("data: " + JSON.stringify({ type, data }) + "\\n\\n");
};
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const path = new URL(request.url, "http://localhost").pathname;
    switch (path) {
      case "/api/event":
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": ready\\n\\n");
        streams.push(response);
        return;
      case "/api/info":
        return json(200, { version: "2.0.0" });
      case "/api/agent":
        return json(200, { data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] });
      case "/api/model/default":
        return json(200, { data: null });
      case "/api/session":
        return json(200, { data: { id: "ses_1", time: { updated: 0 } } });
      case "/api/session/ses_1/prompt":
        json(200, { data: { id: "inbox_1" } });
        if (JSON.parse(body).text === "ask")
          setTimeout(() => {
            event("session.execution.started", { sessionID: "ses_1" });
            event("permission.asked", { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["ls"] });
          }, 20);
        return;
      case "/api/session/ses_1/interrupt":
        json(500, { message: "not now" });
        setTimeout(() => event("session.execution.started", { sessionID: "ses_1" }), 20);
        return;
      default:
        return json(200, { data: [] });
    }
  });
});
server.listen(0, "127.0.0.1", () =>
  console.log("listening on http://127.0.0.1:" + server.address().port),
);
`;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-opencode-"));
  const script = join(root, "opencode.mjs");
  writeFileSync(script, FAKE);
  opencode = join(root, "opencode");
  writeFileSync(opencode, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(opencode, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

function config(): OpenCodeSessionConfig {
  return {
    cwd: root,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    resume: null,
    command: opencode,
  };
}

function collect(session: OpenCodeSession): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  void (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return events;
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("OpenCodeSession", () => {
  it("says so when a stop held until the turn began fails", async () => {
    const session = new OpenCodeSession(config());
    const events = collect(session);
    try {
      await session.start();
      await session.startTurn({ text: "hi" });
      await assert.rejects(session.interrupt(), /not now/);
      await until(
        () =>
          events.some(
            (event) =>
              event.type === "item.completed" &&
              event.item.kind === "notice" &&
              event.item.text === "Interrupt failed: not now",
          ),
        "the notice",
      );
    } finally {
      await session.close();
    }
  });

  it("withdraws the requests it leaves open when it closes", async () => {
    const session = new OpenCodeSession(config());
    const events = collect(session);
    await session.start();
    await session.startTurn({ text: "ask" });
    await until(() => events.some((event) => event.type === "request.opened"), "the request");
    await session.close();
    await until(() => events.some((event) => event.type === "session.closed"), "the end");
    assert.ok(
      events.some((event) => event.type === "request.resolved" && event.requestId === "per_1"),
    );
  });
});
