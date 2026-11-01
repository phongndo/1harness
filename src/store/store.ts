import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  Capabilities,
  HarnessId,
  SessionInfo,
  SessionMethod,
  UserInput,
} from "../core/events.ts";
import type { Message, MessageOrigin } from "../core/thread.ts";
import type { RunRecord, Visit } from "../host/manager.ts";
import type { LogEntry, LoggedEntry } from "../protocol.ts";

/** A thread as the store keeps it. */
export interface ThreadRow {
  id: string;
  title: string;
  cwd: string;
  harness: HarnessId;
  parentId: string | null;
  parentCallId: string | null;
  origin: "user" | "delegated";
  /** The thread it was forked from. */
  forkedFrom: string | null;
  /** `open` has a session, `parked` had one and will again, `closed` was ended. */
  state: "open" | "parked" | "closed";
  info: SessionInfo;
  capabilities: Capabilities;
  methods: SessionMethod[];
  /** What the next message carries in front of it for the harness. */
  handoff: string | null;
  /** How many runs the harness's own thread saw without that handoff. */
  seenWithoutHandoff: number | null;
  /** How many sessions have taken the thread over, for numbering their items. */
  generation: number;
  error: string | null;
  pinned: boolean;
  archived: boolean;
  /** How many runs a client has shown. */
  seenRuns: number;
  createdAt: number;
  updatedAt: number;
}

/** A thread row with what listings show of its runs. */
export interface ThreadSummaryRow extends ThreadRow {
  runCount: number;
  lastRunStatus: RunRecord["status"] | null;
}

export type MessageState = "queued" | "dispatched" | "dropped";

/** A task one thread gave another, as the orchestrator keeps it. */
export interface TaskRow {
  id: string;
  parentId: string;
  requestId: string | null;
  seen: boolean;
  delivered: boolean;
}

/** The store is another process's, such as a running server's. */
export class StoreLocked extends Error {}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  harness TEXT NOT NULL,
  parent_id TEXT,
  parent_call_id TEXT,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  info TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  methods TEXT NOT NULL,
  handoff TEXT,
  seen_without_handoff INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  seen_runs INTEGER NOT NULL DEFAULT 0,
  native TEXT,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_state ON threads(state, updated_at);
CREATE INDEX IF NOT EXISTS threads_native ON threads(native);
CREATE TABLE IF NOT EXISTS visits (
  thread_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  native TEXT,
  runs INTEGER NOT NULL,
  model TEXT,
  effort TEXT,
  context_tokens INTEGER,
  left_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, harness)
);
CREATE INDEX IF NOT EXISTS visits_native ON visits(native);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  origin TEXT NOT NULL,
  input TEXT NOT NULL,
  sent TEXT NOT NULL,
  command INTEGER NOT NULL,
  state TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, state, position);
