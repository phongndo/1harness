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

/** The notice for a usage limit that is near or reached. */
export function limitNotice(limit: RateLimit): string {
  const used = limit.usedPercent === null ? "" : ` ${Math.round(limit.usedPercent)}% used`;
  const resets =
    limit.resetsAt === null ? "" : `, resets ${new Date(limit.resetsAt).toLocaleString()}`;
  return limit.status === "exceeded"
    ? `${limit.label} usage limit reached${resets}`
    : `${limit.label} usage limit:${used}${resets}`;
}

/** `950`, `12.5k`, `1.2M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
