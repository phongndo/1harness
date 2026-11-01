import { isAbsolute, relative } from "node:path";
import type { ReportSpan } from "../commands/registry.ts";
import type { CommandAction, FileChange, Item, TodoStep } from "../core/events.ts";
import {
  formatElapsed,
  isLive,
  paintStatus,
  plainLine,
  statusDot,
  type AgentRow,
  type AgentStatus,
} from "./agents.ts";
import { renderMarkdown } from "./markdown.ts";
import { diffLine, style } from "./theme.ts";
import { diffBody, plainText, spread, truncate, visibleWidth, wrap } from "./text.ts";

export type ToolItem = Extract<
  Item,
  { kind: "command" | "file_change" | "tool_call" | "web_search" | "agent" }
>;

export type Block =
  | { kind: "banner"; title: string; subtitle: string }
  /** A message for the agent; `label` says who sent it when the user did not, such as `Task from t1`. */
  | { kind: "user"; text: string; label?: string }
  /** A task's result, as it reached the thread that delegated it. */
  | { kind: "result"; from: string; status: AgentStatus; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "plan"; text: string }
  /**
   * Consecutive tool items, shown as one tree. Settled once their turn has
   * ended; `awaiting` holds the ones an open approval is for.
   */
  | {
      kind: "tools";
      items: ToolItem[];
      settled: boolean;
      awaiting?: string[];
      /** Calls cut off when their turn ended, in a group a command outlives. */
      cut?: string[];
    }
  | { kind: "todos"; steps: TodoStep[] }
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
  /** A 1harness command's output, such as /mcp: a heading over aligned lines. */
  | { kind: "report"; title: string; lines: ReportSpan[][] }
  /** The agents a turn started: one row each, with its status and how it ended. */
  | { kind: "agents"; rows: AgentRow[] }
  /** The muted line that closes a turn: duration and token estimate. */
  | { kind: "summary"; text: string }
  /** How the user answered a request, as the thread's log recorded it. */
  | {
      kind: "decision";
      request: "approval" | "question";
      title: string;
      answer: string;
      outcome: "allowed" | "declined" | "answered" | "dismissed";
    };

export interface RenderContext {
  width: number;
  cwd: string;
  /** Phase of the shared blink, for markers of work in progress. */
  blink: boolean;
  /** The time timers count to. */
  now: number;
  /** Shows tool calls whole: full commands, their output, and diffs. */
  details?: boolean;
}

interface Entry {
  block: Block;
  version: number;
  cache: {
    width: number;
    version: number;
    blink: boolean;
    details: boolean;
    rows: string[];
  } | null;
}

const USER_LINES = 24;

export function isToolItem(item: Item): item is ToolItem {
  return (
    item.kind === "command" ||
    item.kind === "file_change" ||
    item.kind === "tool_call" ||
    item.kind === "web_search" ||
    item.kind === "agent"
  );
}

export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

export { formatTokens } from "../core/wording.ts";

/**
 * The conversation as blocks separated by blank rows. Each block's rows are
 * cached by width and version, so a streamed delta re-renders only its block
 * and a frame costs one pass over the block list.
 */
export class Transcript {
  #entries: Entry[] = [];

  get size(): number {
    return this.#entries.length;
  }

