import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { socketFile } from "../core/paths.ts";
import { systemdUnits } from "./service.ts";

describe("systemdUnits", () => {
  it("listens where clients look for the server, ONEHARNESS_SOCKET included", () => {
    for (const env of [
      { ONEHARNESS_SOCKET: "/srv/1h/server.sock" },
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      { XDG_STATE_HOME: "/home/me/.state" },
    ]) {
      const { socket } = systemdUnits(["1harness"], "/etc/server.env", socketFile(env));
      assert.match(socket, new RegExp(`^ListenStream=${socketFile(env)}$`, "m"));
    }
  });
});
