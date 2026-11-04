import { AsyncQueue } from "../core/async-queue.ts";
import type {
  Capabilities,
  HarnessEvent,
  RequestResponse,
  RuntimeMode,
  SessionInfo,
  SessionOptions,
  UserInput,
} from "../core/events.ts";
import { registerDriver } from "../drivers/index.ts";

let natives = 0;

/**
 * A harness for tests that plays a scripted turn for each message: reasoning
 * and a reply streamed in deltas, a command, and a todo list that keeps its ID
 * across turns, as Codex's does. A message ending in ASK waits for an approval;
 * one ending in EDIT changes a file; one ending in TOOL calls an MCP tool.
 */
export class ScriptedSession {
  readonly capabilities: Capabilities = {
    steer: false,
    planMode: false,
    runtimeModes: ["supervised", "full-access"] as RuntimeMode[],
    images: false,
    toolChecks: false,
    nativeSlashCommands: false,
    mcpActions: [],
  };
  readonly info: SessionInfo;
  readonly options: SessionOptions;
  readonly events = new AsyncQueue<HarnessEvent>();
  readonly prompts: string[] = [];
  #turns = 0;
  #pending: (() => void) | null = null;

  constructor(options: SessionOptions) {
    this.options = options;
    this.info = {
      harness: "scripted",
      threadId: options.resume ?? `native-${++natives}`,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      runtimeMode: options.runtimeMode,
      interactionMode: "default",
      version: null,
    };
  }

  async start(): Promise<void> {}

  async startTurn(input: UserInput): Promise<void> {
    this.prompts.push(input.text);
    const turn = ++this.#turns;
    const id = (name: string) => `${turn}-${name}`;
    const push = (event: HarnessEvent) => this.events.push(event);
    push({ type: "turn.started", turnId: `turn-${turn}` });
    push({
      type: "item.completed",
      item: { kind: "user_message", id: id("user"), text: input.text, inputId: input.id! },
    });
    push({ type: "item.started", item: { kind: "reasoning", id: id("think"), text: "" } });
    push({ type: "item.delta", itemId: id("think"), chunk: "**Reading the parser**" });
    push({
      type: "item.updated",
      item: {
        kind: "todo_list",
        id: "todos",
        steps: [{ text: `step ${turn}`, status: "in_progress" }],
      },
    });
    push({
      type: "item.started",
      item: {
        kind: "command",
        id: id("cmd"),
        command: "pnpm test",
        output: "",
        exitCode: null,
        status: "running",
      },
    });
    push({ type: "item.delta", itemId: id("cmd"), chunk: "ok 1\n" });
    push({
      type: "item.completed",
      item: {
        kind: "command",
        id: id("cmd"),
        command: "pnpm test",
        output: "ok 1\n",
        exitCode: 0,
        status: "completed",
      },
    });
    if (input.text.endsWith("EDIT"))
      push({
        type: "item.completed",
        item: {
          kind: "file_change",
          id: id("edit"),
          changes: [{ path: "parser.ts", kind: "update", diff: "" }],
          status: "completed",
        },
      });
    if (input.text.endsWith("TOOL"))
      push({
        type: "item.completed",
        item: {
          kind: "tool_call",
          id: id("tool"),
          tool: "search",
          server: "docs",
          category: "other",
          summary: "",
          output: "",
          status: "completed",
        },
      });
    push({ type: "item.started", item: { kind: "assistant_message", id: id("reply"), text: "" } });
    for (const chunk of ["Done ", "with ", input.text]) {
      push({ type: "item.delta", itemId: id("reply"), chunk });
    }
    const finish = () => {
      push({
        type: "item.completed",
        item: { kind: "assistant_message", id: id("reply"), text: `Done with ${input.text}` },
      });
      push({
        type: "item.updated",
        item: {
          kind: "todo_list",
          id: "todos",
          steps: [{ text: `step ${turn}`, status: "completed" }],
        },
      });
      push({ type: "turn.ended", turnId: `turn-${turn}`, status: "completed", error: null });
    };
    if (input.text.endsWith("ASK")) {
      this.#pending = finish;
      push({
        type: "request.opened",
        request: {
          kind: "approval",
          id: id("ask"),
          title: "Run?",
          detail: "",
          action: { type: "command", command: "ls", cwd: null },
          options: [{ id: "yes", label: "Yes", effect: "allow" }],
          defaultOptionId: "yes",
        },
      });
      return;
    }
    setTimeout(finish, 2);
  }

  async steer(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async respond(requestId: string, _response: RequestResponse): Promise<void> {
    this.events.push({ type: "request.resolved", requestId });
    const finish = this.#pending;
    this.#pending = null;
    finish?.();
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    this.info.runtimeMode = mode;
  }

  async setInteractionMode(): Promise<void> {}

  async listModels() {
    return [
      {
        id: "big",
        aliases: [],
        label: "Big",
        description: "",
        efforts: [],
        defaultEffort: null,
        isDefault: true,
      },
    ];
  }

  async close(): Promise<void> {
    this.events.push({ type: "session.closed", error: null });
    this.events.end();
  }
}

/** Registers the `scripted` harness; returns a function that removes it. */
export function registerScripted(): () => void {
  return registerDriver({
    id: "scripted",
    label: "Scripted",
    unavailable: () => null,
    create: (options) => new ScriptedSession(options),
  });
}

export const scriptedSettings: SessionOptions = {
  cwd: "/work",
  model: null,
  effort: null,
  runtimeMode: "supervised",
  interactionMode: "default",
  resume: null,
};
