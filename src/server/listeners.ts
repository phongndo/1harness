import type { HostServer } from "./http.ts";

/**
 * Adds a listener named like `tailnet://:7330` to a running server; returns
 * a line saying where it listens.
 */
export async function listen(_server: HostServer, address: string): Promise<string> {
  throw new Error(`Cannot listen on ${address}: only the local socket is supported`);
}
