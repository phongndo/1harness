import { randomUUID } from "node:crypto";
import {
  SESSION_METHODS,
  type ApprovalAction,
  type Capabilities,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessSession,
  type Item,
  type NativeCommand,
  type RequestResponse,
  type SessionInfo,
  type SessionMethod,
  type TurnStatus,
  type Usage,
  type UserInput,
} from "./events.ts";

/** Where a message came from, so clients and records need not read it from its text. */
export type MessageOrigin =
  | { type: "user" }
  /** Work thread `from` delegated: the task as it was given, without the brief around it. */
  | { type: "task"; from: string; task: string }
  /** How a task this thread delegated to thread `from` ended, and what it found. */
  | { type: "report"; from: string; status: TurnStatus | "cancelled"; result: string }
  /** A message thread `from` sent with `thread_send`. */
  | { type: "message"; from: string };

/** A message for the harness, with where it came from. */
export interface Message {
  /** Sent to the harness as `UserInput.id`, so the `user_message` it echoes can be matched. */
  readonly id: string;
  /** The message as it was sent, before input handlers. */
  readonly input: UserInput;
  readonly origin: MessageOrigin;
  /** A harness command, sent as `/name args`, which must reach the harness as written. */
  readonly command?: boolean;
}

/**
 * One way to start the session that takes a thread over. `replaceSession` tries
 * them in order until one takes over.
 */
export interface SessionAttempt {
  /** Makes the session; throwing counts as this attempt failing. */
  create(): HarnessSession;
  /** Checks the started session before it takes over, such as its modes; throws to refuse it. */
  prepare?(session: HarnessSession): Promise<void>;
  /** Goes in front of the next message the session is sent. */
  handoff?: string | null;
  /** Whether the next attempt may run after this one fails with `error`. */
  fallThrough?(error: unknown): boolean;
}

/** A switch that cannot go ahead with any session, such as one the old session started work during. */
class SwitchAborted extends Error {}

const FROM_USER: MessageOrigin = { type: "user" };

/** What a message says, as its sender wrote it: the user's text, the task, or the result. */
export function messageText(message: Message): string {
  switch (message.origin.type) {
    case "task":
      return message.origin.task;
    case "report":
      return message.origin.result;
    default:
      return message.input.text;
  }
}

export type ThreadEvent =
  | HarnessEvent
  | { type: "queue.changed"; queue: readonly Message[] }
  /**
   * Another session took the thread over, such as another harness's; `previous`
   * is the one it replaced, as it last stood. The new session's own
   * `session.updated` follows.
   */
  | { type: "session.replaced"; previous: SessionInfo }
  /** `unsent` is set when the error is that a message could not start its turn. */
  | { type: "error"; message: string; unsent?: Message };

export type ThreadListener = (event: ThreadEvent) => void;

/** Sees a message before it is sent: returns a replacement, null to drop it, or undefined to keep it. */
export type InputHandler = (
  input: UserInput,
) => UserInput | null | undefined | Promise<UserInput | null | undefined>;

/** Sees a request before any client: returns a response to answer it, or undefined to pass. */
export type RequestHandler = (
  request: HarnessRequest,
) => RequestResponse | undefined | Promise<RequestResponse | undefined>;

// A request handler that has not answered by then is passed over, so the user is asked.
const REQUEST_HANDLER_TIMEOUT_MS = 10_000;

/**
 * Client-independent conversation state over one harness session: busy state,
 * follow-up queue, open requests, usage, and items with deltas applied. Every
 * client (terminal, SDK, remote) should go through this so queue and steering
 * behave the same everywhere.
 */
