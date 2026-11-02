import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConnectionEvent } from "./connection.ts";
import { SocketConnection } from "./socket.ts";

describe("SocketConnection", () => {
  it("says why a server that went away cannot be started again", async () => {
    const root = mkdtempSync(join(tmpdir(), "1harness-socket-"));
    let revived = 0;
    const connection = new SocketConnection({ socket: join(root, "gone.sock") }, "c1", {
      revive: async () => {
        revived++;
        throw new Error("The server was stopped; run 1harness again to start it");
      },
    });
    const events: ConnectionEvent[] = [];
    const { promise: told, resolve } = Promise.withResolvers<void>();
    const stop = connection.listen(0, (event) => {
      events.push(event);
      if (events.length === 2) resolve();
    });
    try {
      await told;
    } finally {
      stop();
      await connection.close();
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(revived, 1);
    assert.deepEqual(
      events.map((event) => (event.type === "connection" ? event.state : event.type)),
      ["reconnecting", "reconnecting"],
    );
    const last = events[1];
    assert.equal(
      last?.type === "connection" ? last.error : null,
      "could not start the server again: The server was stopped; run 1harness again to start it",
    );
  });
});
