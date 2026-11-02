import { execFile } from "node:child_process";

// What the server asks tailscaled, through the `tailscale` CLI, which knows
// where tailscaled listens on each platform: this node's addresses and owner,
// and who is behind a tailnet address.

/** A tailnet identity: the login of the user behind a node. */
export interface TailnetIdentity {
  login: string;
  node: string;
  /** The node is tagged, so it belongs to no user. */
  tagged: boolean;
}

/** Runs `tailscale` with these arguments, resolving with its output. */
export type TailscaleRunner = (args: string[]) => Promise<string>;

export const runTailscale: TailscaleRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env["ONEHARNESS_TAILSCALE"] || "tailscale",
      args,
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`tailscale ${args[0]}: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });

/** How long a whois answer is kept, per address. */
const WHOIS_MS = 60_000;

/** This node's tailnet addresses, its name, and its owner's login. */
export async function tailnetSelf(
  run: TailscaleRunner = runTailscale,
): Promise<{ addresses: string[]; name: string; owner: string | null }> {
  const status = JSON.parse(await run(["status", "--json"])) as {
    Self?: { UserID?: number; DNSName?: string; TailscaleIPs?: string[]; Tags?: string[] };
    User?: Record<string, { LoginName?: string }>;
  };
  const self = status.Self;
  if (!self) throw new Error("tailscale is not logged in");
  const owner =
    self.Tags && self.Tags.length > 0
      ? null
      : (status.User?.[String(self.UserID)]?.LoginName ?? null);
  return {
    addresses: self.TailscaleIPs ?? [],
    name: (self.DNSName ?? "").replace(/\.$/, ""),
    owner,
  };
}

/** Asks tailscaled who is behind tailnet addresses, keeping answers for a minute. */
export class Whois {
  #run: TailscaleRunner;
  #cache = new Map<string, { at: number; identity: Promise<TailnetIdentity | null> }>();

  constructor(run: TailscaleRunner = runTailscale) {
    this.#run = run;
  }

  /** Who is at `address`, or null when tailscaled does not know it. */
  lookup(address: string): Promise<TailnetIdentity | null> {
    const cached = this.#cache.get(address);
    if (cached && Date.now() - cached.at < WHOIS_MS) return cached.identity;
    const identity = this.#run(["whois", "--json", address]).then(
      (output) => {
        const found = JSON.parse(output) as {
          Node?: { Name?: string; Tags?: string[] };
          UserProfile?: { LoginName?: string };
        };
        const login = found.UserProfile?.LoginName;
        if (!login) return null;
        return {
          login,
          node: (found.Node?.Name ?? "").replace(/\.$/, ""),
          tagged: (found.Node?.Tags?.length ?? 0) > 0,
        };
      },
      () => {
        // A failed lookup, as while tailscaled restarts, would turn the owner away for a minute.
        if (this.#cache.get(address)?.identity === identity) this.#cache.delete(address);
        return null;
      },
    );
    this.#cache.set(address, { at: Date.now(), identity });
    return identity;
  }
}
