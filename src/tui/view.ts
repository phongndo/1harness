import type { Report } from "../commands/registry.ts";
import type { Item } from "../core/events.ts";
import type { Message, Thread, ThreadEvent } from "../core/thread.ts";
import { stripHandoff } from "../host/handoff.ts";
import { reportStatus, type AgentRow } from "./agents.ts";
import { Transcript, formatTokens, isToolItem, type Block } from "./transcript.ts";

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

/** The last bold heading in reasoning text, as Codex writes its summaries. */
function reasoningHeading(text: string): string | null {
  const headings = [...text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)];
  return headings.at(-1)?.[1]?.trim() ?? null;
}

/** How a message shows: the user's own, a task or message with who sent it, or a task's result. */
function messageBlock(echo: string, message: Message | undefined): Block {
  if (!message) return { kind: "user", text: stripHandoff(echo) };
  const { origin } = message;
  switch (origin.type) {
    case "user":
      return { kind: "user", text: message.input.text };
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

  constructor(id: string) {
    this.id = id;
  }

  /** Shows a thread event; `thread` is the one it came from. */
  apply(event: ThreadEvent, thread: Thread): void {
    switch (event.type) {
      case "turn.started":
        this.startTurn();
        break;
      case "turn.ended":
        this.endTurn(event.status, event.error);
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const { item } = event;
        // The message a user_message echoes, where the harness says which it is.
        const sent =
          item.kind === "user_message" && item.inputId ? thread.message(item.inputId) : undefined;
        this.item(item, event.type === "item.completed", thread.busy, sent);
        break;
      }
      case "item.delta":
        this.delta(event.itemId, event.chunk, thread);
        break;
      case "error":
        this.notice("error", event.message);
        break;
      case "session.closed":
        this.endTurn(null, null);
        this.settle();
        if (event.error)
          this.notice("error", `Session ended: ${event.error}\nUse /new to start again.`);
        break;
      default:
        break;
    }
  }

  notice(level: "info" | "warning" | "error", text: string): void {
    this.transcript.add({ kind: "notice", level, text });
  }

  report(report: Report): void {
    this.transcript.add({ kind: "report", ...report });
    this.scroll = 0;
  }

  startTurn(): void {
    if (this.turn) return;
    this.turn = { startedAt: Date.now(), up: 0, down: 0, phase: "Thinking", heading: null };
    this.#turnStart = this.transcript.size;
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
  endTurn(status: "completed" | "interrupted" | "failed" | null, error: string | null): void {
    for (const [id, block] of this.blocks) {
      // Todo lists keep one ID across turns, but each turn shows its own.
      if (block.kind === "todos") this.blocks.delete(id);
    }
    const turn = this.turn;
    this.turn = null;
    if (!turn || status === null) return;
    // Only commands outlive their turn, so other calls still running were cut off.
    for (const block of this.transcript.since(this.#turnStart)) {
      if (block.kind !== "tools" || block.settled) continue;
      if (block.items.some((item) => item.kind === "command" && item.status === "running"))
        continue;
      block.settled = true;
      this.transcript.touch(block);
    }
    const seconds = Math.round((Date.now() - turn.startedAt) / 1000);
    const tokens = `(↑${formatTokens(Math.ceil(turn.up))} ↓${formatTokens(Math.ceil(turn.down))})`;
    const label =
      status === "interrupted" ? "Interrupted · " : status === "failed" ? "Failed · " : "";
    this.transcript.add({ kind: "summary", text: `${label}${seconds}s ${tokens}` });
    if (status === "failed" && error) this.notice("error", error);
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
      case "reasoning":
        if (this.turn) {
          this.turn.phase = "Thinking";
          this.turn.heading = reasoningHeading(item.text) ?? this.turn.heading;
        }
        return;
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
        : this.transcript.add({ kind: "tools", items: [], settled: false });
    block.items.push(item);
    this.blocks.set(item.id, block);
    this.transcript.touch(block);
  }

  delta(itemId: string, chunk: string, thread: Thread): void {
    if (this.turn) this.turn.down += estimateTokens(chunk);
    const block = this.blocks.get(itemId);
    if (block?.kind === "assistant" || block?.kind === "plan") {
      block.text += chunk;
      this.transcript.touch(block);
      if (this.turn) this.turn.phase = "Generating";
      return;
    }
    const item = thread.item(itemId);
    if (this.turn && item?.kind === "reasoning") {
      this.turn.phase = "Thinking";
      this.turn.heading = reasoningHeading(item.text) ?? this.turn.heading;
    }
  }
}
