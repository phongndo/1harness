import { isAbsolute, relative } from "node:path";
import type { ReportSpan } from "../commands/registry.ts";
import type { CommandAction, FileChange, Item, TodoStep } from "../core/events.ts";
import { renderMarkdown } from "./markdown.ts";
import { style } from "./theme.ts";
import { truncate, visibleWidth, wrap } from "./text.ts";

export type ToolItem = Extract<
  Item,
  { kind: "command" | "file_change" | "tool_call" | "web_search" | "subagent" }
>;

export type Block =
  | { kind: "banner"; title: string; subtitle: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "plan"; text: string }
  /** Consecutive tool items, shown as one tree. Settled once their turn has ended. */
  | { kind: "tools"; items: ToolItem[]; settled: boolean }
  | { kind: "todos"; steps: TodoStep[] }
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
  /** A 1harness command's output, such as /mcp: a heading over aligned lines. */
  | { kind: "report"; title: string; lines: ReportSpan[][] }
  /** The muted line that closes a turn: duration and token estimate. */
  | { kind: "summary"; text: string };

export interface RenderContext {
  width: number;
  cwd: string;
  /** Phase of the shared blink, for markers of work in progress. */
  blink: boolean;
}

interface Entry {
  block: Block;
  version: number;
  cache: { width: number; version: number; blink: boolean; rows: string[] } | null;
}

const USER_LINES = 24;

export function isToolItem(item: Item): item is ToolItem {
  return (
    item.kind === "command" ||
    item.kind === "file_change" ||
    item.kind === "tool_call" ||
    item.kind === "web_search" ||
    item.kind === "subagent"
  );
}

export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

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
    return this.#entries.some((entry) => isRunningGroup(entry.block));
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
    const blink = isRunningGroup(entry.block) && context.blink;
    const cache = entry.cache;
    if (
      cache &&
      cache.width === context.width &&
      cache.version === entry.version &&
      cache.blink === blink
    ) {
      return cache.rows;
    }
    const rows = renderBlock(entry.block, context);
    entry.cache = { width: context.width, version: entry.version, blink, rows };
    return rows;
  }
}

function isRunningGroup(block: Block): boolean {
  return (
    block.kind === "tools" &&
    !block.settled &&
    block.items.some((item) => item.status === "running")
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
      return userRows(block.text, width);
    case "assistant":
      return block.text.trim() === "" ? [] : renderMarkdown(block.text, width);
    case "plan":
      return [
        `${style.strong("●")} ${style.bold("Proposed plan")}`,
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
    case "summary":
      return [truncate(style.muted(`  ${block.text}`), width)];
  }
}

function userRows(text: string, width: number): string[] {
  const marker = `${style.strong("┃")} `;
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, USER_LINES);
  const rows = shown.flatMap((line) => wrap(marker + style.bold(line), width, marker));
  if (lines.length > shown.length)
    rows.push(marker + style.muted(`… ${lines.length - shown.length} more lines`));
  return rows;
}

function noticeRows(block: Extract<Block, { kind: "notice" }>, width: number): string[] {
  const label = block.level === "error" ? "Error " : block.level === "warning" ? "Warning " : "";
  return block.text
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
  const rows = [`${style.strong("●")} ${style.text(block.title)}`];
  for (const spans of block.lines) {
    if (spans.length === 0) {
      rows.push("");
      continue;
    }
    const head = spans.slice(0, -1);
    const last = spans.at(-1);
    const lead = `  ${head.map((span) => TONES[span.tone](span.text)).join("")}`;
    const hang = " ".repeat(2 + visibleWidth(head.map((span) => span.text).join("")));
    rows.push(...wrap(lead + (last ? TONES[last.tone](last.text) : ""), width, hang));
  }
  return rows;
}

