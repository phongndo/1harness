import type { Report } from "../commands/registry.ts";
import type { HarnessRequest, Item, NoticeLevel } from "../core/events.ts";
import type { Message } from "../core/thread.ts";
import { stripHandoff } from "../host/handoff.ts";
import type { LogEntry, TurnTokens } from "../protocol.ts";
import { formatTokens } from "../core/wording.ts";
import { reportStatus, type AgentRow } from "./agents.ts";
import {
  Transcript,
  changeCounts,
  failureText,
  groupSummary,
  isToolItem,
  type Block,
} from "./transcript.ts";

/** A turn's tokens up and down, as its activity line and summary say them: `(↑1.2k ↓350 tokens)`. */
export function tokenCounts(up: number, down: number): string {
  return `(↑${formatTokens(up)} ↓${formatTokens(down)} tokens)`;
}

/** What the view needs from the client to show an entry. */
export interface ViewContext {
  /** Whether the thread is working, so an item that arrives mid-turn starts its line. */
  busy: boolean;
  /** The row for a thread this one started, from what the client knows of it. */
  agent(threadId: string): AgentRow | null;
}

export type Phase = "Thinking" | "Generating";

/** The turn in progress, for the activity line. */
export interface TurnState {
  startedAt: number;
  up: number;
  down: number;
  phase: Phase;
  /** The heading of the latest reasoning summary, which Codex shows as its status. */
  heading: string | null;
}

/** Rough tokens for text, as fx estimates its live counters. */
function estimateTokens(text: string): number {
  return text.length / 4;
}

/** Reasoning so far, with its last bold heading, as Codex writes its summaries. */
interface Reasoning {
  text: string;
  heading: string | null;
  /** Where the last heading ends, before which nothing more is read. */
  end: number;
}

/** The most characters a heading takes, its markers with it. */
const HEADING_SPAN = 84;

/**
 * Reasoning grown to `text` from what `known` had read: only the text a new
 * heading could start in is read, since reasoning arrives a few characters
 * at a time and reading all of it for each would take ever longer.
 */
function reasoning(text: string, known?: Reasoning): Reasoning {
  const pattern = /\*\*([^*\n]{2,80})\*\*/g;
  let heading = known?.heading ?? null;
  let end = known?.end ?? 0;
  // A heading starting further back would have fit in the text already read.
  pattern.lastIndex = known ? Math.max(end, known.text.length - HEADING_SPAN + 1) : 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    heading = match[1]?.trim() ?? null;
    end = pattern.lastIndex;
  }
  return { text, heading, end };
}

/** How a message shows: the user's own, a task or message with who sent it, or a task's result. */
function messageBlock(echo: string, message: Message | undefined): Block {
  if (!message) return { kind: "user", text: stripHandoff(echo) };
  const { origin } = message;
  switch (origin.type) {
    case "user":
      return {
        kind: "user",
        text: message.input.text,
        ...(message.input.images?.length ? { images: message.input.images } : {}),
      };
    case "task":
      return { kind: "user", text: origin.task, label: `Task from ${origin.from}` };
    case "message":
      return { kind: "user", text: message.input.text, label: `Message from ${origin.from}` };
    case "report":
      return {
        kind: "result",
        from: origin.from,
        status: reportStatus(origin.status),
        text: origin.result,
      };
  }
}

/** A queued message in one line: the user's own text, or who sent it. */
export function queuedText(message: Message): string {
  const { origin } = message;
  switch (origin.type) {
    case "user":
      return message.input.text;
    case "task":
      return `task from ${origin.from}: ${origin.task}`;
    case "message":
      return `message from ${origin.from}: ${message.input.text}`;
    case "report":
      return `result from ${origin.from}`;
  }
}

/**
 * One thread as the terminal shows it: its transcript and the turn in
 * progress. A thread nobody is looking at keeps its view current, so
 * switching to it shows everything it did meanwhile.
 */
