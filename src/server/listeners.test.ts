import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { resolveServer } from "../client/hosts.ts";
import { serverHello } from "../client/socket.ts";
import { Host } from "../host/host.ts";
import { CLIENT_HEADER, HostServer } from "./http.ts";
import { listen } from "./listeners.ts";
import { Whois, type TailscaleRunner } from "./tailscale.ts";

let root: string;
let host: Host;
let server: HostServer;

before(() => {
  root = mkdtempSync(join(tmpdir(), "1harness-listen-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

afterEach(async () => {
  await server.close();
  await host.shutdown();
});

function start(): void {
  host = new Host({
    version: "test",
    cwd: root,
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    idleCloseMs: 0,
  });
  server = new HostServer(host, { version: "test", autostarted: false });
}

/** A tailscale that owns this node as me@example.com and knows who is at each address. */
function tailscale(callers: Record<string, string>): TailscaleRunner {
  return async (args) => {
    if (args[0] === "status")
      return JSON.stringify({
        Self: { UserID: 1, DNSName: "box.tailnet.ts.net.", TailscaleIPs: ["127.0.0.1"] },
        User: { "1": { LoginName: "me@example.com" } },
      });
    if (args[0] === "whois") {
      const login = callers[args[2] ?? ""];
      if (!login) throw new Error("no such peer");
      return JSON.stringify({ Node: { Name: "laptop." }, UserProfile: { LoginName: login } });
    }
    throw new Error(`unexpected tailscale ${args.join(" ")}`);
  };
}

/** The status of a hello sent to a local port with these headers. */
function helloStatus(port: number | undefined, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/v1/hello", headers });
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.end();
  });
}

describe("listeners", () => {
  it("lets the node's owner in on the tailnet, and names them", async () => {
    start();
    const { ports, message } = await listen(server, "tailnet://127.0.0.1:0", {
      tailscale: tailscale({ "127.0.0.1": "me@example.com" }),
    });
    assert.match(message, /for me@example\.com/);
    const hello = await serverHello({ url: `http://127.0.0.1:${ports[0]}` });
    assert.equal(hello.identity, "me@example.com");
  });

  it("turns away other tailnet users unless told to let identified ones in", async () => {
    start();
    const strict = await listen(server, "tailnet://127.0.0.1:0", {
      tailscale: tailscale({ "127.0.0.1": "friend@example.com" }),
    });
    await assert.rejects(
      serverHello({ url: `http://127.0.0.1:${strict.ports[0]}` }),
      /only me@example\.com may use this 1harness/,
    );
    const open = await listen(server, "tailnet://127.0.0.1:0", {
      tailscale: tailscale({ "127.0.0.1": "friend@example.com" }),
      allowIdentified: true,
    });
    assert.equal(
      (await serverHello({ url: `http://127.0.0.1:${open.ports[0]}` })).identity,
      "friend@example.com",
    );
  });

  it("turns away web pages, and names other than the listener's own", async () => {
    start();
    const tailnet = await listen(server, "tailnet://127.0.0.1:0", {
      tailscale: tailscale({ "127.0.0.1": "me@example.com" }),
    });
    const tcp = await listen(server, "tcp://127.0.0.1:0", { allowAnonymous: true });
    // A page whose name the attacker points at this machine reaches it under that name.
    for (const port of [tailnet.ports[0], tcp.ports[0]]) {
      assert.equal(await helloStatus(port, { Host: `127.0.0.1:${port}` }), 200);
      assert.equal(await helloStatus(port, { Host: `localhost:${port}` }), 200);
      assert.equal(await helloStatus(port, { Host: `evil.example:${port}` }), 403);
      assert.equal(
        await helloStatus(port, { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" }),
        403,
      );
    }
    const port = tailnet.ports[0];
    assert.equal(await helloStatus(port, { Host: `box.tailnet.ts.net:${port}` }), 200);
    assert.equal(await helloStatus(port, { Host: `box:${port}` }), 200);
    assert.equal(await helloStatus(tcp.ports[0], { Host: `box:${tcp.ports[0]}` }), 403);
  });

  it("takes the caller from Tailscale Serve's headers on its socket", async () => {
    start();
    const path = join(root, "serve.sock");
    await listen(server, `tailnet-serve://${path}`, { tailscale: tailscale({}) });
    const hello = (login: string) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = request({
          socketPath: path,
          path: "/v1/hello",
          headers: { "Tailscale-User-Login": login },
        });
        outgoing.on("error", reject);
        outgoing.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.end();
      });
    assert.equal(await hello("me@example.com"), 200);
    assert.equal(await hello("someone@else.com"), 403);
  });

  it("loads extension modules only for clients on the local socket", async () => {
    start();
    const marker = join(root, "loaded");
    const extension = join(root, "marker.mjs");
    writeFileSync(
      extension,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nexport default () => {};\n`,
    );
    const { ports } = await listen(server, "tcp://127.0.0.1:0", { allowAnonymous: true });
    const socket = join(root, "local.sock");
    await server.listen({ path: socket });
    const hello = (target: { port?: number | undefined; socketPath?: string }, client: string) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = request({
          ...(target.port ? { host: "127.0.0.1", port: target.port } : target),
          path: "/v1/rpc",
          method: "POST",
          headers: { "Content-Type": "application/json", [CLIENT_HEADER]: client },
        });
        outgoing.on("error", reject);
        outgoing.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.end(
          JSON.stringify({
            method: "client.hello",
            params: { clientId: client, cwd: root, version: "test", extensions: [extension] },
          }),
        );
      });
    assert.equal(await hello({ port: ports[0] }, "remote"), 200);
    assert.equal(existsSync(marker), false);
    assert.equal(await hello({ socketPath: socket }, "local"), 200);
    assert.equal(existsSync(marker), true);
  });

  it("refuses plain TCP unless anonymous callers are allowed", async () => {
    start();
    await assert.rejects(listen(server, "tcp://127.0.0.1:0"), /--allow-anonymous/);
    const { ports } = await listen(server, "tcp://127.0.0.1:0", { allowAnonymous: true });
    assert.equal((await serverHello({ url: `http://127.0.0.1:${ports[0]}` })).identity, null);
    await assert.rejects(listen(server, "ftp://x:1"), /Cannot listen on/);
  });
});

describe("Whois", () => {
  it("asks again after tailscale failed to answer", async () => {
    let calls = 0;
    const whois = new Whois(async () => {
      calls++;
      if (calls === 1) throw new Error("tailscaled is restarting");
      return JSON.stringify({ Node: { Name: "laptop." }, UserProfile: { LoginName: "me@x.com" } });
    });
    assert.equal(await whois.lookup("100.64.0.1"), null);
    assert.equal((await whois.lookup("100.64.0.1"))?.login, "me@x.com");
    assert.equal((await whois.lookup("100.64.0.1"))?.login, "me@x.com");
    assert.equal(calls, 2);
  });
});

describe("resolveServer", () => {
  it("reads names, addresses, and sockets", () => {
    const config = join(root, "hosts");
    const env = { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: "/run/user/9" };
    assert.deepEqual(resolveServer(undefined, env), {
      target: { socket: "/run/user/9/1harness/server.sock" },
      label: "local",
      local: true,
    });
    assert.deepEqual(resolveServer("z:7330", env).target, { url: "http://z:7330" });
    assert.deepEqual(resolveServer("unix:/tmp/a.sock", env).target, { socket: "/tmp/a.sock" });
    assert.throws(() => resolveServer("z", env), /No server named z/);
    const dir = join(config, "1harness");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: { z: "z.tailnet:7330" } }));
    assert.deepEqual(resolveServer("z", env), {
      target: { url: "http://z.tailnet:7330" },
      label: "z",
      local: false,
    });
  });
});
