import { modeRank, type RuntimeMode } from "../core/events.ts";
import type { MessageOrigin, Thread } from "../core/thread.ts";
import { OperationError, type Caller } from "../operations/operation.ts";
import type { ManagedThread, ThreadManager } from "./manager.ts";

/** A thread as a read sees it: one in memory, or a closed one only the store keeps. */
export type ThreadSnapshot = Pick<
  ManagedThread,
  "id" | "title" | "harness" | "status" | "parentId" | "runs" | "worktree"
> & { readonly thread: Pick<Thread, "info" | "requests"> };

/**
 * Which threads a caller may see and act on. People see and act on every
 * thread. An agent in a 1harness thread sees its tree, from the user's thread
 * at its root down, and acts on none allowed more than itself. An agent
 * outside 1harness sees every thread and acts on none allowed more than the
 * mode the user lets such agents have.
 */
export class Scope {
  #manager: ThreadManager;
  #stored: (id: string) => ThreadSnapshot | null;

  /** `stored` finds a thread the store keeps that has left memory, such as a closed one. */
  constructor(manager: ThreadManager, stored: (id: string) => ThreadSnapshot | null = () => null) {
    this.#manager = manager;
    this.#stored = stored;
  }

  /** The thread an agent calls from. */
  agent(caller: Caller): ManagedThread {
    const managed = caller.kind === "agent" ? this.#manager.byThread(caller.thread) : undefined;
    if (!managed)
      throw new OperationError(
        "orchestration_error",
        "the calling thread is not managed by 1harness",
      );
    return managed;
  }

  /** Where a message the caller sends says it came from. */
  sender(caller: Caller): MessageOrigin {
    if (caller.kind === "user") return { type: "user" };
    return {
      type: "message",
      from: caller.kind === "agent" ? this.agent(caller).id : "an agent outside 1harness",
    };
  }

  /** The most a thread the caller starts or acts on may be allowed; null for no limit. */
  ceiling(caller: Caller): RuntimeMode | null {
    if (caller.kind === "user") return null;
    if (caller.kind === "external") return caller.ceiling;
    return this.agent(caller).thread.info.runtimeMode;
  }

  /** The user's thread at the root of a thread's tree. */
  root(thread: ManagedThread): ManagedThread {
    const parent = thread.parentId ? this.#manager.get(thread.parentId) : undefined;
    return parent ? this.root(parent) : thread;
  }

  /** A thread and every thread under its root. */
  tree(thread: ManagedThread): ManagedThread[] {
    const root = this.root(thread);
    return [root, ...this.#manager.descendants(root.id)];
  }

  /** The threads in memory the caller may see. */
  visible(caller: Caller): ManagedThread[] {
    return caller.kind === "agent" ? this.tree(this.agent(caller)) : this.#manager.list();
  }

  /**
   * A thread the caller may read. For an agent, one in its tree, or with
   * `forked`, one its tree was forked from, whose turns its handoff points to.
   */
  readable(caller: Caller, id: string, forked = false): ThreadSnapshot {
    const thread = this.#manager.get(id);
    if (caller.kind !== "agent") {
      const found = thread ?? this.#stored(id);
      if (!found) throw new OperationError("thread_not_found", `no thread ${id}`);
      return found;
    }
    const agent = this.agent(caller);
    const ours = thread && this.root(thread) === this.root(agent);
    if (!thread || (!ours && !(forked && this.#forkedFrom(agent).has(thread.id))))
      throw new OperationError("thread_not_found", `no thread ${id} in your tree`);
    return thread;
  }

  /** An open thread the caller may act on: never one allowed more than the caller. */
  actable(caller: Caller, id: string): ManagedThread {
    const found = this.readable(caller, id);
    if (caller.kind === "agent" && found.id === this.agent(caller).id)
      throw new OperationError("invalid_request", "use your own turn for your own thread");
    const target = this.#manager.get(found.id);
    if (!target || target.status === "closed")
      throw new OperationError("thread_closed", `thread ${found.id} is closed`);
    this.allows(caller, target.thread.info.runtimeMode, target.thread.info.interactionMode, target);
    return target;
  }

  /** Refuses work in `mode`, or out of plan mode, beyond what the caller is allowed. */
  allows(
    caller: Caller,
    mode: RuntimeMode,
    interaction: "default" | "plan",
    target?: ThreadSnapshot,
  ): void {
    const ceiling = this.ceiling(caller);
    if (ceiling === null) return;
    const what = target ? `thread ${target.id} runs ${mode}` : `${mode} work`;
    if (modeRank(mode) > modeRank(ceiling))
      throw new OperationError(
        "runtime_mode_escalation_denied",
        caller.kind === "agent"
          ? target
            ? `${what}, more than this thread's ${ceiling}`
            : `a ${ceiling} thread cannot start ${mode} work`
          : `${what}, more than agents outside 1harness may start or act on (${ceiling}); agentMode in settings.json sets that`,
      );
    if (
      caller.kind === "agent" &&
      this.agent(caller).thread.info.interactionMode === "plan" &&
      interaction !== "plan"
    )
      throw new OperationError(
        "interaction_mode_escalation_denied",
        target
          ? "a thread in plan mode can only act on planning threads"
          : "a thread in plan mode can only start planning work",
      );
  }

  /** The threads the agent's tree was forked from, and the ones those were forked from. */
  #forkedFrom(agent: ManagedThread): Set<string> {
    const sources = new Set<string>();
    let source = this.root(agent).forkedFrom;
    while (source && !sources.has(source)) {
      sources.add(source);
      const thread = this.#manager.get(source);
      source = thread ? this.root(thread).forkedFrom : null;
    }
    return sources;
  }
}
