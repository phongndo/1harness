// A second opinion after every turn that changes files. A reviewer on another
// harness, which knows nothing of how the code came about, reads the changes in
// a thread of its own that you can open and watch. Unless it says LGTM, what it
// found goes back to the agent that wrote the code, up to three times a thread.
//
//   /review-loop                 turn it on or off, as alt+r does
//   /review-loop on | off        turn it on, starting the count over, or off
//   /review-loop harness <id>    review on this harness, not the first other one that is ready
//
// Load it with `1harness -x examples/extensions/review-loop.ts`, or copy it to
// ~/.config/1harness/extensions/.

import type { ExtensionAPI, ExtensionContext } from "1harness/extension";

const MAX_ROUNDS = 3;
const REVIEW_WAIT_SECONDS = 3600;
const PROMPT = `Review the uncommitted changes in this folder, starting from \`git diff\`. Look for bugs, missing edge cases, and security problems, and read the surrounding code as you need to. Do not change any files.

Reply with what you found, most severe first, each with its file and line. If you found nothing worth fixing, reply with only: LGTM`;

interface Harness {
  id: string;
  unavailable: string | null;
}

interface Waited {
  waitTimedOut: boolean;
  latest: { result: string | null } | null;
}

export default function reviewLoop(api: ExtensionAPI): void {
  let on = api.storage.get<boolean>("on") ?? true;
  /** The reviewers' own threads, whose turns are not reviewed. */
  const reviewers = new Set<string>();
  /** Threads whose running turn changed files. */
  const edited = new Set<string>();
  const rounds = new Map<string, number>();

  const setOn = (value: boolean) => {
    on = value;
    api.storage.set("on", value);
    if (value) rounds.clear();
  };

  const reviewer = async (current: string): Promise<string> => {
    const chosen = api.storage.get<string>("harness");
    if (chosen) return chosen;
    const harnesses = (await api.runOperation("harness_list")) as Harness[];
    const other = harnesses.find(({ id, unavailable }) => id !== current && !unavailable);
    return other?.id ?? current;
  };

  const review = async (writer: string, context: ExtensionContext): Promise<void> => {
    const { harness: current, cwd } = context.thread.info;
    const harness = await reviewer(current);
    // Opened before it is given anything, so its first turn is known to be a reviewer's.
    const { threadId } = (await api.runOperation("thread_open", {
      harness,
      cwd,
      title: "Review",
    })) as { threadId: string };
    reviewers.add(threadId);
    context.ui?.setStatus?.("review-loop", `reviewing on ${harness}`);
    try {
      await api.runOperation("thread_send", { threadId, message: PROMPT });
      const { waitTimedOut, latest } = (await api.runOperation("thread_wait", {
        threadId,
        timeoutSeconds: REVIEW_WAIT_SECONDS,
      })) as Waited;
      if (waitTimedOut) {
        context.ui?.notify("warning", `The review on ${harness} is still running`);
        return;
      }
      await api.runOperation("thread_close", { threadId });
      const found = latest?.result?.trim();
      if (!found || /^LGTM\b/.test(found)) return;
      await api.runOperation("thread_send", {
        threadId: writer,
        message: `Another agent reviewed your changes. It has not seen your reasoning, so use your judgment: fix what is right, and say why you leave anything.\n\n${found}`,
      });
    } finally {
      context.ui?.setStatus?.("review-loop", null);
    }
  };

  api.registerCommand({
    name: "review-loop",
    usage: "[on | off | harness <id>]",
    description: "have an agent on another harness review each turn that changes files",
    group: "Tools",
    shortcut: "alt+r",
    run: (context, args) => {
      const [action, harness] = args.split(/\s+/).filter(Boolean);
      if (action === "harness" && harness) api.storage.set("harness", harness);
      else if (action === "on" || action === "off") setOn(action === "on");
      // The key sends no words, so it toggles.
      else if (action === undefined) setOn(!on);
      context.ui.notify("info", `Reviews are ${on ? "on" : "off"}`);
    },
  });

  api.on("item.completed", (event, context) => {
    if (on && event.item.kind === "file_change" && context.threadId) edited.add(context.threadId);
  });

  api.on("turn.ended", async (event, context) => {
    const writer = context.threadId;
    if (!writer || !edited.delete(writer) || reviewers.has(writer)) return;
    if (!on || event.status !== "completed") return;
    const round = rounds.get(writer) ?? 0;
    if (round >= MAX_ROUNDS) {
      context.ui?.notify("info", `${MAX_ROUNDS} reviews of this thread; /review-loop on for more`);
      return;
    }
    rounds.set(writer, round + 1);
    await review(writer, context);
  });
}