  /** The newest block, looking past those `skip` accepts. */
  last(skip: (block: Block) => boolean = () => false): Block | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const block = this.#entries[index]?.block;
      if (block && !skip(block)) return block;
    }
    return undefined;
  }

  add<T extends Block>(block: T): T {
    this.#entries.push({ block, version: 0, cache: null });
    return block;
  }

  /** Marks a block as changed after mutating it. */
  touch(block: Block): void {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (entry?.block === block) {
        entry.version++;
        return;
      }
    }
  }

  remove(block: Block): void {
    this.#entries = this.#entries.filter((entry) => entry.block !== block);
  }

  /** Drops every cached row, for a theme change. */
  invalidate(): void {
    for (const entry of this.#entries) entry.cache = null;
  }

  /** Whether any block shows work in progress and needs the blink. */
  get animating(): boolean {
    return this.#entries.some((entry) => isAnimated(entry.block));
  }

  /** Whether a tool row is still running; agents at work are not counted. */
  get running(): boolean {
    return this.#entries.some((entry) => isRunningGroup(entry.block));
  }

  /** Blocks added after the first `count`, for what a turn added. */
  since(count: number): Block[] {
    return this.#entries.slice(count).map((entry) => entry.block);
  }

  /**
   * Rows for a viewport of `height` rows that ends `scroll` rows above the
   * bottom. `total` counts every row, for clamping the scroll position.
   */
  view(context: RenderContext, height: number, scroll: number): { rows: string[]; total: number } {
    const blocks: string[][] = [];
    let total = 0;
    for (const entry of this.#entries) {
      const rows = this.#rows(entry, context);
      if (rows.length === 0) continue;
      total += rows.length + (blocks.length > 0 ? 1 : 0);
      blocks.push(rows);
    }
    const end = Math.max(0, total - Math.max(0, scroll));
    const start = Math.max(0, end - height);
    const rows: string[] = [];
    let position = 0;
    for (const [index, block] of blocks.entries()) {
      const separated = index > 0;
      const size = block.length + (separated ? 1 : 0);
      if (position + size > start && position < end) {
        if (separated && position >= start) rows.push("");
        const from = Math.max(0, start - position - (separated ? 1 : 0));
        const to = Math.min(block.length, end - position - (separated ? 1 : 0));
        for (let row = from; row < to; row++) rows.push(block[row] ?? "");
      }
      position += size;
      if (position >= end) break;
    }
    return { rows, total };
  }

  #rows(entry: Entry, context: RenderContext): string[] {
    // A live block renders again on each blink, which also moves its timers on.
    const blink = isAnimated(entry.block) && context.blink;
    const details = context.details === true;
    const cache = entry.cache;
    if (
      cache &&
      cache.width === context.width &&
      cache.version === entry.version &&
      cache.blink === blink &&
      cache.details === details
    ) {
      return cache.rows;
    }
    const rows = renderBlock(entry.block, context);
    entry.cache = { width: context.width, version: entry.version, blink, details, rows };
    return rows;
  }
}

function isAnimated(block: Block): boolean {
  if (block.kind === "agents") return block.rows.some((row) => isLive(row.status));
  return isRunningGroup(block);
}

function isRunningGroup(block: Block): boolean {
  return (
    block.kind === "tools" &&
    !block.settled &&
    block.items.some((item) => item.status === "running" && !block.cut?.includes(item.id))
  );
}

export function renderBlock(block: Block, context: RenderContext): string[] {
  const { width } = context;
  switch (block.kind) {
    case "banner":
      return [
        truncate(`${style.bold(style.strong(block.title))} ${style.muted(block.subtitle)}`, width),
      ];
    case "user":
      return userRows(block, width);
    case "result":
      return resultRows(block, width);
    case "assistant":
      return block.text.trim() === "" ? [] : renderMarkdown(block.text, width);
    case "plan":
      return [
        truncate(`${style.strong("●")} ${style.bold("Proposed plan")}`, width),
        ...renderMarkdown(block.text, width),
      ];
    case "tools":
      return toolRows(block, context);
    case "todos":
      return todoRows(block.steps, width);
    case "notice":
      return noticeRows(block, width);
    case "report":
      return reportRows(block, width);
    case "agents":
      return agentRows(block, context);
    case "summary":
      return [truncate(style.muted(`  ${block.text}`), width)];
    case "decision":
      return decisionRows(block, width);
  }
}

/** What the user chose: a mark for how it went, what was asked, and the answer. */
function decisionRows(block: Extract<Block, { kind: "decision" }>, width: number): string[] {
  const mark =
    block.outcome === "allowed"
      ? style.added("✓")
      : block.outcome === "declined"
        ? style.removed("✗")
        : block.outcome === "dismissed"
          ? style.muted("–")
          : style.strong("◆");
  const answer =
    block.outcome === "dismissed"
      ? style.muted("dismissed")
      : style.text(plainText(block.answer, true));
  const title = plainText(block.title, true);
  return wrap(`${mark} ${style.soft(title)} ${style.muted("→")} ${answer}`, width, "  ");
}

