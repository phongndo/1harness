import {
  modeRank,
  type ApprovalAction,
  type ApprovalOption,
  type FileChange,
  type RateLimit,
  type RuntimeMode,
} from "./events.ts";

// The words prompts and notices use on every harness. A driver decides what to
// ask and which native choices to offer; these decide how it reads, so 1harness
// looks the same whichever harness runs underneath.

/** What each runtime mode lets the agent do, as 1harness promises it on every harness. */
export const MODE_DESCRIPTIONS: Record<RuntimeMode, string> = {
  supervised: "read freely; ask before edits and commands",
  "auto-edit": "edit files without asking; ask before riskier actions",
  auto: "a safety check decides what needs asking",
  "full-access": "never ask",
};

/** Approval questions. */
export const ASK = {
  command: "Run this command?",
  commandInput: "Send input to the running command?",
  create: (file: string) => `Create ${file}?`,
  edit: (file: string) => `Edit ${file}?`,
  edits: "Make these edits?",
  remove: (file: string) => `Delete ${file}?`,
  move: (file: string) => `Move ${file}?`,
  fetch: "Fetch this page?",
  network: (host: string) => `Allow network access to ${host}?`,
  permissions: "Grant more permissions?",
  tool: (name: string) => `Allow ${name}?`,
  other: "Allow this?",
  visit: (server: string) => `${server} needs you to visit a page`,
  fromAgent: (question: string) => `Another agent asks: ${question}`,
};

/** The last part of a path, as questions name files. */
export function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

/** The question for file changes, from what the one change does, or for several. */
export function askForChanges(changes: readonly Omit<FileChange, "diff">[]): string {
  const [only] = changes;
  if (!only || changes.length > 1) return ASK.edits;
  const file = fileName(only.path);
  if (only.movePath) return ASK.move(file);
  return only.kind === "add"
    ? ASK.create(file)
    : only.kind === "delete"
      ? ASK.remove(file)
      : ASK.edit(file);
}

/** The question for an action, from what the action is. */
export function askFor(action: ApprovalAction): string {
  switch (action.type) {
    case "command":
      return ASK.command;
    case "file_change":
      return askForChanges(action.paths.map((path) => ({ path, kind: "update" })));
    case "tool":
      return ASK.tool(action.server ? `${action.server} · ${action.tool}` : action.tool);
    case "other":
      return ASK.other;
  }
}

/** Approval choices. */
export const ANSWER = {
  yes: "Yes",
  no: "No",
  /** The turn stops so the user can redirect the agent. */
  noAndExplain: "No, and tell the agent what to do differently",
  /** The agent carries on without the action. */
  noAndContinue: "No, continue without it",
  forTurn: "Yes, for this turn",
  forSession: "Yes, for this session",
  done: "Done, continue",
  cancel: "Cancel",
  /** Allowed for the rest of the session. */
  again: (subject?: string) =>
    subject
      ? `Yes, and don't ask again for ${subject} this session`
      : "Yes, and don't ask again this session",
  /** Remembered beyond the session. */
  always: (subject = "it") => `Yes, and always allow ${subject}`,
  never: (subject = "it") => `No, and always block ${subject}`,
};

export const PLAN_TITLE = "Implement this plan?";
const KEEP_PLANNING = "keep";

/**
 * The choices for a finished plan: carry it out in the thread's own mode or
 * one of the common narrower ones the harness offers, or keep planning. None
 * is broader than the thread's mode; `/mode` widens it. Each choice's ID is
 * its mode, or `keep`.
 */
export function planOptions(
  current: RuntimeMode,
  offered: readonly RuntimeMode[],
): ApprovalOption[] {
  const modes = [...new Set<RuntimeMode>([current, "auto-edit", "supervised"])].filter(
    (mode) => mode === current || (offered.includes(mode) && modeRank(mode) < modeRank(current)),
  );
  return [
    ...modes.map((mode) => ({
      id: mode,
      label: `Yes, implement it in ${mode} mode`,
      effect: "allow" as const,
    })),
    { id: KEEP_PLANNING, label: "No, keep planning", effect: "deny" },
  ];
}

/** `42% used`, or null where the harness says only the limit's status. */
function limitUsed(limit: RateLimit): string | null {
  return limit.usedPercent === null ? null : `${Math.round(limit.usedPercent)}% used`;
}

function limitResets(limit: RateLimit): string | null {
  return limit.resetsAt === null ? null : `resets ${new Date(limit.resetsAt).toLocaleString()}`;
}

/** The notice for a usage limit that is near or reached. */
export function limitNotice(limit: RateLimit): string {
  const percent = limitUsed(limit);
  const when = limitResets(limit);
  const used = percent === null ? "" : ` ${percent}`;
  const resets = when === null ? "" : `, ${when}`;
  return limit.status === "exceeded"
    ? `${limit.label} usage limit reached${resets}`
    : `${limit.label} usage limit:${used}${resets}`;
}

/** A usage limit in full, as a list of them says it: `5h: 42% used · resets …`. */
export function limitDetail(limit: RateLimit): string {
  const resets = limitResets(limit);
  return `${limit.label}: ${limitUsed(limit) ?? limit.status}${resets ? ` · ${resets}` : ""}`;
}

/** A usage limit that needs attention, in a few words: `5h limit reached`, `5h 85%`. */
export function limitBrief(limit: RateLimit): string {
  if (limit.status === "exceeded") return `${limit.label} limit reached`;
  return `${limit.label} ${limit.usedPercent === null ? "near limit" : `${Math.round(limit.usedPercent)}%`}`;
}

/**
 * How much of the context window is used, its counts as `formatTokens` says
 * them; null where the harness does not say.
 */
export function contextUsed(usage: {
  contextTokens: number | null;
  contextWindow: number | null;
}): { used: string; window: string; percent: number } | null {
  const { contextTokens: used, contextWindow: window } = usage;
  if (used === null || !window) return null;
  return {
    used: formatTokens(used),
    window: formatTokens(window),
    percent: Math.round((used / window) * 100),
  };
}

/** `$0.16`, or `<$0.01` for less. */
export function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** `950`, `12.5k`, `1.2M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** A short date and time, such as `10/31/26, 7:50 PM`, for lists of threads. */
export function shortTime(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * How long ago, as lists of threads say it: `just now`, `5m ago`, `3h ago`,
 * `yesterday`, a weekday within the week, then a date.
 */
export function ago(time: number, now = Date.now()): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const then = new Date(time);
  const today = new Date(now);
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** What each common reasoning effort means, as the effort picker says it. */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: "no reasoning",
  minimal: "the least reasoning, for the fastest replies",
  low: "quick replies with light reasoning",
  medium: "a balance of speed and reasoning",
  high: "reasons longer before answering",
  xhigh: "reasons much longer, for hard problems",
  max: "the most reasoning the model allows",
};
