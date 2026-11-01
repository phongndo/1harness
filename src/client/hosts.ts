import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, socketFile } from "../core/paths.ts";
import type { ServerTarget } from "./socket.ts";

/** Servers known by a short name, such as `z`, kept in `hosts.json` in the config folder. */
export type Hosts = Record<string, string>;

function file(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "hosts.json");
}

export function loadHosts(env: NodeJS.ProcessEnv = process.env): Hosts {
  try {
    const parsed = JSON.parse(readFileSync(file(env), "utf8")) as { hosts?: Hosts };
    return parsed.hosts ?? {};
  } catch {
    return {};
  }
}

export function saveHosts(hosts: Hosts, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dirname(file(env)), { recursive: true });
  writeFileSync(file(env), `${JSON.stringify({ hosts }, null, 2)}\n`);
}

/**
 * Where a server is, from what a person typed: nothing for the local socket,
 * a host's name from `hosts.json`, a socket path, or an address. A value with
 * a port is always an address, so `z:7330` is `http://z:7330`.
 */
export function resolveServer(
  spec: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { target: ServerTarget; label: string; local: boolean } {
  const value = spec?.trim();
  if (!value) return { target: { socket: socketFile(env) }, label: "local", local: true };
  if (value.startsWith("unix:") || value.startsWith("/"))
    return {
      target: { socket: value.replace(/^unix:/, "") },
      label: value,
      local: true,
    };
  if (/^https?:\/\//.test(value)) return { target: { url: value }, label: value, local: false };
  if (/^[^/\s]+:\d+$/.test(value))
    return { target: { url: `http://${value}` }, label: value, local: false };
  const known = loadHosts(env)[value];
  if (known === undefined)
    throw new Error(
      `No server named ${value}; add one with \`1harness hosts add ${value} <address>\``,
    );
  if (known === value) throw new Error(`${value} names itself in hosts.json`);
  return { ...resolveServer(known, env), label: value };
}