function userRows(block: Extract<Block, { kind: "user" }>, width: number): string[] {
  const marker = `${style.strong("┃")} `;
  const lines = plainText(block.text).replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, USER_LINES);
  const rows = block.label ? [truncate(marker + style.muted(block.label), width)] : [];
  rows.push(...shown.flatMap((line) => wrap(marker + style.bold(line), width, marker)));
  if (lines.length > shown.length)
    rows.push(truncate(marker + style.muted(`… ${lines.length - shown.length} more lines`), width));
  return rows;
}

/** Who a result is from and how the task ended, over its first line. */
function resultRows(block: Extract<Block, { kind: "result" }>, width: number): string[] {
  const head = `${statusDot(block.status)} ${style.text(`Result from ${block.from}`)}`;
  const rows = [truncate(`${head} ${style.muted("·")} ${paintStatus(block.status)}`, width)];
  const line = plainLine(block.text);
  if (line) rows.push(truncate(`  ${style.muted(line)}`, width));
  return rows;
}

function noticeRows(block: Extract<Block, { kind: "notice" }>, width: number): string[] {
  const label = block.level === "error" ? "Error " : block.level === "warning" ? "Warning " : "";
  return plainText(block.text)
    .replace(/\s+$/, "")
    .split("\n")
    .flatMap((line, index) =>
      wrap(
        `  ${index === 0 && label ? style.bold(style.text(label)) : ""}${style.soft(line)}`,
        width,
        "  ",
      ),
    );
}

const TONES: Record<ReportSpan["tone"], (text: string) => string> = {
  strong: (text) => style.bold(style.strong(text)),
  text: style.text,
  soft: style.soft,
  muted: style.muted,
  good: style.added,
  bad: style.removed,
};

/** A long last span, such as a list of tools, wraps under where it starts. */
function reportRows(block: Extract<Block, { kind: "report" }>, width: number): string[] {
  const rows = [
    truncate(`${style.strong("●")} ${style.text(plainText(block.title, true))}`, width),
  ];
  for (const spans of block.lines) {
    if (spans.length === 0) {
      rows.push("");
      continue;
    }
    // A span can carry a harness's own text, such as a server's error.
    // Spans pad their columns with spaces, which stay; line breaks become spaces.
    const clean = spans.map((span) => ({
      ...span,
      text: plainText(span.text).replace(/\n/g, " "),
    }));
    const head = clean.slice(0, -1);
    const last = clean.at(-1);
    const lead = `  ${head.map((span) => TONES[span.tone](span.text)).join("")}`;
    const hang = " ".repeat(2 + visibleWidth(head.map((span) => span.text).join("")));
    rows.push(...wrap(lead + (last ? TONES[last.tone](last.text) : ""), width, hang));
  }
  return rows;
}

function todoRows(steps: readonly TodoStep[], width: number): string[] {
  const done = steps.filter((step) => step.status === "completed").length;
  const rows = [
    truncate(
      `${style.strong("●")} ${style.muted(`Todos · ${done} of ${steps.length} done`)}`,
      width,
    ),
  ];
  steps.forEach((step, index) => {
    const branch = style.muted(index === steps.length - 1 ? "└ " : "├ ");
    const label = plainText(step.text, true);
    const text =
      step.status === "completed"
        ? style.muted(`✓ ${label}`)
        : step.status === "in_progress"
          ? style.bold(style.strong(`▪ ${label}`))
          : style.text(`○ ${label}`);
    rows.push(truncate(branch + text, width));
  });
  return rows;
}

// Tool groups

