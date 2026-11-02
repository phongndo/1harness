import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { HOSTS_HELP, hostsCommand, whoami } from "./hosts-cli.ts";

/**
 * A stream's `write` that keeps the text written to it. The test runner
 * reports on stdout too, in binary, and that still goes out.
 */
function keep(stream: NodeJS.WriteStream, onText: (text: string) => void) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return write(chunk, ...rest);
    onText(chunk);
    return true;
  };
}

let root: string;
let server: Server;
let socket: string;
/** Who the fake server says the caller is. */
let identity: string | null = null;
let out = "";
let err = "";
const saved = { config: process.env["XDG_CONFIG_HOME"], socket: process.env["ONEHARNESS_SOCKET"] };

before(async () => {
  root = mkdtempSync(join(tmpdir(), "1harness-hosts-"));
  socket = join(root, "server.sock");
  server = createServer((request, response) => {
    if (request.url !== "/v1/hello") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ name: "1harness", version: "9.9.9", protocol: 7, pid: 4242, identity }),
    );
  });
  await new Promise<void>((done) => server.listen(socket, done));
});

after(async () => {
  await new Promise((done) => server.close(done));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  out = "";
  err = "";
  identity = null;
  process.env["XDG_CONFIG_HOME"] = mkdtempSync(join(root, "config-"));
  process.env["ONEHARNESS_SOCKET"] = socket;
});

afterEach(() => {
  for (const [name, value] of [
    ["XDG_CONFIG_HOME", saved.config],
    ["ONEHARNESS_SOCKET", saved.socket],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Runs a command with what it prints kept in `out` and `err`. Only while it
 * runs: the test runner reports on stdout too.
 */
async function capture(command: () => Promise<number>): Promise<number> {
  const stdout = mock.method(
    process.stdout,
    "write",
    keep(process.stdout, (chunk) => (out += chunk)),
  );
  const stderr = mock.method(
    process.stderr,
    "write",
    keep(process.stderr, (chunk) => (err += chunk)),
  );
  try {
    return await command();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
  }
}

const hosts = (args: string[]) => capture(() => hostsCommand(args));
const who = (spec: string | undefined) => capture(() => whoami(spec));

function hostsFile(): unknown {
  return JSON.parse(
    readFileSync(join(process.env["XDG_CONFIG_HOME"]!, "1harness", "hosts.json"), "utf8"),
  );
}

describe("hostsCommand", () => {
  it("lists no hosts, then says how to add one", async () => {
    assert.equal(await hosts([]), 0);
    assert.equal(out, "No hosts; add one with `1harness hosts add <name> <address>`.\n");
  });

  it("adds a host, checks that it answers, and lists it", async () => {
    identity = "alice@tailnet";
    assert.equal(await hosts(["add", "box", socket]), 0);
    assert.equal(
      out,
      `Added box → ${socket}\nbox  1harness 9.9.9, protocol 7, pid 4242, you are alice@tailnet\n`,
    );
    assert.deepEqual(hostsFile(), { hosts: { box: socket } });
    out = "";
    await hosts(["add", "attic", join(root, "nothing.sock")]);
    out = "";
    assert.equal(await hosts(["ls"]), 0);
    // Sorted by name.
    assert.equal(out, `attic        ${join(root, "nothing.sock")}\nbox          ${socket}\n`);
  });

  it("keeps a host that does not answer, but fails", async () => {
    assert.equal(await hosts(["add", "gone", join(root, "nothing.sock")]), 1);
    const lines = out.trim().split("\n");
    assert.equal(lines[0], `Added gone → ${join(root, "nothing.sock")}`);
    assert.match(lines[1]!, /^gone {2}\S/);
    assert.deepEqual(hostsFile(), { hosts: { gone: join(root, "nothing.sock") } });
  });

  it("refuses a name that reads as an address, and a missing address", async () => {
    await assert.rejects(hosts(["add", "z:7330", "z:7330"]), /no colons, slashes, or spaces/);
    assert.equal(await hosts(["add", "lonely"]), 2);
    assert.equal(err, HOSTS_HELP);
  });

  it("removes a host, and refuses one it does not know", async () => {
    await hosts(["add", "box", socket]);
    out = "";
    assert.equal(await hosts(["rm", "box"]), 0);
    assert.equal(out, "Removed box\n");
    assert.deepEqual(hostsFile(), { hosts: {} });
    await assert.rejects(hosts(["remove", "box"]), /No host named box/);
  });

  it("checks the local server and every host, failing if any does not answer", async () => {
    await hosts(["add", "box", socket]);
    out = "";
    assert.equal(await hosts(["check"]), 0);
    assert.match(out, /^local {2}1harness 9\.9\.9, protocol 7, pid 4242\nbox {2}1harness 9\.9\.9/);
    await hosts(["add", "gone", join(root, "nothing.sock")]);
    out = "";
    assert.equal(await hosts(["check"]), 1);
    assert.equal(await hosts(["check", "box"]), 0);
  });

  it("refuses to add to a hosts.json it cannot read, rather than overwrite it", async () => {
    const folder = join(process.env["XDG_CONFIG_HOME"]!, "1harness");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "hosts.json"), '{"hosts": {"box": ');
    await assert.rejects(hosts(["add", "attic", socket]), /hosts\.json is not valid JSON/);
    assert.equal(readFileSync(join(folder, "hosts.json"), "utf8"), '{"hosts": {"box": ');
  });

  it("prints its help for help, and fails for a command it does not know", async () => {
    assert.equal(await hosts(["help"]), 0);
    assert.equal(out, HOSTS_HELP);
    assert.equal(await hosts(["frobnicate"]), 2);
  });
});

describe("whoami", () => {
  it("says who the server takes the caller to be", async () => {
    identity = "alice@tailnet";
    assert.equal(await who(undefined), 0);
    assert.equal(out, "alice@tailnet\n");
  });

  it("names the user on a local socket, which tells no identity", async () => {
    const user = process.env["USER"];
    assert.equal(await who(undefined), 0);
    assert.equal(out, `${user ?? "you"}, on the local socket of local\n`);
  });

  it("fails when the server does not answer", async () => {
    assert.equal(await who(join(root, "nothing.sock")), 1);
    assert.match(out, new RegExp(`^${join(root, "nothing.sock")}: `));
  });
});
