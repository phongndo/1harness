import { parseArgs } from "node:util";
import { HARNESS_STATES } from "../core/wording.ts";
import type { HarnessInfo } from "../protocol.ts";
import type { HostClient } from "./client.ts";

export const HARNESSES_HELP = `Usage: 1harness harnesses [--json]

Says where each harness stands on the server: ready, needs sign-in, not
installed, or installed when 1harness cannot tell whether it is signed in.
1harness signs in to none of them; each signs in through its own CLI, and this
says which command does it.
`;

/** Which harness 1harness starts: the default settings.json names, else the one used last. */
export interface Starts {
  chosen: string | null;
  last: string | null;
}

/** One row per harness: its name, where it stands, and what to do about that or where it is. */
export function harnessesText(harnesses: readonly HarnessInfo[], { chosen, last }: Starts): string {
  if (harnesses.length === 0) return "No harnesses.\n";
  const idWidth = Math.max(...harnesses.map((harness) => harness.id.length));
  const stateWidth = Math.max(...harnesses.map((harness) => HARNESS_STATES[harness.state].length));
  const rows = harnesses.map((harness) =>
    [
      harness.id.padEnd(idWidth),
      HARNESS_STATES[harness.state].padEnd(stateWidth),
      harness.detail ?? harness.path ?? "",
    ]
      .join("  ")
      .trimEnd(),
  );
  const known = (id: string | null) => harnesses.some((harness) => harness.id === id);
  const footer =
    chosen && !known(chosen)
      ? `settings.json names ${chosen}, which is none of these.`
      : chosen
        ? `1harness starts ${chosen}, your default, unless -H names another.`
        : last && known(last)
          ? `1harness starts ${last}, the harness used last, unless -H names another; ctrl+s in /harness sets a default.`
          : "1harness asks which to start the next time it opens.";
  return `${rows.join("\n")}\n\n${footer}\n`;
}

/** `1harness harnesses`; resolves with the exit status. */
export async function harnessesCommand(
  args: string[],
  connect: () => Promise<HostClient>,
  starts: Starts,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HARNESSES_HELP);
    return 0;
  }
  const client = await connect();
  try {
    await client.connect();
    const harnesses = await client.call("harnesses.list", {});
    process.stdout.write(
      values.json ? `${JSON.stringify(harnesses, null, 2)}\n` : harnessesText(harnesses, starts),
    );
    return 0;
  } finally {
    await client.close();
  }
}
