import { parseInput } from "../operations/input.ts";
import type { OperationInfo } from "../operations/operation.ts";
import type { HostClient } from "./client.ts";

const OP_HELP = `Usage: 1harness op [--json]
       1harness op <operation> [key=value ... | '{json}']

Lists the operations you can call, or calls one and prints what it returns.
Values parse as JSON where they can (turn=3, fresh=true), else as text; one
JSON object is the whole input. Agents call the same operations as tools:
thread_open, thread_send, thread_events, thread_switch_harness, and more.
`;

/** The operations, one a line: name, whether it changes anything, and what it does. */
function operationLines(operations: readonly OperationInfo[]): string {
  const width = Math.max(0, ...operations.map((operation) => operation.name.length));
  return operations
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(
      (operation) =>
        `${operation.name.padEnd(width)}  ${operation.effect.padEnd(4)}  ${operation.description.split(". ")[0]?.replace(/\.$/, "")}`,
    )
    .join("\n");
}

/** `1harness op …`; resolves with the exit status. */
export async function opCommand(
  args: string[],
  connect: () => Promise<HostClient>,
  out: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    out.write(OP_HELP);
    return 0;
  }
  const json = args.includes("--json");
  const [name, ...words] = args.filter((arg) => arg !== "--json");
  const client = await connect();
  try {
    await client.connect();
    if (!name) {
      const operations = await client.call("operations.list", {});
      out.write(
        json ? `${JSON.stringify(operations, null, 2)}\n` : `${operationLines(operations)}\n`,
      );
      return 0;
    }
    const { result } = await client.call("operations.call", {
      name,
      input: parseInput(words),
    });
    out.write(
      typeof result === "string" && !json ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}
