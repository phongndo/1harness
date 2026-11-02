import type { HarnessId } from "../core/events.ts";
import type { ThreadEvent } from "../core/thread.ts";
import type { LoggedEntry } from "../protocol.ts";
import type { Store, TaskRow, ThreadRow } from "../store/store.ts";
import type { ThreadLog } from "./log.ts";
import type { ManagedThread, Visit } from "./manager.ts";

/** How long streamed text waits to be written, so a long reply is not rewritten on every chunk. */
const STREAM_FLUSH_MS = 250;
/** How long after a failed write the store is tried again, in case the disk has recovered. */
const STORE_RETRY_MS = 5_000;

/** What the writer reads of the host's threads to write them. */
export interface WriterSource {
  thread(id: string): ManagedThread | undefined;
  row(managed: ManagedThread): ThreadRow;
  visits(id: string): ReadonlyMap<HarnessId, Visit>;
  /** Every thread's log in memory, whose unwritten entries are written. */
  logs(): Iterable<[string, ThreadLog]>;
  tasks(): TaskRow[];
  /** The feed's newest number, which the next host goes on from. */
  seq(): number;
  /** Writing failed, reported once until a write works again. */
  failed(error: unknown): void;
}

/**
 * Writes the host's threads to its store as they change: soon after, in one
 * transaction, and again later when the disk fails, while the threads go on.
 * Messages are written as they are admitted, before the harness gets them.
 */
export class StoreWriter {
  #store: Store;
  #source: WriterSource;
  /** Threads whose rows changed since the store was last written. */
  #dirty = new Set<string>();
  #flushTimer: NodeJS.Immediate | null = null;
  #streamTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  /** Admissions a failed write left out, in order. */
  #unadmitted: [ManagedThread, ThreadEvent][] = [];
  /** Each task as last written. */
  #savedTasks = new Map<string, string>();
  #failing = false;
  #stopped = false;

  constructor(store: Store, source: WriterSource) {
    this.#store = store;
    this.#source = source;
  }

  /** The last write failed, so the store may not have what memory has. */
  get failing(): boolean {
    return this.#failing;
  }

  /** IDs of threads the writer keeps anything for. */
  get tracked(): Iterable<string> {
    return [...this.#dirty, ...this.#savedTasks.keys()];
  }

  /** A thread's row changed; it is written with the next flush. */
  mark(id: string): void {
    this.#dirty.add(id);
  }

  /**
   * Writes what changed soon: on the next tick, or for streamed text, which
   * rewrites a growing entry, within `STREAM_FLUSH_MS`.
   */
  schedule(streaming = false): void {
    if (this.#stopped || this.#flushTimer) return;
    if (streaming) {
      this.#streamTimer ??= setTimeout(() => {
        this.#streamTimer = null;
        this.flush();
      }, STREAM_FLUSH_MS);
      return;
    }
    this.#flushTimer = setImmediate(() => {
      this.#flushTimer = null;
      this.flush();
    });
  }

  /** Writes what changed: thread rows, their newest runs, and new or changed log entries. */
  flush(): void {
    if (this.#flushTimer) clearImmediate(this.#flushTimer);
    this.#flushTimer = null;
    if (this.#streamTimer) clearTimeout(this.#streamTimer);
    this.#streamTimer = null;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    try {
      this.#write();
    } catch (error) {
      this.#failure(error);
      return;
    }
    this.#failing = false;
  }

  /**
   * Admission is written at once, before the harness is sent anything. One that
   * fails waits, with every later one so they stay in order, for the next write.
   */
  admit(managed: ManagedThread, event: ThreadEvent): void {
    // Only messages are written at once; the rest waits for the next flush.
    if (!event.type.startsWith("message.")) return;
    if (this.#unadmitted.length === 0)
      try {
        this.#record(managed, event);
        return;
      } catch (error) {
        this.#failure(error);
      }
    this.#unadmitted.push([managed, event]);
    this.schedule();
  }

  /** Forgets a thread that left memory; the store keeps what it has of it. */
  forget(id: string): void {
    this.#dirty.delete(id);
    this.#savedTasks.delete(id);
  }

  /** Deletes a thread from the store, with what waits to be saved for it, which would bring it back. */
  delete(id: string): void {
    this.forget(id);
    this.#unadmitted = this.#unadmitted.filter(([managed]) => managed.id !== id);
    this.#store.deleteThread(id);
  }

  /** Writes nothing more by itself; `flush` still writes. */
  stop(): void {
    this.#stopped = true;
  }

  /** The threads go on, and what they did stays pending for a write that is tried again. */
  #failure(error: unknown): void {
    if (!this.#failing) this.#source.failed(error);
    this.#failing = true;
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.flush();
    }, STORE_RETRY_MS);
    // Retrying is no reason to stay up.
    this.#retryTimer.unref();
  }

  /** Writes in one transaction, and marks things written only once it commits. */
  #write(): void {
    const store = this.#store;
    const source = this.#source;
    const dirty = [...this.#dirty];
    const logs: [ThreadLog, LoggedEntry[]][] = [];
    const tasks: [string, string][] = [];
    const admitted = this.#unadmitted.length;
    store.transaction(() => {
      for (const [managed, event] of this.#unadmitted.slice(0, admitted))
        this.#record(managed, event);
      for (const id of dirty) {
        const managed = source.thread(id);
        if (!managed) continue;
        store.saveThread(source.row(managed));
        // Runs change only at the end.
        for (const run of managed.runs.slice(-2)) store.saveRun(id, run);
        for (const [harness, visit] of source.visits(id)) store.saveVisit(id, harness, visit);
        store.saveAllowances(id, managed.thread.allowances);
      }
      for (const [id, log] of source.logs()) {
        const changed = log.unwritten();
        if (changed.length === 0) continue;
        if (source.thread(id) || store.thread(id)) store.writeLog(id, changed);
        logs.push([log, changed]);
      }
      // Tasks change seldom; they are written when they do.
      for (const task of source.tasks()) {
        const key = JSON.stringify(task);
        if (this.#savedTasks.get(task.id) === key) continue;
        store.saveTask(task);
        tasks.push([task.id, key]);
      }
      store.saveSeq(source.seq());
    });
    this.#unadmitted.splice(0, admitted);
    for (const id of dirty) this.#dirty.delete(id);
    for (const [log, changed] of logs) log.written(changed);
    for (const [id, key] of tasks) this.#savedTasks.set(id, key);
  }

  #record(managed: ManagedThread, event: ThreadEvent): void {
    const store = this.#store;
    if (event.type === "message.recorded") {
      // A thread's row exists before its first message does.
      store.saveThread(this.#source.row(managed));
      store.recordMessage(managed.id, event.message, event.input);
    } else if (event.type === "message.dispatched")
      store.setMessageState(event.messageId, "dispatched");
    else if (event.type === "message.dropped") store.setMessageState(event.messageId, "dropped");
  }
}
