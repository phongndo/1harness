import { PROTOCOL_VERSION } from "../protocol.ts";
import { ensureServer } from "../server/lifecycle.ts";
import { socketFile } from "../core/paths.ts";
import { HostClient } from "./client.ts";
import { newClientId } from "./connection.ts";
import { resolveServer } from "./hosts.ts";
import { SocketConnection } from "./socket.ts";

/**
 * Finds the server `spec` names, the local one when it names none, starting
 * a local one in the background when none answers.
 */
export async function reach(spec: string | undefined) {
  const { target, label, local } = resolveServer(spec);
  // Only the local socket's server is started on demand; another machine's runs there.
  const autostart = local && "socket" in target && target.socket === socketFile();
  const hello = await ensureServer({ target, autostart });
  if (hello.minProtocol > PROTOCOL_VERSION || hello.protocol < PROTOCOL_VERSION)
    throw new Error(
      `${label} runs 1harness ${hello.version}, which this one cannot talk to${local ? "; stop it with `1harness server stop`" : ""}`,
    );
  // A local server that dies is started again, and picks up its threads parked.
  const revive = autostart ? () => ensureServer({ target, autostart: true, revive: true }) : null;
  return { target, label, local, hello, revive };
}

/**
 * A client of a server `reach` found. Extension modules are this machine's
 * files, so only a local server is given them.
 */
export function socketClient(
  server: Awaited<ReturnType<typeof reach>>,
  options: { cwd: string; version: string; extensions: string[]; agent?: boolean },
): HostClient {
  const id = newClientId();
  return new HostClient(
    new SocketConnection(server.target, id, server.revive ? { revive: server.revive } : {}),
    { ...options, extensions: server.local ? options.extensions : [] },
    id,
  );
}

/** A client of the server `spec` names; it says hello when connected. */
export async function connectClient(
  version: string,
  extensions: string[],
  spec: string | undefined,
  options: { agent?: boolean; cwd?: string } = {},
): Promise<HostClient> {
  const server = await reach(spec);
  // On another machine, this folder is not there; threads start in its home.
  return socketClient(server, {
    cwd: server.local ? process.cwd() : "~",
    version,
    extensions,
    ...options,
  });
}
