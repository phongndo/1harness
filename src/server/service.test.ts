import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { socketFile } from "../core/paths.ts";
import { launchAgent, serverCommand, serverEnvironment, systemdUnits } from "./service.ts";

describe("server service files", () => {
  it("runs this 1harness's own CLI with the node running it", () => {
    const command = serverCommand();
    assert.equal(command[0], process.execPath);
    assert.deepEqual(command.slice(-2), ["server", "run"]);
    const cli = command.at(-3)!;
    // From source, the TypeScript entry point; built, the JavaScript one.
    assert.match(cli, /[/\\]cli\.(ts|js)$/);
    assert.ok(existsSync(cli));
  });

  it("passes on only where harnesses are and 1harness's own variables, sorted", () => {
    const env = serverEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/me",
      ONEHARNESS_CODEX_PATH: "/opt/codex",
      ONEHARNESS_SOCKET: "/run/1harness.sock",
      ONEHARNESS_THEME: "light",
      XDG_STATE_HOME: "/home/me/.state",
      XDG_CACHE_HOME: "/home/me/.cache",
      SECRET_TOKEN: "hunter2",
    });
    assert.equal(
      env,
      [
        "# Written by `1harness server install` from the shell it ran in.",
        "ONEHARNESS_CODEX_PATH=/opt/codex",
        "ONEHARNESS_SOCKET=/run/1harness.sock",
        "PATH=/usr/bin:/bin",
        "XDG_STATE_HOME=/home/me/.state",
        "",
      ].join("\n"),
    );
  });

  it("writes a socket-activated systemd service, quoting arguments with spaces", () => {
    const { service, socket } = systemdUnits(
      ["/usr/bin/node", "/home/me/my code/cli.js", "server", "run"],
      "/home/me/.config/1harness/server.env",
      "/run/user/1000/1harness/server.sock",
    );
    assert.match(service, /^Requires=1harness\.socket$/m);
    assert.match(service, /^EnvironmentFile=-\/home\/me\/\.config\/1harness\/server\.env$/m);
    assert.match(
      service,
      /^ExecStart=\/usr\/bin\/node "\/home\/me\/my code\/cli\.js" server run$/m,
    );
    assert.match(service, /^Restart=on-failure$/m);
    assert.match(socket, /^ListenStream=\/run\/user\/1000\/1harness\/server\.sock$/m);
    assert.match(socket, /^SocketMode=0600$/m);
    assert.match(socket, /^WantedBy=sockets\.target$/m);
  });

  it("writes a LaunchAgent that keeps the server alive, escaping XML", () => {
    const plist = launchAgent(
      ["/usr/local/bin/node", "/Users/me/a&b/cli.js", "server", "run"],
      { PATH: "/usr/bin", ONEHARNESS_CLAUDE_PATH: "/opt/<claude>" },
      "/Users/me/.local/state/1harness/server.log",
    );
    assert.match(plist, /<key>Label<\/key>\n\s+<string>dev\.1harness\.server<\/string>/);
    assert.match(
      plist,
      /<array>\n\s+<string>\/usr\/local\/bin\/node<\/string>\n\s+<string>\/Users\/me\/a&amp;b\/cli\.js<\/string>\n\s+<string>server<\/string>\n\s+<string>run<\/string>\n\s+<\/array>/,
    );
    assert.match(
      plist,
      /<key>ONEHARNESS_CLAUDE_PATH<\/key>\n\s+<string>\/opt\/&lt;claude&gt;<\/string>/,
    );
    assert.match(plist, /<key>KeepAlive<\/key>\n\s+<true\/>/);
    assert.match(
      plist,
      /<key>StandardErrorPath<\/key>\n\s+<string>\/Users\/me\/\.local\/state\/1harness\/server\.log<\/string>/,
    );
  });

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