function todoRows(steps: readonly TodoStep[], width: number): string[] {
  const done = steps.filter((step) => step.status === "completed").length;
  const rows = [`${style.strong("●")} ${style.muted(`Todos · ${done} of ${steps.length} done`)}`];
  steps.forEach((step, index) => {
    const branch = style.muted(index === steps.length - 1 ? "└ " : "├ ");
    const text =
      step.status === "completed"
        ? style.muted(`✓ ${step.text}`)
        : step.status === "in_progress"
          ? style.bold(style.strong(`▪ ${step.text}`))
          : style.text(`○ ${step.text}`);
    rows.push(truncate(branch + text, width));
  });
  return rows;
}

// Tool groups

type Category = "read" | "edit" | "command" | "search" | "fetch" | "agent" | "other";

const CATEGORY_NAMES: Record<Category, [string, string]> = {
  read: ["read", "reads"],
  edit: ["edit", "edits"],
  command: ["command", "commands"],
  search: ["search", "searches"],
  fetch: ["fetch", "fetches"],
  agent: ["agent", "agents"],
  other: ["other", "other"],
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
      return "search";
    case "subagent":
      return "agent";
    case "tool_call":
      return item.category;
  }
}

function groupSummary(items: readonly ToolItem[]): string {
  const counts = new Map<Category, number>();
  for (const item of items) counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
  const parts = [`${items.length} tool ${items.length === 1 ? "call" : "calls"}`];
  for (const [name, [one, many]] of Object.entries(CATEGORY_NAMES)) {
    const count = counts.get(name as Category);
    if (count) parts.push(`${count} ${count === 1 ? one : many}`);
  }
  const failed = items.filter((item) => item.status === "failed").length;
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

function toolRows(block: Extract<Block, { kind: "tools" }>, context: RenderContext): string[] {
  const running = !block.settled && block.items.some((item) => item.status === "running");
  const marker = running && !context.blink ? " " : style.strong("●");
  const rows = [truncate(`${marker} ${style.muted(groupSummary(block.items))}`, context.width)];
  block.items.forEach((item, index) => {
    const branch = style.muted(index === block.items.length - 1 ? "└ " : "├ ");
    rows.push(truncate(branch + toolLine(item, block.settled, context.cwd), context.width));
  });
  return rows;
}

/** Colors a shell command the way fx does: programs and operators brighter, flags softer. */
export function highlightCommand(command: string): string {
  const [head = "", ...rest] = command.trim().split("\n");
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
    for (const line of change.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
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

/** One row of a tool group: a verb in fx's tense, then the target. */
export function toolLine(item: ToolItem, settled: boolean, cwd: string): string {
  const running = item.status === "running";
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
          ? displayPath(change.path, cwd)
          : `${item.changes.length} files`;
      if (item.changes.length === 1 && change?.movePath) {
        const moved = `${target} → ${displayPath(change.movePath, cwd)}`;
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
      return style.muted(`${verb("Searched web", "Searching web", "web search")} ${item.query}`);
    case "subagent": {
      const summary = item.summary && !running ? `: ${firstLine(item.summary)}` : "";
      return style.muted(
        `${verb("Delegated", "Delegating", "agent")} ${item.description}${summary}`,
      );
    }
    case "tool_call": {
      const target = item.summary ? ` ${displayPath(item.summary, cwd)}` : "";
      const failure =
        item.status === "failed" && item.output.trim() !== "" ? `: ${firstLine(item.output)}` : "";
      const name = item.server ? `${item.server}/${item.tool}` : item.tool;
      const words: Record<Category, [string, string, string]> = {
        read: ["Read", "Reading", "read"],
        search: ["Searched", "Searching", "search"],
        fetch: ["Fetched", "Fetching", "fetch"],
        edit: [name, name, name],
        command: [name, name, name],
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
      return `${done ? "Read" : "Reading"} ${displayPath(action.path, cwd)}`;
    case "list":
      return `${done ? "Listed" : "Listing"} ${action.path ? displayPath(action.path, cwd) : "files"}`;
    case "search": {
      const where = action.path ? ` in ${displayPath(action.path, cwd)}` : "";
      return `${done ? "Searched" : "Searching"} ${action.query ?? "files"}${where}`;
    }
    case "other":
      return "";
  }
}