CREATE INDEX IF NOT EXISTS messages_request ON messages(thread_id, request_id);
CREATE TABLE IF NOT EXISTS runs (
  thread_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (thread_id, idx)
);
CREATE TABLE IF NOT EXISTS allowances (
  thread_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (thread_id, key)
);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  entry TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_thread ON log(thread_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(text, thread_id UNINDEXED);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  request_id TEXT,
  seen INTEGER NOT NULL,
  delivered INTEGER NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

function json<T>(value: SQLInputValue | undefined): T {
  return JSON.parse(String(value)) as T;
}

/** The text a log entry adds to search: messages and replies, once they are done. */
function searchText(entry: LogEntry): string | null {
  if (entry.type !== "item" || !entry.done) return null;
  const item = entry.item;
  if (item.kind === "assistant_message") return item.text;
  if (item.kind === "user_message") {
    const origin = entry.message?.origin;
    if (origin?.type === "task") return origin.task;
    if (origin?.type === "report") return null;
    return entry.message?.input.text ?? item.text;
  }
  return null;
}

/** A search a person typed, as FTS5 reads it: every word, each as a prefix. */
function matchQuery(query: string): string | null {
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.map((word) => `"${word}"*`).join(" ");
}

/**
 * What 1harness keeps across restarts, in SQLite: threads, the harnesses
 * each ran on, admitted messages, runs, always-allow choices, transcripts as
 * logs, and delegated tasks. One process writes it at a time, holding its
 * lock until it closes; another that tries gets `StoreLocked`.
 */
export class Store {
  /** The database file, or null for a store kept in memory. */
  readonly path: string | null;
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  private constructor(db: DatabaseSync, path: string | null) {
    this.#db = db;
    this.path = path;
  }

  /** Opens the database at `path`, creating it, and takes its lock. */
  static open(path: string): Store {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=NORMAL;");
      // The lock is taken on first use; this takes it now and keeps it.
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
    } catch (error) {
      db.close();
      if (/locked|busy/i.test(error instanceof Error ? error.message : ""))
        throw new StoreLocked(`${path} is in use by another 1harness`, { cause: error });
      throw error;
    }
    const store = new Store(db, path);
    store.#migrate();
    return store;
  }

  /** A store that lasts as long as the process, for tests and runs that keep nothing. */
  static memory(): Store {
    const store = new Store(new DatabaseSync(":memory:"), null);
    store.#migrate();
    return store;
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(SCHEMA);
    // Columns added since a store was first made.
    const columns = new Set(
      this.#all("PRAGMA table_info(threads)").map((row) => String(row["name"])),
    );
    if (!columns.has("forked_from"))
      this.#db.exec("ALTER TABLE threads ADD COLUMN forked_from TEXT");
    const version = this.#meta("schema");
    if (version === null) this.#setMeta("schema", String(SCHEMA_VERSION));
    else if (Number(version) > SCHEMA_VERSION)
      throw new Error(`The store was written by a newer 1harness (schema ${version})`);
  }

  #run(sql: string, ...params: SQLInputValue[]): void {
    this.#statement(sql).run(...params);
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#statement(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#statement(sql).all(...params) as Row[];
  }

  #statement(sql: string) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #meta(key: string): string | null {
    const row = this.#get("SELECT value FROM meta WHERE key = ?", key);
    return row ? String(row["value"]) : null;
  }

  #setMeta(key: string, value: string): void {
    this.#run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** Runs `work` as one transaction. */
  transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A new thread ID, such as `t42`, never given out before. */
  nextThreadId(): string {
    const next = Number(this.#meta("next_thread") ?? "1");
    this.#setMeta("next_thread", String(next + 1));
    return `t${next}`;
  }

  /** The newest log entry's number, which the host's feed continues from. */
  maxSeq(): number {
    const row = this.#get("SELECT MAX(seq) AS seq FROM log");
    const logged = Number(row?.["seq"] ?? 0);
    return Math.max(logged, Number(this.#meta("seq") ?? "0"));
  }

  /** Remembers how far the feed got, for numbers no log entry took. */
  saveSeq(seq: number): void {
    this.#setMeta("seq", String(seq));
  }

  saveThread(row: ThreadRow): void {
    this.#run(
      `INSERT INTO threads (id, title, cwd, harness, parent_id, parent_call_id, origin, state, info,
         capabilities, methods, handoff, seen_without_handoff, generation, error, pinned, archived,
         seen_runs, native, forked_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, cwd = excluded.cwd,
         harness = excluded.harness, state = excluded.state, info = excluded.info,
         capabilities = excluded.capabilities, methods = excluded.methods,
         handoff = excluded.handoff, seen_without_handoff = excluded.seen_without_handoff,
         generation = excluded.generation, error = excluded.error, pinned = excluded.pinned,
         archived = excluded.archived, seen_runs = excluded.seen_runs, native = excluded.native,
         updated_at = excluded.updated_at`,
      row.id,
      row.title,
      row.cwd,
      row.harness,
      row.parentId,
      row.parentCallId,
      row.origin,
      row.state,
      JSON.stringify(row.info),
      JSON.stringify(row.capabilities),
      JSON.stringify(row.methods),
      row.handoff,
      row.seenWithoutHandoff,
      row.generation,
      row.error,
      row.pinned ? 1 : 0,
      row.archived ? 1 : 0,
      row.seenRuns,
      row.info.threadId,
      row.forkedFrom,
      row.createdAt,
      row.updatedAt,
    );
  }

  #thread(row: Row): ThreadRow {
    return {
      id: String(row["id"]),
      title: String(row["title"]),
      cwd: String(row["cwd"]),
      harness: String(row["harness"]),
      parentId: row["parent_id"] === null ? null : String(row["parent_id"]),
      parentCallId: row["parent_call_id"] === null ? null : String(row["parent_call_id"]),
      origin: row["origin"] === "delegated" ? "delegated" : "user",
      forkedFrom:
        row["forked_from"] === null || row["forked_from"] === undefined
          ? null
          : String(row["forked_from"]),
      state: String(row["state"]) as ThreadRow["state"],
      info: json(row["info"]),
      capabilities: json(row["capabilities"]),
      methods: json(row["methods"]),
      handoff: row["handoff"] === null ? null : String(row["handoff"]),
      seenWithoutHandoff:
        row["seen_without_handoff"] === null ? null : Number(row["seen_without_handoff"]),
      generation: Number(row["generation"]),
      error: row["error"] === null ? null : String(row["error"]),
      pinned: Number(row["pinned"]) === 1,
      archived: Number(row["archived"]) === 1,
      seenRuns: Number(row["seen_runs"]),
      createdAt: Number(row["created_at"]),
      updatedAt: Number(row["updated_at"]),
    };
  }

  #summary(row: Row): ThreadSummaryRow {
    return {
      ...this.#thread(row),
      runCount: Number(row["run_count"] ?? 0),
      lastRunStatus:
        row["last_run"] === null || row["last_run"] === undefined
          ? null
          : (json<RunRecord>(row["last_run"]).status ?? null),
    };
  }

  thread(id: string): ThreadRow | null {
    const row = this.#get("SELECT * FROM threads WHERE id = ?", id);
    return row ? this.#thread(row) : null;
  }

  /** The thread that runs, or ran, a harness's own thread. */
  threadByNative(native: string): ThreadRow | null {
    const row =
      this.#get(
        "SELECT * FROM threads WHERE native = ? ORDER BY updated_at DESC LIMIT 1",
        native,
      ) ??
      this.#get(
        `SELECT threads.* FROM visits JOIN threads ON threads.id = visits.thread_id
         WHERE visits.native = ? ORDER BY threads.updated_at DESC LIMIT 1`,
        native,
      );
    return row ? this.#thread(row) : null;
  }

  /** Threads that were not closed, oldest first, parents before the threads they started. */
  liveThreads(): ThreadRow[] {
    return this.#all(
      "SELECT * FROM threads WHERE state != 'closed' ORDER BY created_at, rowid",
    ).map((row) => this.#thread(row));
  }

  /**
   * Threads for a listing, newest first: `recent` is every thread not
   * archived, `archived` the archived ones, and `open` those not closed.
   * `query` matches titles and transcripts.
   */
  listThreads(options: {
    scope: "open" | "recent" | "archived";
    query?: string;
    limit?: number;
  }): ThreadSummaryRow[] {
    const where =
      options.scope === "archived"
        ? "archived = 1"
        : options.scope === "open"
          ? "archived = 0 AND state != 'closed'"
          : "archived = 0";
    const match = options.query ? matchQuery(options.query) : null;
    const params: SQLInputValue[] = [];
    let filter = "";
    if (options.query) {
      filter = ` AND (title LIKE ? ESCAPE '\\'${match ? " OR id IN (SELECT thread_id FROM log_fts WHERE log_fts MATCH ?)" : ""})`;
      params.push(`%${options.query.replace(/[\\%_]/g, "\\$&")}%`);
      if (match) params.push(match);
    }
    params.push(options.limit ?? 200);
    return this.#all(
      `SELECT threads.*,
         (SELECT COUNT(*) FROM runs WHERE runs.thread_id = threads.id) AS run_count,
         (SELECT record FROM runs WHERE runs.thread_id = threads.id ORDER BY idx DESC LIMIT 1) AS last_run
       FROM threads WHERE ${where}${filter}
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      ...params,
    ).map((row) => this.#summary(row));
  }

  /** One thread with what listings show of its runs. */
  summary(id: string): ThreadSummaryRow | null {
    const row = this.#get(
      `SELECT threads.*,
         (SELECT COUNT(*) FROM runs WHERE runs.thread_id = threads.id) AS run_count,
         (SELECT record FROM runs WHERE runs.thread_id = threads.id ORDER BY idx DESC LIMIT 1) AS last_run
       FROM threads WHERE id = ?`,
      id,
    );
    return row ? this.#summary(row) : null;
  }

  /** The threads a thread started, and the ones they started. */
  descendants(id: string): string[] {
    const children = this.#all("SELECT id FROM threads WHERE parent_id = ?", id).map((row) =>
      String(row["id"]),
    );
    return children.flatMap((child) => [child, ...this.descendants(child)]);
  }

  /** Where a search matched in each thread's transcript, best first. */
  search(query: string, limit = 50): { threadId: string; snippet: string }[] {
    const match = matchQuery(query);
    if (!match) return [];
    return this.#all(
      `SELECT thread_id, snippet(log_fts, 0, '', '', '…', 12) AS snippet FROM log_fts
       WHERE log_fts MATCH ? ORDER BY rank LIMIT ?`,
      match,
      limit,
    ).map((row) => ({ threadId: String(row["thread_id"]), snippet: String(row["snippet"]) }));
  }

  /** Deletes a thread and everything kept for it. */
  deleteThread(id: string): void {
    this.transaction(() => {
      for (const table of ["visits", "messages", "runs", "allowances", "log", "log_fts"])
        this.#run(`DELETE FROM ${table} WHERE thread_id = ?`, id);
      this.#run("DELETE FROM tasks WHERE id = ? OR parent_id = ?", id, id);
      this.#run("DELETE FROM threads WHERE id = ?", id);
    });
  }

  /** Closed threads last used before `before`, for retention. */
  closedBefore(before: number): string[] {
    return this.#all(
      "SELECT id FROM threads WHERE state = 'closed' AND pinned = 0 AND updated_at < ?",
      before,
    ).map((row) => String(row["id"]));
  }

  saveVisit(threadId: string, harness: HarnessId, visit: Visit): void {
    this.#run(
      `INSERT INTO visits (thread_id, harness, native, runs, model, effort, context_tokens, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, harness) DO UPDATE SET native = excluded.native,
         runs = excluded.runs, model = excluded.model, effort = excluded.effort,
         context_tokens = excluded.context_tokens, left_at = excluded.left_at`,
      threadId,
      harness,
      visit.native,
      visit.runs,
      visit.model,
      visit.effort,
      visit.contextTokens,
      visit.leftAt,
    );
  }

  visits(threadId: string): Map<HarnessId, Visit> {
    return new Map(
      this.#all("SELECT * FROM visits WHERE thread_id = ?", threadId).map((row) => [
        String(row["harness"]),
        {
          native: row["native"] === null ? null : String(row["native"]),
          runs: Number(row["runs"]),
          model: row["model"] === null ? null : String(row["model"]),
          effort: row["effort"] === null ? null : String(row["effort"]),
          contextTokens: row["context_tokens"] === null ? null : Number(row["context_tokens"]),
          leftAt: Number(row["left_at"]),
        },
      ]),
    );
  }

  /**
   * Records a message the thread took, with the input its harness gets, before
   * it is sent; it stays queued until dispatched or dropped.
   */
  recordMessage(threadId: string, message: Message, sent: UserInput, state: MessageState): void {
    const position = Number(
      this.#get("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?", threadId)?.[
        "count"
      ] ?? 0,
    );
    this.#run(
      `INSERT INTO messages (id, thread_id, position, origin, input, sent, command, state, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
      message.id,
      threadId,
      position,
      JSON.stringify(message.origin),
      JSON.stringify(message.input),
      JSON.stringify(sent),
      message.command ? 1 : 0,
      state,
      message.requestId ?? null,
      Date.now(),
    );
  }

  setMessageState(id: string, state: MessageState): void {
    this.#run("UPDATE messages SET state = ? WHERE id = ?", state, id);
  }

  /** Messages that were queued and never sent, in order. */
  queuedMessages(threadId: string): { message: Message; sent: UserInput }[] {
    return this.#all(
      "SELECT * FROM messages WHERE thread_id = ? AND state = 'queued' ORDER BY position",
      threadId,
    ).map((row) => ({
      message: {
        id: String(row["id"]),
        input: json<UserInput>(row["input"]),
        origin: json<MessageOrigin>(row["origin"]),
        ...(Number(row["command"]) === 1 ? { command: true } : {}),
        ...(row["request_id"] === null ? {} : { requestId: String(row["request_id"]) }),
      },
      sent: json<UserInput>(row["sent"]),
    }));
  }

  /** Every message a thread was sent, for matching the harness's echoes. */
  messages(threadId: string): Message[] {
    return this.#all("SELECT * FROM messages WHERE thread_id = ? ORDER BY position", threadId).map(
      (row) => ({
        id: String(row["id"]),
        input: json<UserInput>(row["input"]),
        origin: json<MessageOrigin>(row["origin"]),
        ...(Number(row["command"]) === 1 ? { command: true } : {}),
      }),
    );
  }

  /** The message a client's request ID already sent to a thread. */
  messageByRequest(threadId: string, requestId: string): string | null {
    const row = this.#get(
      "SELECT id FROM messages WHERE thread_id = ? AND request_id = ? LIMIT 1",
      threadId,
      requestId,
    );
    return row ? String(row["id"]) : null;
  }

  saveRun(threadId: string, run: RunRecord): void {
    this.#run(
      "INSERT INTO runs (thread_id, idx, record) VALUES (?, ?, ?) ON CONFLICT (thread_id, idx) DO UPDATE SET record = excluded.record",
      threadId,
      run.index,
      JSON.stringify(run),
    );
  }

  runs(threadId: string): RunRecord[] {
    return this.#all("SELECT record FROM runs WHERE thread_id = ? ORDER BY idx", threadId).map(
      (row) => json<RunRecord>(row["record"]),
    );
  }

  saveAllowances(threadId: string, keys: Iterable<string>): void {
    for (const key of keys)
      this.#run("INSERT OR IGNORE INTO allowances (thread_id, key) VALUES (?, ?)", threadId, key);
  }

  allowances(threadId: string): string[] {
    return this.#all("SELECT key FROM allowances WHERE thread_id = ?", threadId).map((row) =>
      String(row["key"]),
    );
  }

  /** Writes log entries, new or changed in place, and what they add to search. */
  writeLog(threadId: string, entries: readonly LoggedEntry[]): void {
    for (const { seq, entry } of entries) {
      this.#run(
        "INSERT INTO log (seq, thread_id, entry) VALUES (?, ?, ?) ON CONFLICT (seq) DO UPDATE SET entry = excluded.entry",
        seq,
        threadId,
        JSON.stringify(entry),
      );
      const text = searchText(entry);
      if (text === null) continue;
      this.#run("DELETE FROM log_fts WHERE rowid = ?", seq);
      this.#run(
        "INSERT INTO log_fts (rowid, text, thread_id) VALUES (?, ?, ?)",
        seq,
        text,
        threadId,
      );
    }
  }

  log(threadId: string): LoggedEntry[] {
    return this.#all("SELECT seq, entry FROM log WHERE thread_id = ? ORDER BY seq", threadId).map(
      (row) => ({ seq: Number(row["seq"]), entry: json<LogEntry>(row["entry"]) }),
    );
  }

  saveTask(task: TaskRow): void {
    this.#run(
      `INSERT INTO tasks (id, parent_id, request_id, seen, delivered) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET seen = excluded.seen, delivered = excluded.delivered`,
      task.id,
      task.parentId,
      task.requestId,
      task.seen ? 1 : 0,
      task.delivered ? 1 : 0,
    );
  }

  tasks(): TaskRow[] {
    return this.#all("SELECT * FROM tasks").map((row) => ({
      id: String(row["id"]),
      parentId: String(row["parent_id"]),
      requestId: row["request_id"] === null ? null : String(row["request_id"]),
      seen: Number(row["seen"]) === 1,
      delivered: Number(row["delivered"]) === 1,
    }));
  }
}