type Category = "edit" | "command" | "read" | "search" | "web" | "fetch" | "agent" | "other";

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/** What a group did, a phrase per category, most telling first. */
const PHRASES: Record<Category, (count: number) => string> = {
  edit: (count) => `changed ${plural(count, "file")}`,
  command: (count) => `ran ${plural(count, "command")}`,
  read: (count) => `read ${plural(count, "file")}`,
  search: (count) => `searched code ${times(count)}`,
  web: (count) => `searched the web ${times(count)}`,
  fetch: (count) => `fetched ${plural(count, "page")}`,
  agent: (count) => `started ${plural(count, "agent")}`,
  other: (count) => `used ${plural(count, "tool")}`,
};

/** The parsed actions of a command that only reads, lists, or searches; null otherwise. */
function exploration(item: ToolItem): CommandAction[] | null {
  if (item.kind !== "command" || !item.actions?.length) return null;
  return item.actions.every((action) => action.type !== "other") ? item.actions : null;
}

function category(item: ToolItem): Category {
  switch (item.kind) {
    case "command": {
      const actions = exploration(item);
      if (!actions) return "command";
      return actions.every((action) => action.type === "read") ? "read" : "search";
    }
    case "file_change":
      return "edit";
    case "web_search":
      return "web";
    case "agent":
      return "agent";
    case "tool_call":
      return item.category;
  }
}