export class ThreadView {
  readonly id: string;
  readonly transcript = new Transcript();
  /** Item ID to the block that shows it. */
  readonly blocks = new Map<string, Block>();
  turn: TurnState | null = null;
  /** Rows the view sits above the bottom of the transcript; 0 follows new output. */
  scroll = 0;
  total = 0;
  /** The agents this thread started, by thread ID, and the blocks that show them. */
  #agents = new Map<string, Extract<Block, { kind: "agents" }>>();
  /** Tool calls that started agents, which the agents' rows show instead. */
  #agentCalls = new Set<string>();
  /** How many blocks the transcript had when the turn started. */
  #turnStart = 0;
  /** The turn's reasoning so far, by item, for its latest heading. */
  #reasoning = new Map<string, Reasoning>();
  /** Tool groups with calls an open approval is for. */
  #waiting = new Set<Extract<Block, { kind: "tools" }>>();
  /** Log entries applied, which the terminal's own lines are placed among. */
  #applied = 0;
  /** The terminal's own lines, and how many entries had been applied when each came. */
  #locals: { at: number; block: Block }[] = [];

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Shows one entry of the thread's log, live or replayed; replaying a log
   * shows what showing it live did.
   */
  apply(entry: LogEntry, context: ViewContext): void {
    // Streamed chunks are not kept for building a view again, so they are not counted.
    if (entry.type !== "delta") this.#applied++;
    switch (entry.type) {
      case "turn.started":
        this.startTurn(entry.at);
        break;
      case "turn.ended":
        this.endTurn(entry.status, entry.error, entry);
        break;
      case "item":
        this.item(entry.item, entry.done, context.busy, entry.message);
        break;
      case "delta":
        this.delta(entry.itemId, entry.chunk);
        break;
      case "agent": {
        const row = context.agent(entry.threadId);
        if (row) this.agent(row);
        break;
      }
      case "html":
        this.transcript.add({ kind: "html", title: entry.title, html: entry.html });
        break;
      case "session.ended":
        this.endTurn(null, null);
        this.settle();
        if (entry.error)
          this.notice("error", `Session ended: ${entry.error}\nYour next message starts it again.`);
        break;
      case "decision":
        this.transcript.add({
          kind: "decision",
          request: entry.kind,
          title: entry.title,
          answer: entry.answer,
          outcome: entry.outcome,
        });
        break;
    }
  }

