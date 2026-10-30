// Applies command rules the same way on every harness. Commands matching a
// blocked pattern never run: they are checked before every tool call, in every
// permission mode (Codex asks once to trust the hook this needs). Commands
// matching an allowed pattern are approved when the harness asks; everything
// else still asks.
//
//   /rules                     list the rules
//   /rules allow <regex>       approve matching commands
//   /rules block <regex>       decline matching commands
//   /rules remove <regex>
//
// Load it with `1harness -x examples/extensions/approval-rules.ts`, or copy it
// to ~/.config/1harness/extensions/.

import type { ExtensionAPI } from "1harness/extension";

interface Rules {
  allow: string[];
  block: string[];
}

const DEFAULT_RULES: Rules = {
  allow: [],
  block: [
    String.raw`\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(/|~|\$HOME)(\s|$)`,
    String.raw`\bsudo\b`,
    String.raw`\bgit\s+push\b.*(\s--force\b|\s-f\b)`,
    String.raw`\bmkfs(\.|\s)`,
  ],
};

/** The first pattern that matches the command. */
function matching(patterns: string[], command: string): string | undefined {
  return patterns.find((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
}

export default function approvalRules(api: ExtensionAPI): void {
  const rules = (): Rules => api.storage.get<Rules>("rules") ?? DEFAULT_RULES;

  api.onToolCall((call, context) => {
    if (call.action.type !== "command") return undefined;
    const blocked = matching(rules().block, call.action.command);
    if (!blocked) return undefined;
    context.ui?.notify("warning", `Rules blocked \`${call.action.command}\` (matches ${blocked})`);
    return `A 1harness approval rule blocks commands matching ${blocked}.`;
  });

  api.onRequest((request, context) => {
    if (request.kind !== "approval" || request.action.type !== "command") return undefined;
    const command = request.action.command;
    const blocked = matching(rules().block, command);
    if (blocked) {
      context.ui?.notify("warning", `Rules declined \`${command}\` (matches ${blocked})`);
      // The agent carries on without the command and learns why.
      return {
        kind: "decline",
        reason: `A 1harness approval rule blocks commands matching ${blocked}.`,
      };
    }
    const allowed = matching(rules().allow, command);
    if (allowed) {
      context.ui?.notify("info", `Rules approved \`${command}\` (matches ${allowed})`);
      return api.choose(request, "allow");
    }
    return undefined;
  });

  api.registerCommand({
    name: "rules",
    usage: "[allow | block | remove] [regex]",
    description: "approve or decline commands by pattern, on every harness",
    group: "Permissions",
    complete: (_context, args) =>
      args.includes(" ")
        ? null
        : {
            start: 0,
            items: [
              { value: "allow", detail: "approve matching commands", more: true },
              { value: "block", detail: "decline matching commands", more: true },
              { value: "remove", detail: "drop a rule", more: true },
            ],
          },
    run(context, args) {
      const [, action = "", pattern = ""] = /^(\S*)\s*(.*)$/.exec(args) ?? [];
      const current = rules();
      if (action === "allow" || action === "block") {
        // A pattern that does not compile throws here, before it is saved.
        RegExp(pattern);
        const next = { ...current, [action]: [...current[action], pattern] };
        api.storage.set("rules", next);
        context.ui.notify("info", `Commands matching ${pattern} are now ${action}ed`);
        return;
      }
      if (action === "remove") {
        api.storage.set("rules", {
          allow: current.allow.filter((entry) => entry !== pattern),
          block: current.block.filter((entry) => entry !== pattern),
        });
        context.ui.notify("info", `Removed ${pattern}`);
        return;
      }
      const lines = [
        ...current.block.map((entry) => [
          { text: "block  ", tone: "bad" as const },
          { text: entry, tone: "soft" as const },
        ]),
        ...current.allow.map((entry) => [
          { text: "allow  ", tone: "good" as const },
          { text: entry, tone: "soft" as const },
        ]),
      ];
      context.ui.report({
        title: "Approval rules",
        lines: lines.length > 0 ? lines : [[{ text: "No rules", tone: "muted" }]],
      });
    },
  });
}