/** One sentence for a group: its top two phrases, and a count of the rest. */
function groupSummary(items: readonly ToolItem[]): string {
  const counts = new Map<Category, number>();
  // The sentence counts files changed, however many edits it took.
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind === "file_change") {
      for (const change of item.changes) files.add(change.path);
      counts.set("edit", files.size);
    } else counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
  }
  const present = (Object.keys(PHRASES) as Category[]).filter((name) => counts.has(name));
  const phrases = present.slice(0, 2).map((name) => PHRASES[name](counts.get(name) ?? 0));
  const rest = present.slice(2).reduce((sum, name) => sum + (counts.get(name) ?? 0), 0);
  if (rest > 0) phrases.push(`performed ${plural(rest, "other action")}`);
  const sentence =
    phrases.length <= 2
      ? phrases.join(" and ")
      : `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
  const failed = items.filter((item) => item.status === "failed").length;
  const capital = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return failed > 0 ? `${capital} · ${failed} failed` : capital;
}

/** A group of one is a single row; more get a sentence over a tree. */
function toolRows(block: Extract<Block, { kind: "tools" }>, context: RenderContext): string[] {
  const { items } = block;
  // A group whose only calls started agents shows nothing; the agents' rows show them.
  if (items.length === 0) return [];
  const running = isRunningGroup(block);
  const marker = running && !context.blink ? " " : style.strong("●");
  const waiting = (item: ToolItem) => block.awaiting?.includes(item.id) ?? false;
  const settled = (item: ToolItem) => block.settled || (block.cut?.includes(item.id) ?? false);
  const line = (item: ToolItem) => toolLine(item, settled(item), context.cwd, waiting(item));
  const [only] = items;
  if (only && items.length === 1) {
    if (context.details) return detailedItem(only, `${marker} `, "  ", context, line(only));
    return [truncate(`${marker} ${line(only)}`, context.width)];
  }
  const rows = [truncate(`${marker} ${style.muted(groupSummary(items))}`, context.width)];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    const branch = style.muted(last ? "└ " : "├ ");
    if (context.details)
      rows.push(
        ...detailedItem(item, branch, style.muted(last ? "  " : "│ "), context, line(item)),
      );
    else rows.push(truncate(branch + line(item), context.width));
  });
  return rows;
}

/** Output lines shown under a tool call in detail, from its end. */
const DETAIL_OUTPUT_LINES = 20;
/** Diff lines shown per edit in detail. */
const DETAIL_DIFF_LINES = 40;

/**
 * A tool call in detail: its whole first row wrapped, then its full command,
 * its output's last lines, or its diffs, under `hang`.
 */
function detailedItem(
  item: ToolItem,
  lead: string,
  hang: string,
  context: RenderContext,
  line: string,
): string[] {
  const { width } = context;
  const body: string[] = [];
  const tail = (text: string, limit: number, paint: (line: string) => string) => {
    const lines = plainText(text, false, true).replace(/\s+$/, "").split("\n");
    if (lines.length === 1 && lines[0] === "") return;
    if (lines.length > limit) body.push(style.muted(`… ${lines.length - limit} earlier lines`));
    for (const kept of lines.slice(-limit)) body.push(paint(kept));
  };
  switch (item.kind) {
    case "command": {
      // The row shows the command's first line, wrapped; its other lines follow.
      for (const text of plainText(item.command).trim().split("\n").slice(1))
        body.push(style.soft(text));
      tail(item.output, DETAIL_OUTPUT_LINES, style.muted);
      break;
    }
    case "file_change":
      for (const change of item.changes) {
        if (item.changes.length > 1)
          body.push(style.text(displayPath(plainText(change.path, true), context.cwd)));
        const lines = diffBody(plainText(change.diff).split("\n"));
        for (const text of lines.slice(0, DETAIL_DIFF_LINES))
          body.push(diffLine(text, style.muted));
        if (lines.length > DETAIL_DIFF_LINES)
          body.push(style.muted(`… ${lines.length - DETAIL_DIFF_LINES} more lines`));
      }
      break;
    case "tool_call":
      tail(item.output, DETAIL_OUTPUT_LINES, style.muted);
      break;
    case "agent":
      tail(item.summary, DETAIL_OUTPUT_LINES, style.muted);
      break;
    case "web_search":
      break;
  }
  const rows = wrap(lead + line, width, hang, true);
  for (const text of body) rows.push(...wrap(`${hang}${text}`, width, hang, true));
  return rows;
}

/** Colors a shell command the way fx does: programs and operators brighter, flags softer. */
export function highlightCommand(command: string): string {
  const [head = "", ...rest] = plainText(command).trim().split("\n");
  const more = rest.length > 0 ? style.muted(" …") : "";
  let expectProgram = true;
  const tokens = head.split(/(\s+)/);
  return (
    tokens
      .map((token) => {
        if (token === "" || /^\s+$/.test(token)) return token;
        if (/^(&&|\|\||\||;|&)$/.test(token)) {
          expectProgram = true;
          return style.text(token);
        }
        if (expectProgram && !/^\w+=/.test(token)) {
          expectProgram = false;
          return style.text(token);
        }
        if (token.startsWith("-")) return style.soft(token);
        return style.muted(token);
      })
      .join("") + more
  );
}

function diffCounts(changes: readonly FileChange[]): string {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    for (const line of diffBody(change.diff.split("\n"))) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  if (added === 0 && removed === 0) return "";
  if (removed === 0) return ` +${added}`;
  return ` +${added} / -${removed}`;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** 1harness's own tools, in words: what each did, is doing, and the action itself. */
const OWN_TOOLS: Record<string, [string, string, string]> = {
  orchestrator_capabilities: [
    "Checked which harnesses can take tasks",
    "Checking which harnesses can take tasks",
    "checking harnesses",
  ],
  delegate_task: ["Handed off a task", "Handing off a task", "handing off a task"],
  task_status: ["Checked on a task", "Checking on a task", "checking on a task"],
  task_cancel: ["Cancelled a task", "Cancelling a task", "cancelling a task"],
  thread_list: ["Listed threads", "Listing threads", "listing threads"],
  thread_read: ["Read a thread", "Reading a thread", "reading a thread"],
  thread_send: ["Messaged a thread", "Messaging a thread", "messaging a thread"],
  thread_wait: ["Waited for a thread", "Waiting for a thread", "waiting for a thread"],
  thread_interrupt: ["Interrupted a thread", "Interrupting a thread", "interrupting a thread"],
};

/**
 * The thread or task one of 1harness's own tools acts on, from its input,
 * such as ` t13`; its input itself is JSON, which says nothing more here.
 */
function ownTarget(summary: string): string {
  try {
    const input = JSON.parse(summary) as Record<string, unknown>;
    const target = input["threadId"] ?? input["taskId"];
    return typeof target === "string" ? ` ${plainText(target, true)}` : "";
  } catch {
    return "";
  }
}

/** A tool call's name, with its server's but for 1harness's own, which adds nothing. */
function toolName(item: Extract<ToolItem, { kind: "tool_call" }>): string {
  return plainText(
    item.server && item.server !== "1harness" ? `${item.server}/${item.tool}` : item.tool,
    true,
  );
}

function asks(what: string): string {
  return `${style.attention("Asks to")} ${what}`;
}

/** What a tool call waiting for approval asks to do. */
function asking(item: ToolItem, cwd: string): string {
  switch (item.kind) {
    case "command":
      return asks(`${style.muted("run")} ${highlightCommand(item.command)}`);
    case "file_change": {
      const [change] = item.changes;
      const target =
        item.changes.length === 1 && change
          ? displayPath(plainText(change.path, true), cwd)
          : `${item.changes.length} files`;
      const verb = change?.kind === "add" ? "write" : change?.kind === "delete" ? "delete" : "edit";
      return asks(style.muted(`${verb} ${target}${diffCounts(item.changes)}`));
    }
    case "tool_call": {
      const name = toolName(item);
      const target = item.summary ? ` ${displayPath(plainText(item.summary, true), cwd)}` : "";
      return asks(style.muted(`use ${name}${target}`));
    }
    case "web_search":
      return asks(style.muted(`search the web for ${plainText(item.query, true)}`));
    case "agent":
      return asks(style.muted(`start an agent: ${plainText(item.description, true)}`));
  }
}

/** One row of a tool group: a verb in fx's tense, then the target. */
export function toolLine(item: ToolItem, settled: boolean, cwd: string, waiting = false): string {
  const running = item.status === "running";
  if (waiting && running && !settled) return asking(item, cwd);
  /** Picks the verb for the item's state; `noun` names the action when it did not happen. */
  const verb = (past: string, present: string, noun: string) => {
    const prefix = running && settled ? "Stopped" : item.status === "declined" ? "Declined" : "";
    if (prefix) return noun ? `${prefix} ${noun}` : prefix;
    if (item.status === "failed") return noun ? `Failed ${noun}` : "Failed";
    return running ? present : past;
  };
  switch (item.kind) {
    case "command": {
      const actions = exploration(item);
      // Codex parses commands that only explore, and its own UI shows what they did.
      if (actions && item.status !== "failed" && item.status !== "declined") {
        const done = !running || settled;
        return style.muted(actions.map((action) => describeAction(action, done, cwd)).join(", "));
      }
      const exited = item.exitCode !== null && item.exitCode !== 0;
      const word = exited && !running ? "Ran" : verb("Ran", "Running", "");
      const exit = exited ? style.muted(` · exit ${item.exitCode}`) : "";
      return `${style.muted(`${word} `)}${highlightCommand(item.command)}${exit}`;
    }
    case "file_change": {
      const [change] = item.changes;
      const kinds = new Set(item.changes.map((entry) => entry.kind));
      const kind = kinds.size === 1 ? change?.kind : "update";
      const target =
        item.changes.length === 1 && change
          ? displayPath(plainText(change.path, true), cwd)
          : `${item.changes.length} files`;
      if (item.changes.length === 1 && change?.movePath) {
        const moved = `${target} → ${displayPath(plainText(change.movePath, true), cwd)}`;
        return style.muted(
          `${verb("Moved", "Moving", "move")} ${moved}${diffCounts(item.changes)}`,
        );
      }
      const word =
        kind === "add"
          ? verb("Wrote", "Writing", "write")
          : kind === "delete"
            ? verb("Deleted", "Deleting", "delete")
            : verb("Edited", "Editing", "edit");
      return style.muted(`${word} ${target}${diffCounts(item.changes)}`);
    }
    case "web_search":
      return style.muted(
        `${verb("Searched web", "Searching web", "web search")} ${plainText(item.query, true)}`,
      );
    case "agent": {
      // The harness's own agents: what they are doing while running, then what they found.
      const summary = item.summary ? ` · ${plainText(firstLine(item.summary), true)}` : "";
      return style.muted(
        `${verb("Agent finished", "Agent working on", "agent")} ${plainText(item.description, true)}${summary}`,
      );
    }
    case "tool_call": {
      const target = item.summary ? ` ${displayPath(plainText(item.summary, true), cwd)}` : "";
      const failure =
        item.status === "failed" && item.output.trim() !== ""
          ? `: ${plainText(firstLine(item.output), true)}`
          : "";
      // 1harness's own tools say what they did; its server's name adds nothing.
      const own = item.server === "1harness" ? OWN_TOOLS[item.tool] : undefined;
      if (own) {
        const [past, present, noun] = own;
        return style.muted(`${verb(past, present, noun)}${ownTarget(item.summary)}${failure}`);
      }
      const name = toolName(item);
      const words: Record<Category, [string, string, string]> = {
        read: ["Read", "Reading", "read"],
        search: ["Searched", "Searching", "search"],
        fetch: ["Fetched", "Fetching", "fetch"],
        edit: [name, name, name],
        command: [name, name, name],
        web: [name, name, name],
        agent: [name, name, name],
        other: item.server ? [`Called ${name}`, `Calling ${name}`, name] : [name, name, name],
      };
      const [past, present, noun] = words[category(item)];
      return style.muted(`${verb(past, present, noun)}${target}${failure}`);
    }
  }
}

function describeAction(action: CommandAction, done: boolean, cwd: string): string {
  switch (action.type) {
    case "read":
      return `${done ? "Read" : "Reading"} ${displayPath(plainText(action.path, true), cwd)}`;
    case "list":
      return `${done ? "Listed" : "Listing"} ${action.path ? displayPath(plainText(action.path, true), cwd) : "files"}`;
    case "search": {
      const where = action.path ? ` in ${displayPath(plainText(action.path, true), cwd)}` : "";
      return `${done ? "Searched" : "Searching"} ${action.query ? plainText(action.query, true) : "files"}${where}`;
    }
    case "other":
      return "";
  }
}

// Agents 1harness runs

const STATUS_ORDER: readonly AgentStatus[] = [
  "needs you",
  "working",
  "starting",
  "failed",
  "stopped",
  "done",
  "idle",
];

/** One agent's rows: who and what with its status and timer, then what it found or asks. */
function agentRow(row: AgentRow, lead: string, hang: string, context: RenderContext): string[] {
  const time = formatElapsed((row.endedAt ?? context.now) - row.startedAt);
  // The title comes before the harness, so a narrow screen cuts the harness first.
  const title = plainText(row.title, true);
  const left = `${lead}${style.text(row.threadId)} ${style.strong(title)}  ${style.soft(row.label)}`;
  const right = `${paintStatus(row.status)} ${style.muted(time)}`;
  const shown = plainText(row.detail, true);
  const detail = row.status === "needs you" ? style.attention(shown) : style.muted(shown);
  const rows = [spread(left, right, context.width)];
  if (row.detail) rows.push(truncate(hang + detail, context.width));
  return rows;
}

function agentRows(block: Extract<Block, { kind: "agents" }>, context: RenderContext): string[] {
  const live = block.rows.some((row) => isLive(row.status));
  const [only] = block.rows;
  if (only && block.rows.length === 1) {
    const marker = live && !context.blink ? "  " : `${statusDot(only.status)} `;
    return agentRow(only, marker, "  ", context);
  }
  const counts = STATUS_ORDER.flatMap((status) => {
    const count = block.rows.filter((row) => row.status === status).length;
    return count > 0 ? [`${count} ${status}`] : [];
  });
  const marker = live && !context.blink ? " " : style.strong("●");
  const rows = [
    truncate(
      `${marker} ${style.muted([`${block.rows.length} agents`, ...counts].join(" · "))}`,
      context.width,
    ),
  ];
  block.rows.forEach((row, index) => {
    const last = index === block.rows.length - 1;
    rows.push(
      ...agentRow(row, style.muted(last ? "└ " : "├ "), style.muted(last ? "  " : "│ "), context),
    );
  });
  return rows;
}
