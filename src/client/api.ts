// The API programs build on, which the terminal UI uses too: a program imports
// this module as `1harness/client` and works with threads over a server, the
// local one by default, started in the background when none is running.
//
//   import { connect } from "1harness/client";
//   const client = await connect();
//   const thread = await client.call("thread.open", { harness: "codex", settings });
//   client.on((event) => { if (event.type === "entry") ... });
//   await client.call("thread.send", { threadId: thread.id, text: "Fix the parser" });
//
// `client.call` takes the methods of `Methods` in src/protocol.ts, among them
// `operations.call`, which reaches what agents reach as tools. Changes that
// would break a client bump `PROTOCOL_VERSION`; src/api-contract.test.ts pins
// what there is.

import { readFileSync } from "node:fs";
import { connectClient } from "./connect.ts";
import type { HostClient } from "./client.ts";

export { RpcError, PROTOCOL_VERSION } from "../protocol.ts";
export type { ClientEvent, HostClient } from "./client.ts";
export type {
  HarnessInfo,
  HostEvent,
  LogEntry,
  Method,
  Methods,
  Params,
  Result,
  ThreadState,
} from "../protocol.ts";
export type { Item, RuntimeMode, SessionOptions } from "../core/events.ts";

export interface ConnectOptions {
  /** A name from `1harness hosts`, host:port, or a socket path; this machine's by default. */
  server?: string;
  /** The folder the client works in, where threads start by default. */
  cwd?: string;
}

function packageVersion(): string {
  const file = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/** A client of a server, connected and following its events. `close` it when done. */
export async function connect(options: ConnectOptions = {}): Promise<HostClient> {
  const client = await connectClient(
    packageVersion(),
    [],
    options.server,
    options.cwd ? { cwd: options.cwd } : {},
  );
  await client.connect();
  return client;
}
