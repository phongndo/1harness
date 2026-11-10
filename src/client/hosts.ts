import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, socketFile } from "../core/paths.ts";
import { errorMessage } from "../core/errors.ts";
import type { ServerTarget } from "./socket.ts";

/** Servers known by a short name, such as `z`, kept in `hosts.json` in the config folder. */
type Hosts = Record<string, string>;

function file(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "hosts.json");
}

/** The known hosts; none when the file is missing. One that cannot be read throws, so it is not overwritten. */
export function loadHosts(env: NodeJS.ProcessEnv = process.env): Hosts {
  const path = file(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("expected an object with a hosts map");
    const hosts = (parsed as { hosts?: unknown }).hosts;
    if (hosts === undefined) return {};
    if (
      typeof hosts !== "object" ||
      hosts === null ||
      Array.isArray(hosts) ||
      Object.values(hosts).some((address) => typeof address !== "string" || !address.trim())
    )
      throw new Error("hosts must map names to nonempty addresses");
    return hosts as Hosts;
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${errorMessage(error)}); fix or delete it`, {
      cause: error,
    });
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
  let value = spec?.trim();
  const label = value ?? "local";
  const aliases = new Set<string>();
  let hosts: Hosts | undefined;
  for (;;) {
    if (!value) return { target: { socket: socketFile(env) }, label: "local", local: true };
    if (value.startsWith("unix:") || value.startsWith("/"))
      return {
        target: { socket: value.replace(/^unix:/, "") },
        label,
        local: true,
      };
    if (/^https?:\/\//.test(value)) return { target: { url: value }, label, local: false };
    if (/^[^/\s]+:\d+$/.test(value))
      return { target: { url: `http://${value}` }, label, local: false };
    hosts ??= loadHosts(env);
    const known = Object.hasOwn(hosts, value) ? hosts[value] : undefined;
    if (known === undefined)
      throw new Error(
        `No server named ${value}; add one with \`1harness hosts add ${value} <address>\``,
      );
    if (known === value) throw new Error(`${value} names itself in hosts.json`);
    if (aliases.has(value)) throw new Error(`Host alias cycle: ${[...aliases, value].join(" → ")}`);
    aliases.add(value);
    value = known.trim();
  }
}