  /**
   * Marks the tool calls the thread's open approvals are for, which wait for
   * the user rather than run: a command by its text, an edit by its files, a
   * tool by its name.
   */
  awaiting(requests: readonly HarnessRequest[]): void {
    const approvals = requests.filter((request) => request.kind === "approval");
    // Most updates come with nothing asked and nothing marked, and change nothing.
    if (approvals.length === 0 && this.#waiting.size === 0) return;
    const waiting = new Set<string>();
    for (const request of approvals) {
      const { action } = request;
      for (const [id, block] of this.blocks) {
        if (block.kind !== "tools" || block.settled) continue;
        const item = block.items.find((candidate) => candidate.id === id);
        if (item?.status !== "running") continue;
        const matches =
          (action.type === "command" &&
            item.kind === "command" &&
            item.command.trim() === action.command.trim()) ||
          (action.type === "file_change" &&
            item.kind === "file_change" &&
            item.changes.some((change) => action.paths.includes(change.path))) ||
          (action.type === "tool" &&
            ((item.kind === "tool_call" &&
              (item.tool === action.tool || action.tool.endsWith(`__${item.tool}`)) &&
              (action.server === null || item.server === action.server)) ||
              (item.kind === "web_search" && action.tool === "WebSearch") ||
              (item.kind === "agent" && (action.tool === "Agent" || action.tool === "Task"))));
        if (matches) waiting.add(id);
      }
    }
    const blocks = new Set(this.#waiting);
    for (const id of waiting) {
      const block = this.blocks.get(id);
      if (block?.kind === "tools") blocks.add(block);
    }
    this.#waiting.clear();
    for (const block of blocks) {
      const before = block.awaiting ?? [];
      const now = block.items.filter((item) => waiting.has(item.id)).map((item) => item.id);
      if (now.length > 0) this.#waiting.add(block);
      if (before.length === now.length && before.every((id) => now.includes(id))) continue;
      block.awaiting = now;
      this.transcript.touch(block);
    }
  }

  /**
   * Shows a line of the terminal's own, such as a notice or a command's
   * report, and keeps where it goes among the log's entries, for `rebuild`.
   */
  local<T extends Block>(block: T): T {
    this.transcript.add(block);
    this.#locals.push({ at: this.#applied, block });
    return block;
  }

  /** Takes back a line of the terminal's own that no longer holds. */
  unsay(block: Block): void {
    this.transcript.remove(block);
    this.#locals = this.#locals.filter((local) => local.block !== block);
  }

  /** A notice of the terminal's own. */
  say(level: NoticeLevel, text: string): Extract<Block, { kind: "notice" }> {
    return this.local({ kind: "notice", level, text });
  }

  /**
   * Shows `entries` from the start, as one log, with the terminal's own lines
   * of `from` back where they were among them; `shift` entries come before the
   * ones `from` showed. `earlier` says, at the top, that more is above.
   * For a view built again with earlier entries loaded.
   */
  rebuild(
    from: ThreadView,
    entries: readonly LogEntry[],
    shift: number,
    context: ViewContext,
    earlier: string | null,
  ): void {
    const locals = from.#locals.map((local) => ({ at: local.at + shift, block: local.block }));
    let next = 0;
    const place = (upTo: number) => {
      for (let local = locals[next]; local && local.at <= upTo; local = locals[++next]) {
        this.transcript.add(local.block);
        this.#locals.push(local);
      }
    };
    if (earlier) this.notice("info", earlier);
    for (const [index, entry] of entries.entries()) {
      place(index);
      this.apply(entry, context);
    }
    place(Number.POSITIVE_INFINITY);
  }

  /**
   * A notice that comes of the log, such as why a turn failed, which
   * building the view again from the log shows again; `say` keeps its own.
   */
  notice(level: NoticeLevel, text: string): void {
    this.transcript.add({ kind: "notice", level, text });
  }

  report(report: Report): void {
    this.local({ kind: "report", ...report });
    this.scroll = 0;
  }

  startTurn(at: number = Date.now()): void {
    if (this.turn) return;
    this.turn = { startedAt: at, up: 0, down: 0, phase: "Thinking", heading: null };
    this.#turnStart = this.transcript.size;
  }

  /** Whether the transcript shows a row for this agent. */
  hasAgent(threadId: string): boolean {
    return this.#agents.has(threadId);
  }

  /**
   * Shows or updates an agent this thread started, in place of the call that
   * started it where the row says which. An agent joins the block of the one
   * before it when nothing came between them, as when a turn starts several at
   * once with parallel calls.
   */
  agent(row: AgentRow): void {
    if (row.callId) this.#hideCall(row.callId);
    const shown = this.#agents.get(row.threadId);
    if (shown) {
      const index = shown.rows.findIndex((other) => other.threadId === row.threadId);
      shown.rows[index] = row;
      this.transcript.touch(shown);
      return;
    }
    // Todo lists and groups left empty by calls that started agents show nothing between them.
    const last = this.transcript.last(
      (block) => block.kind === "todos" || (block.kind === "tools" && block.items.length === 0),
    );
    const block =
      last?.kind === "agents" ? last : this.transcript.add({ kind: "agents", rows: [] });
    block.rows.push(row);
    this.#agents.set(row.threadId, block);
    this.transcript.touch(block);
  }

  /**
   * Closes the turn with fx's duration line. Commands can outlive the turn, as
   * Codex's background terminals do, so their rows stay live until they finish.
   */
  endTurn(
    status: "completed" | "interrupted" | "failed" | null,
    error: string | null,
    ended?: TurnTokens & { at: number },
  ): void {
    for (const [id, block] of this.blocks) {
      // Todo lists keep one ID across turns, but each turn shows its own.
      if (block.kind === "todos") this.blocks.delete(id);
    }
    this.#reasoning.clear();
    const turn = this.turn;
    this.turn = null;
    if (status === null) return;
    // Only commands outlive their turn, so other calls still running were cut off,
    // even in a group whose command goes on. A turn begun before what the view
    // loaded settles from the top.
    for (const block of this.transcript.since(turn ? this.#turnStart : 0)) {
      if (block.kind !== "tools" || block.settled) continue;
      if (block.items.some((item) => item.kind === "command" && item.status === "running")) {
        block.cut = block.items
          .filter((item) => item.kind !== "command" && item.status === "running")
          .map((item) => item.id);
      } else block.settled = true;
      this.transcript.touch(block);
    }
    this.#fold(this.transcript.since(turn ? this.#turnStart : 0));
    if (!turn) {
      if (status === "failed" && error) this.notice("error", error);
      return;
    }
    // The log's own counts, so a replayed turn reads as it did live.
    const seconds = Math.round(((ended?.at ?? Date.now()) - turn.startedAt) / 1000);
    const up = ended?.up ?? Math.ceil(turn.up);
    const down = ended?.down ?? Math.ceil(turn.down);
    const tokens = tokenCounts(up, down);
    const label =
      status === "interrupted" ? "Interrupted · " : status === "failed" ? "Failed · " : "Done · ";
    const next = status === "failed" ? " · send a message to try again" : "";
    // A harness that reported the failure as it happened already said why.
    const said = this.transcript
      .since(this.#turnStart)
      .some((block) => block.kind === "notice" && block.level === "error");
    this.transcript.add({ kind: "summary", text: `${label}${seconds}s ${tokens}${next}` });
    if (status === "failed" && error && !said) this.notice("error", error);
  }

  /**
   * Folds a finished turn's work, its tool calls, thoughts, and todo lists, into
   * one line where the work began, with the files it changed. Calls still running,
   * as a command the turn left going, stay in view; so do agents and answers.
   */
  #fold(blocks: readonly Block[]): void {
    const work = blocks.filter(
      (block) =>
        !("folded" in block && block.folded) &&
        ((block.kind === "tools" && block.settled && block.items.length > 0) ||
          block.kind === "thinking" ||
          block.kind === "todos"),
    );
    const items = work.flatMap((block) => (block.kind === "tools" ? block.items : []));
    if (items.length === 0) {
      // A turn of thought alone folds it away, with no line to say so.
      for (const block of work)
        if (block.kind === "thinking") {
          block.folded = true;
          this.transcript.touch(block);
        }
      return;
    }
    const files = new Map<string, { path: string; added: number; removed: number }>();
    for (const item of items) {
      if (item.kind !== "file_change") continue;
      for (const change of item.changes) {
        const path = change.movePath ?? change.path;
        const counts = changeCounts(change);
        const known = files.get(path) ?? { path, added: 0, removed: 0 };
        known.added += counts.added;
        known.removed += counts.removed;
        files.set(path, known);
      }
    }
    const [first] = work;
    if (!first) return;
    this.transcript.insertBefore<Extract<Block, { kind: "worked" }>>(
      {
        kind: "worked",
        text: groupSummary(items),
        files: [...files.values()],
        failures: items.filter((item) => item.status === "failed").map(failureText),
      },
      first,
    );
    for (const block of work) {
      if (block.kind === "tools" || block.kind === "thinking" || block.kind === "todos") {
        block.folded = true;
        this.transcript.touch(block);
      }
    }
  }

  /** Takes a call that started an agent out of its tool group, now and when it updates. */
  #hideCall(id: string): void {
    if (this.#agentCalls.has(id)) return;
    this.#agentCalls.add(id);
    const block = this.blocks.get(id);
    if (block?.kind !== "tools") return;
    this.blocks.delete(id);
    block.items = block.items.filter((item) => item.id !== id);
    this.transcript.touch(block);
  }

  /** Marks tool rows that will never finish, once their session has gone. */
  settle(): void {
    for (const block of new Set(this.blocks.values())) {
      if (block.kind !== "tools" || block.settled) continue;
      block.settled = true;
      this.transcript.touch(block);
    }
  }

  /** Shows an item; `message` is the one a `user_message` echoes, when the thread knows it. */
  item(item: Item, completed: boolean, busy: boolean, message?: Message): void {
    if (busy && item.kind !== "notice") this.startTurn();
    const existing = this.blocks.get(item.id);
    // A thought from a step ago would read as what the agent is doing now.
    if (this.turn && !existing && (isToolItem(item) || item.kind === "assistant_message"))
      for (const block of this.transcript.since(this.#turnStart))
        if (block.kind === "thinking" && !block.folded) {
          block.folded = true;
          this.transcript.touch(block);
        }
    switch (item.kind) {
      case "user_message": {
        const shown = messageBlock(item.text, message);
        if (existing?.kind === shown.kind) {
          Object.assign(existing, shown);
          this.transcript.touch(existing);
          return;
        }
        this.blocks.set(item.id, this.transcript.add(shown));
        if (this.turn) this.turn.up += estimateTokens(item.text);
        this.scroll = 0;
        return;
      }
      case "assistant_message": {
        const block =
          existing?.kind === "assistant"
            ? existing
            : this.transcript.add({ kind: "assistant", text: "" });
        this.blocks.set(item.id, block);
        if (this.turn && item.text.length > block.text.length)
          this.turn.down += estimateTokens(item.text.slice(block.text.length));
        if (item.text.length >= block.text.length || completed) block.text = item.text;
        this.transcript.touch(block);
        if (completed && this.turn) this.turn.phase = "Thinking";
        return;
      }
      case "reasoning": {
        const read = reasoning(item.text);
        this.#reasoning.set(item.id, read);
        if (this.turn) {
          this.turn.phase = "Thinking";
          this.turn.heading = read.heading ?? this.turn.heading;
        }
        // A thought shows where it came, as a quiet line.
        const block =
          existing?.kind === "thinking"
            ? existing
            : this.transcript.add<Extract<Block, { kind: "thinking" }>>({
                kind: "thinking",
                text: "",
              });
        this.blocks.set(item.id, block);
        block.text = item.text;
        this.transcript.touch(block);
        return;
      }
      case "plan": {
        const block =
          existing?.kind === "plan" ? existing : this.transcript.add({ kind: "plan", text: "" });
        this.blocks.set(item.id, block);
        block.text = item.text;
        this.transcript.touch(block);
        return;
      }
      case "todo_list": {
        const block =
          existing?.kind === "todos"
            ? existing
            : this.transcript.add({ kind: "todos", steps: item.steps });
        this.blocks.set(item.id, block);
        block.steps = item.steps;
        this.transcript.touch(block);
        return;
      }
      case "notice": {
        // Notices with a stable ID, such as retries, update one line.
        if (existing?.kind === "notice") {
          existing.level = item.level;
          existing.text = item.text;
          this.transcript.touch(existing);
          return;
        }
        const block = this.transcript.add({ kind: "notice", level: item.level, text: item.text });
        if (item.id) this.blocks.set(item.id, block);
        return;
      }
    }
    if (!isToolItem(item) || this.#agentCalls.has(item.id)) return;
    if (existing?.kind === "tools") {
      const index = existing.items.findIndex((other) => other.id === item.id);
      if (index === -1) existing.items.push(item);
      else existing.items[index] = item;
      this.transcript.touch(existing);
      return;
    }
    // A todo list updated between tool calls does not split their group.
    const last = this.transcript.last((block) => block.kind === "todos");
    const block =
      last?.kind === "tools" && !last.settled
        ? last
        : this.transcript.add<Extract<Block, { kind: "tools" }>>({
            kind: "tools",
            items: [],
            settled: false,
          });
    block.items.push(item);
    this.blocks.set(item.id, block);
    this.transcript.touch(block);
  }

  delta(itemId: string, chunk: string): void {
    if (this.turn) this.turn.down += estimateTokens(chunk);
    const block = this.blocks.get(itemId);
    if (block?.kind === "assistant" || block?.kind === "plan") {
      block.text += chunk;
      this.transcript.touch(block);
      if (this.turn) this.turn.phase = "Generating";
      return;
    }
    if (block?.kind === "tools") {
      const index = block.items.findIndex((item) => item.id === itemId);
      const item = block.items[index];
      if (item?.kind === "command") {
        block.items[index] = { ...item, output: item.output + chunk };
        this.transcript.touch(block);
      }
      return;
    }
    const known = this.#reasoning.get(itemId);
    if (known === undefined) return;
    const read = reasoning(known.text + chunk, known);
    this.#reasoning.set(itemId, read);
    if (block?.kind === "thinking") {
      block.text = read.text;
      this.transcript.touch(block);
    }
    if (this.turn) {
      this.turn.phase = "Thinking";
      this.turn.heading = read.heading ?? this.turn.heading;
    }
  }
}
