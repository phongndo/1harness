import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { Authorizer, HostServer } from "./http.ts";
import { Whois, runTailscale, tailnetSelf, type TailscaleRunner } from "./tailscale.ts";

// Listeners beyond the local socket, for reaching a server from another
// machine. Each says who a caller is, or turns it away:
//
//   tailnet://:PORT        the tailnet addresses of this node; callers are
//                          identified by tailscaled, and only the node's owner
//                          is let in unless allowIdentified widens it
//   tailnet-serve:///PATH  a socket for `tailscale serve` to proxy to, which
//                          names the caller in its headers
//   tcp://HOST:PORT        anyone who can reach it, so only with allowAnonymous

export interface ListenerOptions {
  /** Let in any user tailscaled identifies, not only this node's owner. */
  allowIdentified?: boolean;
  /** Allow listeners that identify nobody, such as plain TCP. */
  allowAnonymous?: boolean;
  /** Runs `tailscale`, for tests. */
  tailscale?: TailscaleRunner;
}

/** A tailnet caller is let in when it is this node's owner, or when any identified one is. */
function admit(
  login: string | null,
  owner: string | null,
  options: ListenerOptions,
): { identity: string } | { refused: string } {
  if (!login) return { refused: "tailscale does not know who you are" };
  if (options.allowIdentified || login === owner) return { identity: login };
  return {
    refused: `only ${owner ?? "this node's owner"} may use this 1harness; ${login} may not`,
  };
}

/** The caller's address, without the port or an IPv4 address's IPv6 wrapping. */
function remote(request: IncomingMessage): string {
  return (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

/**
 * Whether the request names this listener: by address, as localhost, or by one
 * of `names`. A web page that rebinds its own domain to this machine reaches it
 * under that domain, which this turns away.
 */
function namesListener(request: IncomingMessage, names: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${request.headers.host ?? ""}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
  return hostname === "localhost" || names.includes(hostname);
}

const WRONG_HOST = { refused: "this 1harness answers only to its own addresses and name" };

/** Makes room for a socket without deleting a file or following a symlink. */
export function prepareSocket(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (!found) return;
  if (!found.isSocket()) throw new Error(`Refusing to replace ${path}: it is not a socket`);
  unlinkSync(path);
}

/** Splits `scheme://host:port` or `scheme://:port`. */
function hostPort(rest: string, scheme: string): { host: string; port: number } {
  const match = /^(\[[^\]]+\]|[^:]*):(\d+)$/.exec(rest);
  if (!match) throw new Error(`${scheme}:// takes [host]:port`);
  return { host: (match[1] ?? "").replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

/**
 * Adds a listener to a running server; resolves with a line saying where it
 * listens and who it lets in, and the ports it took.
 */
export async function listen(
  server: HostServer,
  address: string,
  options: ListenerOptions = {},
): Promise<{ message: string; ports: number[] }> {
  const ports: number[] = [];
  const took = (bound: Awaited<ReturnType<HostServer["listen"]>>) => {
    if (bound && typeof bound === "object") ports.push(bound.port);
  };
  const message = await open(server, address, options, took);
  return { message, ports };
}

async function open(
  server: HostServer,
  address: string,
  options: ListenerOptions,
  took: (bound: Awaited<ReturnType<HostServer["listen"]>>) => void,
): Promise<string> {
  const scheme = /^([a-z-]+):\/\//.exec(address)?.[1];
  const rest = address.slice((scheme?.length ?? 0) + 3);
  const tailscale = options.tailscale ?? runTailscale;
  switch (scheme) {
    case "tailnet": {
      const { host, port } = hostPort(rest, scheme);
      const self = await tailnetSelf(tailscale);
      const addresses = host ? [host] : self.addresses;
      if (addresses.length === 0) throw new Error("this node has no tailnet address");
      const whois = new Whois(tailscale);
      // MagicDNS answers to the node's full name and, through the search domain, its first label.
      const name = self.name.toLowerCase();
      const names = name ? [name, name.split(".")[0] ?? name] : [];
      const authorize: Authorizer = async (request) => {
        if (!namesListener(request, names)) return WRONG_HOST;
        const caller = await whois.lookup(remote(request));
        return admit(caller?.login ?? null, self.owner, options);
      };
      for (const ip of addresses) took(await server.listen({ port, host: ip }, authorize));
      return `Listening on ${self.name || addresses.join(", ")}:${port} for ${options.allowIdentified ? "anyone on the tailnet" : (self.owner ?? "nobody: this node is tagged; pass --tailnet-allow-identified")}`;
    }
    case "tailnet-serve": {
      const path = rest;
      if (!path.startsWith("/"))
        throw new Error(
          "tailnet-serve:// takes a socket path, as tailnet-serve:///run/1harness.sock",
        );
      const self = await tailnetSelf(tailscale);
      prepareSocket(path);
      // Tailscale Serve names the caller; only it can open this socket.
      const authorize: Authorizer = async (request) => {
        const login = request.headers["tailscale-user-login"];
        return admit(typeof login === "string" ? login : null, self.owner, options);
      };
      await server.listen({ path }, authorize);
      chmodSync(path, 0o600);
      return `Listening on ${path} for tailscale serve; point it here with: tailscale serve --bg unix:${path}`;
    }
    case "tcp": {
      if (!options.allowAnonymous)
        throw new Error(
          `${address} would let in anyone who can reach it; pass --allow-anonymous if that is what you want`,
        );
      const { host, port } = hostPort(rest, scheme);
      took(
        await server.listen({ port, host: host || "127.0.0.1" }, async (request) =>
          namesListener(request, []) ? { identity: null } : WRONG_HOST,
        ),
      );
      return `Listening on ${host || "127.0.0.1"}:${port} for anyone who can reach it`;
    }
    default:
      throw new Error(
        `Cannot listen on ${address}; use tailnet://:PORT, tailnet-serve:///PATH, or tcp://HOST:PORT`,
      );
  }
}