export class Thread {
  /** The session the thread runs on, or null while it is parked. */
  #session: HarnessSession | null;
  /** The last session's info, capabilities, and methods, for while none runs. */
  #info: SessionInfo;
  #capabilities: Capabilities;
  #methods: SessionMethod[];
  /** Starts a session for a parked thread, such as by resuming its native thread. */
  #waker: (() => Promise<void>) | null = null;
  #waking: Promise<void> | null = null;
  /**
   * A session starting to take the thread over and the events it sent so far;
   * `closing` once `close` has closed it.
   */
  #incoming: { session: HarnessSession; events: HarnessEvent[]; closing: boolean } | null = null;
  /**
   * How many sessions have taken the thread over. Each new one's item IDs get a
   * prefix, since drivers number items per session and would repeat the old ones.
   */
  #generation = 0;
  /** What the harness is told before the next message, after a new session took over. */
  #handoff: string | null = null;
  #listeners = new Set<ThreadListener>();
  /** Messages waiting for the next turn, with what the input handlers made of them. */
  #queue: Prepared[] = [];
  /** Every message the thread was sent, by ID. */
  #messages = new Map<string, Message>();
  #items = new Map<string, Item>();
  #requests = new Map<string, HarnessRequest>();
  #busy = false;
  #turnId: string | null = null;
  #usage: Usage | null = null;
  #closed = false;
  /** `close` was called, whether or not the session has said it closed. */
  #ending = false;
  #pumping: Promise<void> | null = null;
  #inputHandlers: InputHandler[] = [];
  #requestHandlers: RequestHandler[] = [];
  /** Messages waiting on input handlers, kept in order. */
  #inputChain: Promise<void> = Promise.resolve();
  /** The messages in the handlers; one `clearQueue` drops is no longer here when they finish. */
  #pending = new Set<Message>();
  #allowances = new Set<string>();

  constructor(session: HarnessSession) {
    this.#session = session;
    this.#info = { ...session.info };
    this.#capabilities = session.capabilities;
    this.#methods = methodsOf(session);
  }

  /**
   * The session the thread runs on, or null while it is parked: its session
   * ended, as an idle one is closed, and the next message wakes it.
   * `replaceSession` changes it.
   */
  get session(): HarnessSession | null {
    return this.#session;
  }

  /** The session's info, or the last session's while the thread is parked. */
  get info(): SessionInfo {
    return this.#session?.info ?? this.#info;
  }

  get capabilities(): Capabilities {
    return this.#session?.capabilities ?? this.#capabilities;
  }

  /** The optional session methods its harness has, such as `listModels`. */
  get methods(): readonly SessionMethod[] {
    return this.#session ? methodsOf(this.#session) : this.#methods;
  }

  /** No session runs the thread, though it has not ended; a message wakes it. */
  get parked(): boolean {
    return this.#session === null && !this.#closed;
  }

  /** Sets what starts a session when a parked thread gets work. */
  setWaker(waker: () => Promise<void>): void {
    this.#waker = waker;
  }

