import type {
  ApprovalAction,
  HarnessEvent,
  HarnessRequest,
  HarnessSession,
  Item,
  NativeCommand,
  RequestResponse,
  Usage,
  UserInput,
} from "./events.ts";

export type ThreadEvent =
  | HarnessEvent
  | { type: "queue.changed"; queue: readonly UserInput[] }
  /** `input` is set when the error is that a message could not start its turn. */
  | { type: "error"; message: string; input?: UserInput };

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
  readonly session: HarnessSession;
  #listeners = new Set<ThreadListener>();
  #queue: UserInput[] = [];
  #items = new Map<string, Item>();
  #requests = new Map<string, HarnessRequest>();
  #busy = false;
  #turnId: string | null = null;
  #usage: Usage | null = null;
  #closed = false;
  #pumping: Promise<void> | null = null;
  #inputHandlers: InputHandler[] = [];
  #requestHandlers: RequestHandler[] = [];
  /** Messages waiting on input handlers, kept in order. */
  #inputChain: Promise<void> = Promise.resolve();
  #pendingInputs = 0;
  /** Counts `clearQueue` calls, so messages it caught in the handlers are dropped. */
  #cleared = 0;
  #allowances = new Set<string>();

  constructor(session: HarnessSession) {
    this.session = session;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Nothing to do: no turn, nothing queued or still passing input handlers,
   * and no open request.
   */
  get idle(): boolean {
    return (
      !this.#busy &&
      this.#queue.length === 0 &&
      this.#pendingInputs === 0 &&
      this.#requests.size === 0
    );
  }

  get queue(): readonly UserInput[] {
    return this.#queue;
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

  subscribe(listener: ThreadListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.#pumping = this.#pump();
    await this.session.start();
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

  /** Starts a turn, or queues the input as the next turn while one is running. */
  send(original: UserInput): void {
    if (this.#inputHandlers.length === 0 && this.#pendingInputs === 0) {
      this.#enqueue(original);
      return;
    }
    // Handlers may be slow; a message sent after this one still goes after it.
    this.#pendingInputs++;
    const cleared = this.#cleared;
    // Listeners learn the thread has work before the handlers finish.
    this.#emit({ type: "queue.changed", queue: this.#queue });
    this.#inputChain = this.#inputChain.then(async () => {
      let input: UserInput | null;
      try {
        input = await this.#filterInput(original);
      } catch (error) {
        this.#pendingInputs--;
        this.#emit({ type: "error", message: `An input handler failed: ${errorMessage(error)}` });
        return;
      }
      this.#pendingInputs--;
      if (input && cleared === this.#cleared) this.#enqueue(input);
      // A dropped message may leave the thread with nothing to do.
      else this.#emit({ type: "queue.changed", queue: this.#queue });
    });
  }

  /** Adds input to the running turn where the harness supports it; otherwise queues it. */
  async steer(original: UserInput): Promise<void> {
    if (!this.#busy || !this.session.capabilities.steer) {
      this.send(original);
      return;
    }
    const input = await this.#filterInput(original);
    if (!input) return;
    try {
      await this.session.steer(input);
    } catch {
      // The turn ended between the check and the request, so it becomes a follow-up.
      this.#enqueue(input);
    }
  }

  /**
   * Runs a harness command. One that starts a turn is sent as `/name args` and
   * queues like any message; the rest run at once, even mid-turn.
   */
  async command(command: NativeCommand, args: string): Promise<void> {
    if (command.startsTurn)
      this.send({ text: args ? `/${command.name} ${args}` : `/${command.name}` });
    else if (this.session.runCommand) await this.session.runCommand(command.name, args);
    else throw new Error(`${this.session.info.harness} cannot run /${command.name}`);
  }

  /** Removes and returns the most recently queued input. */
  unqueue(): UserInput | undefined {
    const input = this.#queue.pop();
    if (input) this.#emit({ type: "queue.changed", queue: this.#queue });
    return input;
  }

  /** Drops every queued message, and the ones still passing input handlers. */
  clearQueue(): void {
    this.#cleared++;
    if (this.#queue.length === 0 && this.#pendingInputs === 0) return;
    this.#queue = [];
    this.#emit({ type: "queue.changed", queue: this.#queue });
  }

  async interrupt(): Promise<void> {
    if (this.#busy) await this.session.interrupt();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const request = this.#requests.get(requestId);
    if (request?.kind === "approval" && response.kind === "approval") {
      const option = request.options.find((candidate) => candidate.id === response.optionId);
      const key = actionKey(request.action);
      if (option?.effect === "allow-always" && key) this.#allowances.add(key);
    }
    await this.session.respond(requestId, response);
  }

  async close(): Promise<void> {
    await this.session.close();
    await this.#pumping;
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

  /** Queues input that already passed the input handlers. */
  #enqueue(input: UserInput): void {
    if (!this.#busy) {
      this.#dispatch(input);
      return;
    }
    this.#queue.push(input);
    this.#emit({ type: "queue.changed", queue: this.#queue });
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
        await this.session.respond(request.id, response).catch(() => {});
        return;
      }
    }
    if (this.#closed) return;
    this.#requests.set(request.id, request);
    this.#emit({ type: "request.opened", request });
  }

  #dispatch(input: UserInput): void {
    // Busy is set before the harness confirms so a second send queues instead of racing.
    this.#busy = true;
    this.session.startTurn(input).catch((error: unknown) => {
      this.#busy = false;
      this.#emit({ type: "error", message: errorMessage(error), input });
      this.#drain();
    });
  }

  #drain(): void {
    const next = this.#queue.shift();
    if (!next) return;
    this.#emit({ type: "queue.changed", queue: this.#queue });
    this.#dispatch(next);
  }

  async #pump(): Promise<void> {
    try {
      for await (const event of this.session.events) this.#apply(event);
    } catch (error) {
      this.#apply({ type: "session.closed", error: errorMessage(error) });
    }
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
          void this.session.respond(event.request.id, allowed).catch(() => {});
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
        this.#closed = true;
        this.#busy = false;
        this.#requests.clear();
        break;
      case "session.updated":
        break;
    }
    this.#emit(event);
    if (event.type === "turn.ended" && !this.#busy) this.#drain();
  }

  #emit(event: ThreadEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
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
