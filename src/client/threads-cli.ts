import { parseArgs } from "node:util";
import { shortTime } from "../core/wording.ts";
import type { LogEntry, ThreadListing } from "../protocol.ts";
import type { HostClient } from "./client.ts";

export const THREADS_HELP = `Usage: 1harness threads [--all] [--archived] [--json] [words]
       1harness threads show <id> [--json]

Lists 1harness's threads, newest first: this folder's, or every folder's with
--all. Words search titles and what was said. \`show\` prints a thread's
transcript. 1harness -r <id> reopens one.
`;

function oneLine(text: string, width: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/** A transcript as plain text: messages, replies, commands, and notices. */
export function transcriptText(entries: readonly LogEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "turn.ended" && entry.status !== "completed")
      lines.push(`  (${entry.status}${entry.error ? `: ${entry.error}` : ""})`, "");
    if (entry.type === "session.ended" && entry.error)
      lines.push(`  (session ended: ${entry.error})`, "");
    if (entry.type !== "item" || !entry.done) continue;
    const item = entry.item;
    switch (item.kind) {
      case "user_message": {
        const origin = entry.message?.origin;
        const text =
          origin?.type === "task"
            ? `[task from ${origin.from}] ${origin.task}`
            : origin?.type === "report"
              ? `[result from ${origin.from}] ${origin.result}`
              : (entry.message?.input.text ?? item.text);
        lines.push(...text.split("\n").map((line) => `> ${line}`), "");
        break;
      }
      case "assistant_message":
        lines.push(item.text.trim(), "");
        break;
      case "command":
        lines.push(
          `  $ ${item.command}${item.exitCode === null ? "" : `  (exit ${item.exitCode})`}`,
        );
        break;
      case "file_change":
        lines.push(
          ...item.changes.map((change) => `  ${change.kind} ${change.movePath ?? change.path}`),
        );
        break;
      case "notice":
        lines.push(`  · ${item.text}`, "");
        break;
      default:
        break;
    }
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** `1harness threads …`; resolves with the exit status. */
export async function threadsCommand(
  args: string[],
  connect: () => Promise<HostClient>,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", short: "a" },
      archived: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(THREADS_HELP);
    return 0;
  }
  const client = await connect();
  try {
    await client.connect();
    if (positionals[0] === "show") {
      const id = positionals[1];
      if (!id) throw new Error("Usage: 1harness threads show <id>");
      const page = await client.call("thread.attach", { threadId: id, limit: 500 });
      if (values.json) process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
      else {
        const thread = page.thread;
        process.stdout.write(
          `${thread.id} · ${thread.harness} · ${thread.status} · ${thread.info.cwd}\n${thread.title}\n\n`,
        );
        if (page.more) process.stdout.write("(earlier turns are not shown)\n\n");
        process.stdout.write(transcriptText(page.entries.map((logged) => logged.entry)));
      }
      return 0;
    }
    const query = positionals.join(" ").trim();
    let threads: ThreadListing[] = query
      ? [
          ...(await client.call("threads.search", { query })).map((hit) => hit.thread),
          ...(await client.call("threads.list", { scope: "recent", query })),
        ]
      : await client.call("threads.list", {
          scope: values.archived ? "archived" : "recent",
          limit: 500,
        });
    threads = [...new Map(threads.map((thread) => [thread.id, thread])).values()];
    if (!values.all) threads = threads.filter((thread) => thread.cwd === process.cwd());
    if (values.json) {
      process.stdout.write(`${JSON.stringify(threads, null, 2)}\n`);
      return 0;
    }
    if (threads.length === 0) {
      process.stdout.write(
        values.all ? "No threads.\n" : "No threads in this folder; --all lists every folder's.\n",
      );
      return 0;
    }
    const width = Math.max(4, ...threads.map((thread) => thread.id.length));
    for (const thread of threads) {
      const mark = thread.pinned ? "pinned" : thread.unseen ? "new" : "";
      process.stdout.write(
        `${thread.id.padEnd(width)}  ${thread.status.padEnd(7)}  ${thread.harness.padEnd(8)}  ${shortTime(thread.updatedAt).padEnd(17)}  ${oneLine(thread.title || "untitled", 60)}${mark ? `  [${mark}]` : ""}${values.all && thread.cwd !== process.cwd() ? `  ${thread.cwd}` : ""}\n`,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}