  /**
   * The running session, starting one first when the thread is parked. Throws
   * when it cannot start or the thread has ended.
   */
  async wake(): Promise<HarnessSession> {
    if (this.#session) return this.#session;
    if (this.#closed || this.#ending) throw new Error("The thread has ended");
    if (!this.#waker) throw new Error("The thread has no session and cannot start one");
    await (this.#waking ?? this.#startWaking());
    if (!this.#session) throw new Error("The thread's session did not start");
    return this.#session;
  }

  #startWaking(): Promise<void> {
    const waking = (this.#incoming ? Promise.resolve() : this.#waker!()).finally(() => {
      if (this.#waking === waking) this.#waking = null;
    });
    this.#waking = waking;
    return waking;
  }

  /**
   * Closes the session but keeps the thread: its messages, queue, handlers,
   * always-allow choices, and handoff stay for the session that wakes it.
   * Only an idle thread parks.
   */
  async park(): Promise<void> {
    const session = this.#session;
    if (!session || this.#ending) return;
    if (!this.idle) throw new Error("The thread is working");
    await session.close();
    await this.#pumping;
  }

  /** Another session is starting to take the thread over. */
  get switching(): boolean {
    return this.#incoming !== null;
  }

  /** What the next message will carry in front of it for the harness, if anything. */
  get handoff(): string | null {
    return this.#handoff;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Nothing to do: no turn, nothing queued or still passing input handlers,
   * no open request, and no session taking over.
   */
  get idle(): boolean {
    return (
      !this.#busy &&
      this.#incoming === null &&
      this.#queue.length === 0 &&
      this.#pending.size === 0 &&
      this.#requests.size === 0
    );
  }

  get queue(): readonly Message[] {
    return this.#queue.map((entry) => entry.message);
  }

  get usage(): Usage | null {
    return this.#usage;
  }

  get requests(): readonly HarnessRequest[] {
    return [...this.#requests.values()];
  }

  item(id: string): Item | undefined {
    return this.#items.get(id);
  }

  /** A message this thread was sent, by the ID its harness echoes as `inputId`. */
  message(id: string): Message | undefined {
    return this.#messages.get(id);
  }

  subscribe(listener: ThreadListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    const session = this.#session;
    if (!session) throw new Error("The thread has no session to start");
    this.#pumping = this.#pump(session);
    await session.start();
  }

  /**
   * Moves the thread onto another session, such as another harness's, keeping
   * its messages, queue, handlers, and always-allow choices. Each attempt's
   * session starts and passes its `prepare` while the current one stays live;
   * the first to do so takes over, and the old session closes. An attempt that
   * fails lets the next one run if its `fallThrough` allows. Conversation items
   * a session sends while starting, such as a resumed thread's history, are
   * dropped, since the thread has already shown them; its notices are kept.
   * Messages sent meanwhile wait for whichever session ends up running the
   * thread, through every attempt.
   *
   * The thread must not be working, and the switch gives up if the old session
   * starts work of its own meanwhile. Resolves with the attempt that took over
   * and the errors of the ones before it.
   */
  async replaceSession(
    attempts: readonly SessionAttempt[],
  ): Promise<{ attempt: number; failures: unknown[] }> {
    if (this.#closed || this.#ending) throw new Error("The thread has ended");
    if (this.#incoming) throw new Error("The thread is already moving to another session");
    if (this.#busy || this.#requests.size > 0)
      throw new Error("The thread is working; wait for the turn to end or stop it first");
    const failures: unknown[] = [];
    for (const [index, attempt] of attempts.entries()) {
      const last = index === attempts.length - 1;
      let next: HarnessSession;
      try {
        next = attempt.create();
      } catch (error) {
        failures.push(error);
        if (last || !(attempt.fallThrough?.(error) ?? false)) return this.#giveUp(error);
        continue;
      }
      const incoming = { session: next, events: [] as HarnessEvent[], closing: false };
      this.#incoming = incoming;
      this.#emitQueue();
      const pumping = this.#pump(next);
      try {
        await next.start();
        await attempt.prepare?.(next);
        // Events a session queued while starting arrive as microtasks; once they are in,
        // a resumed thread's history cannot slip through after the session takes over.
        await new Promise((resolve) => setImmediate(resolve));
        const ended = incoming.events.find((event) => event.type === "session.closed");
        if (ended)
          throw new Error(
            `The new session ended as it started${ended.error ? `: ${ended.error}` : ""}`,
          );
        // Closed meanwhile, such as by the user or because the old session died.
        if (this.#closed || this.#ending) throw new SwitchAborted("The thread has ended");
        // The old session started work of its own, such as a scheduled wakeup.
        if (this.#busy || this.#requests.size > 0)
          throw new SwitchAborted(
            "The thread started working during the switch; try again once it is done",
          );
      } catch (error) {
        if (!incoming.closing) await next.close().catch(() => {});
        await pumping;
        failures.push(error);
        const fallThrough = attempt.fallThrough?.(error) ?? false;
        if (last || error instanceof SwitchAborted || !fallThrough) return this.#giveUp(error);
        continue;
      }
      const previous = this.#session;
      const previousInfo = { ...this.info };
      const previousPump = this.#pumping;
      this.#session = next;
      this.#pumping = pumping;
      this.#incoming = null;
      this.#generation++;
      this.#usage = null;
      this.#handoff = attempt.handoff ?? null;
      this.#emit({ type: "session.replaced", previous: previousInfo });
      for (const event of incoming.events) this.#apply(this.#renumber(event));
      if (!this.#busy) this.#drain();
      this.#emitQueue();
      if (previous) {
        await previous.close().catch(() => {});
        await previousPump;
      }
      return { attempt: index, failures };
    }
    return this.#giveUp(new Error("No session to move to"));
  }

  /** Ends a switch that no session took over: what was sent meanwhile goes to the old session. */
  #giveUp(error: unknown): never {
    this.#incoming = null;
    if (!this.#busy && !this.#closed) this.#drain();
    this.#emitQueue();
    throw error;
  }

  /**
   * The ID of the tool call item behind a call to one of 1harness's MCP tools,
   * as the thread's items are numbered, or null when the harness cannot tell.
   */
  callId(meta: Record<string, unknown>, tool: string): string | null {
    const id = this.#session?.mcpCallId?.(meta, tool) ?? null;
    return id === null ? null : this.#itemId(id);
  }

  /** An item ID as the thread knows it: the session's own, with the session's prefix. */
  #itemId(id: string): string {
    return this.#generation === 0 ? id : `s${this.#generation}:${id}`;
  }

  /** The event with its item IDs numbered for the thread. */
  #renumber(event: HarnessEvent): HarnessEvent {
    if (this.#generation === 0) return event;
    switch (event.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        return { ...event, item: { ...event.item, id: this.#itemId(event.item.id) } };
      case "item.delta":
        return { ...event, itemId: this.#itemId(event.itemId) };
      default:
        return event;
    }
  }

  /** Lets code rewrite or drop each message before it is sent or queued. */
  addInputHandler(handler: InputHandler): () => void {
    this.#inputHandlers.push(handler);
    return () => {
      this.#inputHandlers = this.#inputHandlers.filter((entry) => entry !== handler);
    };
  }

  /**
   * Lets code answer approvals and questions before clients see them, such as a
   * permission policy. Handlers run in order; the first response wins.
   */
  addRequestHandler(handler: RequestHandler): () => void {
    this.#requestHandlers.push(handler);
    return () => {
      this.#requestHandlers = this.#requestHandlers.filter((entry) => entry !== handler);
    };
  }

  /**
   * Actions the user chose to always allow in this thread, by `actionKey`. The
   * same action is approved again without asking, on every harness.
   */
  get allowances(): ReadonlySet<string> {
    return this.#allowances;
  }

  /**
   * Starts a turn, or queues the input as the next turn while one is running.
   * `origin` says who sent it, when that is not the user.
   */
  send(
    input: UserInput,
    origin: MessageOrigin = FROM_USER,
    options: { command?: boolean } = {},
  ): Message {
    const message = this.#record(input, origin, options.command === true);
    if (this.#inputHandlers.length === 0 && this.#pending.size === 0) {
      this.#enqueue(prepare(message, input));
      return message;
    }
    // Handlers may be slow; a message sent after this one still goes after it.
    this.#pending.add(message);
    // Listeners learn the thread has work before the handlers finish.
    this.#emitQueue();
    this.#inputChain = this.#inputChain.then(async () => {
      let filtered: UserInput | null;
      try {
        filtered = await this.#filterInput(input);
      } catch (error) {
        this.#pending.delete(message);
        this.#emit({ type: "error", message: `An input handler failed: ${errorMessage(error)}` });
        return;
      }
      const kept = this.#pending.delete(message);
      if (filtered && kept) this.#enqueue(prepare(message, filtered));
      // A dropped message may leave the thread with nothing to do.
      else this.#emitQueue();
    });
    return message;
  }

  /** Adds input to the running turn where the harness supports it; otherwise queues it. */
  async steer(input: UserInput, origin: MessageOrigin = FROM_USER): Promise<Message> {
    const session = this.#session;
    if (!this.#busy || !session || !session.capabilities.steer) return this.send(input, origin);
    const message = this.#record(input, origin);
    const filtered = await this.#filterInput(input);
    if (!filtered) return message;
    const prepared = prepare(message, filtered);
    try {
      if (session !== this.#session) throw new Error("The session changed");
      await session.steer(prepared.input);
    } catch {
      // The turn ended between the check and the request, so it becomes a follow-up.
      this.#enqueue(prepared);
    }
    return message;
  }

  /**
   * Runs a harness command. One that starts a turn is sent as `/name args` and
   * queues like any message; the rest run at once, even mid-turn.
   */
  async command(command: NativeCommand, args: string): Promise<void> {
    if (command.startsTurn)
      this.send({ text: args ? `/${command.name} ${args}` : `/${command.name}` }, FROM_USER, {
        command: true,
      });
    else {
      const session = await this.wake();
      if (session.runCommand) await session.runCommand(command.name, args);
      else throw new Error(`${session.info.harness} cannot run /${command.name}`);
    }
  }

  /** Removes and returns the message the user queued last; others' messages stay. */
  unqueue(): Message | undefined {
    const index = this.#queue.findLastIndex((entry) => entry.message.origin.type === "user");
    const [entry] = index === -1 ? [] : this.#queue.splice(index, 1);
    if (entry) this.#emitQueue();
    return entry?.message;
  }

  /**
   * Drops queued messages, and the ones still passing input handlers: every
   * one, or only those `drop` picks.
   */
  clearQueue(drop: (message: Message) => boolean = () => true): void {
    const before = this.#queue.length + this.#pending.size;
    this.#queue = this.#queue.filter((entry) => !drop(entry.message));
    for (const message of this.#pending) if (drop(message)) this.#pending.delete(message);
    if (this.#queue.length + this.#pending.size !== before) this.#emitQueue();
  }

  async interrupt(): Promise<void> {
    if (this.#busy && this.#session) await this.#session.interrupt();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const request = this.#requests.get(requestId);
    if (request?.kind === "approval" && response.kind === "approval") {
      const option = request.options.find((candidate) => candidate.id === response.optionId);
      const key = actionKey(request.action);
      if (option?.effect === "allow-always" && key) this.#allowances.add(key);
    }
    if (!this.#session) throw new Error("The thread's session has ended");
    await this.#session.respond(requestId, response);
  }

  async close(): Promise<void> {
    this.#ending = true;
    // A session still starting to take over closes too, rather than outliving the thread.
    const incoming = this.#incoming;
    if (incoming && !incoming.closing) {
      incoming.closing = true;
      void incoming.session.close().catch(() => {});
    }
    if (this.#session) await this.#session.close();
    await this.#pumping;
    // A parked thread has no session to say it closed.
    this.#closed = true;
  }

  async #filterInput(input: UserInput): Promise<UserInput | null> {
    let current = input;
    for (const handler of this.#inputHandlers) {
      const result = await handler(current);
      if (result === null) return null;
      if (result) current = result;
    }
    return current;
  }

  #record(input: UserInput, origin: MessageOrigin, command = false): Message {
    const message: Message = { id: randomUUID(), input, origin, ...(command ? { command } : {}) };
    this.#messages.set(message.id, message);
    return message;
  }

  /** Queues a message that already passed the input handlers; a parked thread wakes for it. */
  #enqueue(entry: Prepared): void {
    if (!this.#busy && this.#incoming === null && this.#session) {
      this.#dispatch(entry);
      return;
    }
    this.#queue.push(entry);
    this.#emitQueue();
    if (this.parked && this.#waker && !this.#waking && !this.#incoming && !this.#ending)
      void this.#startWaking().catch((error: unknown) =>
        this.#emit({ type: "error", message: `Could not wake the thread: ${errorMessage(error)}` }),
      );
  }

  /** Approves a request the user already chose to always allow, if it is one. */
  #allowed(request: HarnessRequest): RequestResponse | undefined {
    if (request.kind !== "approval") return undefined;
    const key = actionKey(request.action);
    if (!key || !this.#allowances.has(key)) return undefined;
    const option =
      request.options.find((candidate) => candidate.effect === "allow-always") ??
      request.options.find((candidate) => candidate.effect === "allow");
    return option ? { kind: "approval", optionId: option.id } : undefined;
  }

  /** Offers a request to the handlers; one nobody answers goes to clients. */
  async #intercept(request: HarnessRequest): Promise<void> {
    for (const handler of this.#requestHandlers) {
      let response: RequestResponse | undefined;
      try {
        response = await withTimeout(Promise.resolve(handler(request)), REQUEST_HANDLER_TIMEOUT_MS);
      } catch (error) {
        this.#emit({ type: "error", message: `A request handler failed: ${errorMessage(error)}` });
      }
      if (response) {
        await this.#session?.respond(request.id, response).catch(() => {});
        return;
      }
    }
    if (this.#closed) return;
    this.#requests.set(request.id, request);
    this.#emit({ type: "request.opened", request });
  }

  #dispatch(entry: Prepared): void {
    const session = this.#session;
    if (!session) {
      this.#queue.unshift(entry);
      this.#emitQueue();
      return;
    }
    // Busy is set before the harness confirms so a second send queues instead of racing.
    this.#busy = true;
    // A harness command must start the text to run, so the handoff waits for the next message.
    const handoff = entry.message.command ? null : this.#handoff;
    if (handoff) this.#handoff = null;
    const input = handoff
      ? { ...entry.input, text: `${handoff}\n\n${entry.input.text}` }
      : entry.input;
    session.startTurn(input).catch((error: unknown) => {
      if (handoff) this.#handoff ??= handoff;
      this.#busy = false;
      this.#emit({ type: "error", message: errorMessage(error), unsent: entry.message });
      this.#drain();
    });
  }

  #drain(): void {
    if (!this.#session) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#emitQueue();
    this.#dispatch(next);
  }

  async #pump(session: HarnessSession): Promise<void> {
    let ended = false;
    try {
      for await (const event of session.events) {
        if (event.type === "session.closed") ended = true;
        this.#receive(session, event);
      }
    } catch (error) {
      ended = true;
      this.#receive(session, { type: "session.closed", error: errorMessage(error) });
    }
    // A harness whose events end without saying it closed.
    if (!ended) this.#receive(session, { type: "session.closed", error: null });
  }

  /** Applies the running session's events, holds a starting one's, and drops a replaced one's. */
  #receive(session: HarnessSession, event: HarnessEvent): void {
    if (session === this.#session) {
      if (event.type === "session.closed") this.#detach(session);
      this.#apply(this.#renumber(event));
    } else if (session === this.#incoming?.session && keptWhileStarting(event))
      this.#incoming.events.push(event);
  }

  /**
   * Lets go of a session that ended: the thread parks, keeping what it knew
   * of the session, or ends, when `close` asked.
   */
  #detach(session: HarnessSession): void {
    this.#info = { ...session.info };
    this.#capabilities = session.capabilities;
    this.#methods = methodsOf(session);
    this.#session = null;
    this.#busy = false;
    this.#turnId = null;
    this.#requests.clear();
    this.#items.clear();
    if (this.#ending) this.#closed = true;
  }

  #apply(event: HarnessEvent): void {
    switch (event.type) {
      case "turn.started":
        this.#busy = true;
        this.#turnId = event.turnId;
        break;
      case "turn.ended":
        if (this.#turnId !== null && event.turnId !== this.#turnId) break;
        this.#busy = false;
        this.#turnId = null;
        break;
      case "item.started":
      case "item.updated":
        this.#items.set(event.item.id, event.item);
        break;
      case "item.completed":
        this.#items.delete(event.item.id);
        break;
      case "item.delta": {
        const item = this.#items.get(event.itemId);
        if (item) this.#items.set(item.id, appendDelta(item, event.chunk));
        break;
      }
      case "request.opened": {
        const allowed = this.#allowed(event.request);
        if (allowed) {
          void this.#session?.respond(event.request.id, allowed).catch(() => {});
          return;
        }
        if (this.#requestHandlers.length > 0) {
          void this.#intercept(event.request);
          return;
        }
        this.#requests.set(event.request.id, event.request);
        break;
      }
      case "request.resolved":
        this.#requests.delete(event.requestId);
        break;
      case "usage.updated":
        this.#usage = event.usage;
        break;
      case "session.closed":
        // `#detach` already let the session go.
        break;
      case "session.updated":
        this.#info = { ...event.info };
        break;
    }
    this.#emit(event);
    if (event.type === "turn.ended" && !this.#busy) this.#drain();
  }

  #emitQueue(): void {
    this.#emit({ type: "queue.changed", queue: this.queue });
  }

  #emit(event: ThreadEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

/**
 * Whether an event a session sends before it takes a thread over is kept for
 * then: notices and state, but not conversation, which is a resumed thread's
 * history that the thread already shows.
 */
function keptWhileStarting(event: HarnessEvent): boolean {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      return event.item.kind === "notice";
    case "item.delta":
    case "turn.started":
    case "turn.ended":
      return false;
    default:
      return true;
  }
}

/** The optional methods a session has. */
function methodsOf(session: HarnessSession): SessionMethod[] {
  return SESSION_METHODS.filter((method) => typeof session[method] === "function");
}

/** A message, and the input the harness is sent for it: after the handlers, with its ID. */
interface Prepared {
  message: Message;
  input: UserInput;
}

function prepare(message: Message, filtered: UserInput): Prepared {
  return {
    message,
    input: { ...filtered, id: message.id, fromUser: message.origin.type === "user" },
  };
}

export function appendDelta(item: Item, chunk: string): Item {
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
    case "plan":
    case "user_message":
      return { ...item, text: item.text + chunk };
    case "command":
    case "tool_call":
      return { ...item, output: item.output + chunk };
    default:
      return item;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves with undefined if `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * What makes two approvals the same action: the exact command, the same files,
 * or the same tool. Null for actions that cannot be compared.
 */
export function actionKey(action: ApprovalAction): string | null {
  switch (action.type) {
    case "command":
      return `command\0${action.command}`;
    case "file_change":
      return `files\0${action.paths.toSorted().join("\0")}`;
    case "tool":
      return `tool\0${action.server ?? ""}\0${action.tool}`;
    case "other":
      return null;
  }
}
