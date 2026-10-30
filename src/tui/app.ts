import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import {
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
  type Completion,
  type Report,
} from "../commands/registry.ts";
import type {
  HarnessId,
  HarnessRequest,
  Item,
  NativeCommand,
  RateLimit,
  SessionInfo,
  SessionOptions,
  UserInput,
} from "../core/events.ts";
import { FileIndex, mentionedImages, type FileMatch } from "../core/files.ts";
import { configDir, stateDir } from "../core/paths.ts";
import { Thread, errorMessage, type ThreadEvent } from "../core/thread.ts";
import { createSession } from "../drivers/index.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { ToolServer } from "../extensions/tool-server.ts";
import { Editor, applyEditingKey } from "./editor.ts";
import { InputDecoder, type InputEvent, type Key } from "./input.ts";
import { Menu, entry, infoPanel, lineStep, type MenuEntry } from "./menu.ts";
import { ChoicePrompt, type ChoiceConfig, type ChoiceResult } from "./prompt.ts";
import { Screen, type CursorPosition } from "./screen.ts";
import { setLightTheme, style } from "./theme.ts";
import { spread, truncate, visibleWidth } from "./text.ts";
import { Transcript, formatTokens, isToolItem, type Block } from "./transcript.ts";

export interface AppOptions {
  harness: HarnessId;
  session: SessionOptions;
  version: string;
  prompt: string | null;
  /** Extension modules to load besides the discovered ones. */
  extensions: string[];
}

const KEYS: [string, string][] = [
  ["enter", "send; while working, add to the running turn"],
  ["tab", "while working, queue as the next turn"],
  ["alt+enter, ctrl+j", "new line"],
  ["shift+tab", "toggle plan mode"],
  ["@", "mention a file or folder"],
  ["ctrl+j, ctrl+k", "move in any list, completions included"],
  ["j k, g G, ctrl+d ctrl+u", "move in lists that take no typing"],
  ["h l, q", "switch tabs and close in those lists"],
  ["esc", "interrupt the running turn"],
  ["pgup, pgdn, wheel", "scroll the conversation"],
  ["ctrl+c", "clear input, interrupt, or exit"],
  ["ctrl+z", "suspend"],
  ["shift+drag", "select text in most terminals"],
];

type Phase = "Thinking" | "Generating";

const FRAME_MS = 16;
const MENTION_LIMIT = 50;
const BLINK_MS = 500;
const WHEEL_ROWS = 3;
const THEME_TIMEOUT_MS = 150;
// Input held for the rest of a split escape sequence is released after this.
const SEQUENCE_TIMEOUT_MS = 40;
// The SDK warns that full access skips canUseTool, which 1harness keeps for later mode changes.
const IGNORED_STDERR = [/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, /^\(Use `node --trace-warnings/];

/** Rough tokens for text, as fx estimates its live counters. */
function estimateTokens(text: string): number {
  return text.length / 4;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The last bold heading in reasoning text, as Codex writes its summaries. */
function reasoningHeading(text: string): string | null {
  const headings = [...text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)];
  return headings.at(-1)?.[1]?.trim() ?? null;
}

/** How a file mention is written: `@path`, quoted when the path has spaces. */
function mentionText(path: string): string {
  return /[\s"\\]/.test(path) ? `@"${path.replace(/["\\]/g, "\\$&")}"` : `@${path}`;
}

function describeLimit(limit: RateLimit): string {
  const used = limit.usedPercent === null ? limit.status : `${Math.round(limit.usedPercent)}% used`;
  const resets =
    limit.resetsAt === null ? "" : ` · resets ${new Date(limit.resetsAt).toLocaleString()}`;
  return `${limit.label}: ${used}${resets}`;
}

export class App {
  #in = process.stdin;
  #screen = new Screen(process.stdout);
  #decoder = new InputDecoder();
  #editor = new Editor();
  #transcript = new Transcript();
  #harness: HarnessId;
  #settings: SessionOptions;
  #version: string;
  #thread: Thread | null = null;
  #unsubscribe: (() => void) | null = null;
  #info: SessionInfo | null = null;
  /** Lists that commands keep for the thread, such as models, fetched on first use. */
  #lookups = new Map<string, unknown[] | Promise<unknown[]>>();
  /** 1harness's commands, extensions' included. */
  #commands = new CommandRegistry();
  #context: CommandContext;
  #extensions: ExtensionHost;
  #extraExtensions: string[];
  /** Disconnects the extensions from the current thread. */
  #detach: (() => void) | null = null;
  /** Serves extensions' tools to every session over MCP. */
  #tools: ToolServer;
  #revokeTools: (() => void) | null = null;
  /** Config problems already shown, so each appears once. */
  #warned = new Set<string>();

  /** Item ID to the block that shows it. */
  #blocks = new Map<string, Block>();
  #turn: {
    startedAt: number;
    up: number;
    down: number;
    phase: Phase;
    /** The heading of the latest reasoning summary, which Codex shows as its status. */
    heading: string | null;
  } | null = null;
  /** Commands the harness runs itself, shown beside 1harness's own. */
  #nativeCommands: NativeCommand[] = [];

  #prompt: { prompt: ChoicePrompt; requestId: string | null } | null = null;
  #requests: HarnessRequest[] = [];
  #panel:
    | { kind: "menu"; menu: Menu; onDone: (index: number | null) => void }
    | { kind: "info"; title: string; rows: [string, string][] }
    | null = null;
  #slash: Menu | null = null;
  /** Composer text at which the slash menu was dismissed. */
  #slashDismissed: string | null = null;
  /** Completion for the words after a command, such as `/mcp login NAME`. */
  #args: { menu: Menu; start: number; items: Completion[] } | null = null;
  #argsDismissed: string | null = null;
  /** Files for `@` mentions, indexed on the first mention. */
  #files: FileIndex | null = null;
  #mention: { menu: Menu; start: number; entries: MenuEntry[]; matches: FileMatch[] } | null = null;
  #mentionDismissed: string | null = null;

  /** Rows the view sits above the bottom of the transcript; 0 follows new output. */
  #scroll = 0;
  #total = 0;
  #exitArmed = false;
  #exiting = false;
  #blinkOn = true;
  #blinkTimer: NodeJS.Timeout | null = null;
  #frame: NodeJS.Timeout | null = null;
  #sequenceTimer: NodeJS.Timeout | null = null;
  #themeReply: (() => void) | null = null;
  #stderrWrite: typeof process.stderr.write | null = null;
  #exited!: () => void;
  #done = new Promise<void>((resolve) => {
    this.#exited = resolve;
  });

  constructor(options: AppOptions) {
    this.#harness = options.harness;
    this.#settings = { ...options.session };
    this.#version = options.version;
    if (options.prompt) this.#editor.set(options.prompt);
    this.#context = this.#commandContext();
    for (const command of [...BUILTIN_COMMANDS, ...this.#clientCommands()])
      this.#commands.register(command);
    this.#extraExtensions = options.extensions;
    this.#extensions = new ExtensionHost({
      cwd: options.session.cwd,
      configDir: configDir(),
      stateDir: stateDir(),
      commands: this.#commands,
      ui: this.#context.ui,
    });
    this.#tools = new ToolServer(() => this.#extensions.tools, options.version);
  }

  /** The context every command runs with: this client's UI and the current thread. */
  #commandContext(): CommandContext {
    const context = {
      ui: {
        notify: (level, text) => this.#notice(level, text),
        report: (report) => this.#report(report),
        panel: (title, rows) => {
          this.#panel = { kind: "info", title, rows };
          this.#schedule();
        },
        pick: (title, entries, options) =>
          this.#pick(
            title,
            entries.map((item) => entry(item.label, item.detail ?? "", { tag: item.tag ?? "" })),
            options?.initial ?? 0,
            options?.filter ?? false,
          ),
        progress: (text) => {
          const line = this.#transcript.add<Extract<Block, { kind: "notice" }>>({
            kind: "notice",
            level: "info",
            text,
          });
          this.#schedule();
          return (level, outcome) => {
            line.level = level;
            line.text = outcome;
            this.#transcript.touch(line);
            this.#schedule();
          };
        },
        setInput: (text) => this.#editor.set(text),
      },
      session: () => this.#session(),
      lookup: (key, load) => this.#lookup(key, load),
      fetch: (key, load) => this.#fetch(key, load),
      forget: (key) => {
        this.#lookups.delete(key);
      },
      openThread: (options = {}) =>
        this.#open(options.harness ?? this.#harness, {
          ...this.#settings,
          resume: options.resume ?? null,
          ...(options.defaultModel ? { model: null, effort: null } : {}),
        }),
      exit: () => this.#exit(),
    } satisfies Omit<CommandContext, "harness" | "thread" | "info">;
    // Read live, since the thread changes under a command that outlives it.
    return Object.defineProperties(context, {
      harness: { get: () => this.#harness },
      thread: { get: () => this.#thread },
      info: { get: () => this.#info },
    }) as CommandContext;
  }

  /** Commands only this client has, since they show its own panels. */
  #clientCommands(): CommandDefinition[] {
    return [
      {
        name: "help",
        aliases: ["?"],
        description: "show commands and keys",
        group: "General",
        run: () => this.#help(),
      },
      {
        name: "status",
        description: "show session details",
        group: "General",
        run: () => this.#status(),
      },
    ];
  }

  async run(): Promise<void> {
    this.#in.setRawMode(true);
    this.#in.setEncoding("utf8");
    this.#in.on("data", (chunk: string) => this.#input(chunk));
    this.#in.resume();
    process.stdout.on("resize", () => {
      this.#screen.invalidate();
      this.#schedule();
    });
    this.#guard();
    this.#captureStderr();
    this.#screen.enter();
    await this.#detectTheme();

    this.#transcript.add({
      kind: "banner",
      title: "1harness",
      subtitle: `v${this.#version} · Run /help for commands`,
    });
    const initial = this.#editor.text;
    this.#editor.clear();
    this.#renderNow();
    await this.#extensions.loadAll(this.#extraExtensions);
    const waiting = this.#extensions.untrusted.length;
    if (waiting > 0) {
      this.#notice(
        "info",
        `This folder has ${waiting} ${waiting === 1 ? "extension" : "extensions"} of its own; /extensions trust loads them.`,
      );
    }
    await this.#open(this.#harness, this.#settings, false);
    if (initial.trim() !== "") this.#submit(initial);
    await this.#done;
  }

  /** Asks the terminal for its background; the device attributes reply bounds the wait. */
  async #detectTheme(): Promise<void> {
    const forced = process.env["ONEHARNESS_THEME"];
    if (forced === "light" || forced === "dark") {
      setLightTheme(forced === "light");
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, THEME_TIMEOUT_MS);
      this.#themeReply = () => {
        clearTimeout(timer);
        resolve();
      };
      process.stdout.write("\x1b]11;?\x1b\\\x1b[c");
    });
    this.#themeReply = null;
  }

  /** Restores the terminal however the process ends. */
  #guard(): void {
    const restore = () => {
      this.#screen.leave();
      if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
      if (this.#in.isTTY) this.#in.setRawMode(false);
    };
    process.once("exit", restore);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      process.once(signal, () => {
        void this.#exit().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
      });
    }
    process.on("uncaughtException", (error) => {
      restore();
      process.stderr.write(`1harness: ${error.stack ?? error.message}\n`);
      process.exit(1);
    });
  }

  /**
   * Shows in-process stderr output, such as library warnings, as notices.
   * Written directly, it would land on top of the frame.
   */
  #captureStderr(): void {
    this.#stderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const lines = text
        .split("\n")
        .filter(
          (line) => line.trim() !== "" && !IGNORED_STDERR.some((pattern) => pattern.test(line)),
        );
      if (lines.length > 0) this.#notice("warning", lines.join("\n"));
      return true;
    }) as typeof process.stderr.write;
  }

  // Session lifecycle

  async #open(harness: HarnessId, settings: SessionOptions, announce = true): Promise<void> {
    await this.#closeThread();
    this.#harness = harness;
    this.#settings = settings;
    this.#lookups.clear();
    this.#info = null;
    if (settings.resume) this.#notice("info", `Resuming ${harness} thread ${settings.resume}`);
    else if (announce) this.#notice("info", `New ${harness} thread`);
    try {
      const mcp = await this.#extensions.sessionServers(this.#tools);
      for (const warning of mcp.warnings) {
        if (this.#warned.has(warning)) continue;
        this.#warned.add(warning);
        this.#notice("warning", `MCP config: ${warning}`);
      }
      let created: Thread | null = null;
      const toolPolicy = this.#extensions.toolPolicy(() => created);
      const options = {
        ...settings,
        ...(Object.keys(mcp.servers).length > 0 ? { mcpServers: mcp.servers } : {}),
        ...(toolPolicy ? { toolPolicy } : {}),
      };
      const thread = new Thread(createSession(harness, options, { version: this.#version }));
      created = thread;
      mcp.grant?.bind(thread);
      this.#revokeTools = mcp.grant?.revoke ?? null;
      this.#thread = thread;
      this.#unsubscribe = thread.subscribe((event) => this.#event(event));
      this.#detach = this.#extensions.attach(thread);
      this.#info = thread.session.info;
      this.#schedule();
      await thread.start();
      void this.#loadCommands();
    } catch (error) {
      this.#notice("error", `Could not start ${harness}: ${errorMessage(error)}`);
    }
    this.#settings = { ...settings, resume: null };
  }

  /** Fetches the harness's own commands for completion and /help. */
  async #loadCommands(): Promise<void> {
    const thread = this.#thread;
    try {
      const commands = (await thread?.session.listCommands?.()) ?? [];
      if (thread !== this.#thread) return;
      const own = new Set(
        this.#commands.list().flatMap((command) => [command.name, ...(command.aliases ?? [])]),
      );
      // 1harness's commands take precedence, so the harness's copies are hidden.
      this.#nativeCommands = commands.filter(
        (command) => !own.has(command.name) && !command.aliases.some((alias) => own.has(alias)),
      );
      this.#syncSlash();
      this.#schedule();
    } catch {
      // Completion is a convenience; a harness that cannot list commands still runs them.
    }
  }

  async #closeThread(): Promise<void> {
    const thread = this.#thread;
    if (!thread) return;
    this.#unsubscribe?.();
    this.#detach?.();
    this.#revokeTools?.();
    this.#thread = null;
    this.#unsubscribe = null;
    this.#detach = null;
    this.#revokeTools = null;
    this.#prompt = null;
    this.#requests = [];
    this.#endTurn(null, null);
    this.#settle();
    this.#nativeCommands = [];
    await thread.close().catch(() => {});
  }

  async #exit(): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    const resume = this.#info?.threadId;
    const harness = this.#harness;
    await this.#closeThread();
    this.#files?.close();
    await this.#tools.close();
    await this.#extensions.close();
    for (const timer of [this.#blinkTimer, this.#frame, this.#sequenceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#screen.leave();
    if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
    this.#in.setRawMode(false);
    this.#in.pause();
    if (resume) {
      process.stdout.write(
        style.muted(`Resume with: 1harness --harness ${harness} --resume ${resume}\n`),
      );
    }
    this.#exited();
  }

  #suspend(): void {
    this.#screen.leave();
    this.#in.setRawMode(false);
    process.once("SIGCONT", () => {
      this.#in.setRawMode(true);
      this.#screen.enter();
      this.#renderNow();
    });
    process.kill(process.pid, "SIGTSTP");
  }

  // Thread events

  #event(event: ThreadEvent): void {
    switch (event.type) {
      case "session.updated":
        this.#info = event.info;
        this.#settings = {
          ...this.#settings,
          model: event.info.model,
          effort: event.info.effort,
          runtimeMode: event.info.runtimeMode,
          interactionMode: event.info.interactionMode,
        };
        break;
      case "turn.started":
        this.#startTurn();
        break;
      case "turn.ended":
        this.#endTurn(event.status, event.error);
        break;
      case "item.started":
      case "item.updated":
        this.#item(event.item, false);
        break;
      case "item.completed":
        this.#item(event.item, true);
        break;
      case "item.delta":
        this.#delta(event.itemId, event.chunk);
        break;
      case "request.opened":
        this.#requests.push(event.request);
        this.#nextRequest();
        break;
      case "request.resolved":
        this.#requests = this.#requests.filter((request) => request.id !== event.requestId);
        if (this.#prompt?.requestId === event.requestId) {
          this.#prompt = null;
          this.#nextRequest();
        }
        break;
      case "error":
        this.#notice("error", event.message);
        break;
      case "session.closed":
        this.#endTurn(null, null);
        this.#settle();
        this.#prompt = null;
        this.#requests = [];
        if (event.error)
          this.#notice("error", `Session ended: ${event.error}\nUse /new to start again.`);
        break;
      case "commands.updated":
        void this.#loadCommands();
        break;
      case "usage.updated":
      case "queue.changed":
        break;
    }
    this.#schedule();
  }

  #startTurn(): void {
    this.#turn ??= { startedAt: Date.now(), up: 0, down: 0, phase: "Thinking", heading: null };
  }

  /**
   * Closes the turn with fx's duration line. Commands can outlive the turn, as
   * Codex's background terminals do, so their rows stay live until they finish.
   */
  #endTurn(status: "completed" | "interrupted" | "failed" | null, error: string | null): void {
    for (const [id, block] of this.#blocks) {
      // Todo lists keep one ID across turns, but each turn shows its own.
      if (block.kind === "todos") this.#blocks.delete(id);
    }
    const turn = this.#turn;
    this.#turn = null;
    if (!turn || status === null) return;
    const seconds = Math.round((Date.now() - turn.startedAt) / 1000);
    const tokens = `(↑${formatTokens(Math.ceil(turn.up))} ↓${formatTokens(Math.ceil(turn.down))})`;
    const label =
      status === "interrupted" ? "Interrupted · " : status === "failed" ? "Failed · " : "";
    this.#transcript.add({ kind: "summary", text: `${label}${seconds}s ${tokens}` });
    if (status === "failed" && error) this.#notice("error", error);
  }

  /** Marks tool rows that will never finish, once their session has gone. */
  #settle(): void {
    for (const block of new Set(this.#blocks.values())) {
      if (block.kind !== "tools" || block.settled) continue;
      block.settled = true;
      this.#transcript.touch(block);
    }
  }

  #item(item: Item, completed: boolean): void {
    if (this.#thread?.busy && item.kind !== "notice") this.#startTurn();
    const existing = this.#blocks.get(item.id);
    switch (item.kind) {
      case "user_message": {
        if (existing?.kind === "user") {
          existing.text = item.text;
          this.#transcript.touch(existing);
          return;
        }
        this.#blocks.set(item.id, this.#transcript.add({ kind: "user", text: item.text }));
        if (this.#turn) this.#turn.up += estimateTokens(item.text);
        this.#scroll = 0;
        return;
      }
      case "assistant_message": {
        const block =
          existing?.kind === "assistant"
            ? existing
            : this.#transcript.add({ kind: "assistant", text: "" });
        this.#blocks.set(item.id, block);
        if (this.#turn && item.text.length > block.text.length)
          this.#turn.down += estimateTokens(item.text.slice(block.text.length));
        if (item.text.length >= block.text.length || completed) block.text = item.text;
        this.#transcript.touch(block);
        if (completed && this.#turn) this.#turn.phase = "Thinking";
        return;
      }
      case "reasoning":
        if (this.#turn) {
          this.#turn.phase = "Thinking";
          this.#turn.heading = reasoningHeading(item.text) ?? this.#turn.heading;
        }
        return;
      case "plan": {
        const block =
          existing?.kind === "plan" ? existing : this.#transcript.add({ kind: "plan", text: "" });
        this.#blocks.set(item.id, block);
        block.text = item.text;
        this.#transcript.touch(block);
        return;
      }
      case "todo_list": {
        const block =
          existing?.kind === "todos"
            ? existing
            : this.#transcript.add({ kind: "todos", steps: item.steps });
        this.#blocks.set(item.id, block);
        block.steps = item.steps;
        this.#transcript.touch(block);
        return;
      }
      case "notice": {
        // Notices with a stable ID, such as retries, update one line.
        if (existing?.kind === "notice") {
          existing.level = item.level;
          existing.text = item.text;
          this.#transcript.touch(existing);
          return;
        }
        const block = this.#transcript.add({ kind: "notice", level: item.level, text: item.text });
        if (item.id) this.#blocks.set(item.id, block);
        return;
      }
    }
    if (!isToolItem(item)) return;
    if (existing?.kind === "tools") {
      const index = existing.items.findIndex((other) => other.id === item.id);
      if (index === -1) existing.items.push(item);
      else existing.items[index] = item;
      this.#transcript.touch(existing);
      return;
    }
    // A todo list updated between tool calls does not split their group.
    const last = this.#transcript.last((block) => block.kind === "todos");
    const block =
      last?.kind === "tools" && !last.settled
        ? last
        : this.#transcript.add({ kind: "tools", items: [], settled: false });
    block.items.push(item);
    this.#blocks.set(item.id, block);
    this.#transcript.touch(block);
  }

  #delta(itemId: string, chunk: string): void {
    if (this.#turn) this.#turn.down += estimateTokens(chunk);
    const block = this.#blocks.get(itemId);
    if (block?.kind === "assistant" || block?.kind === "plan") {
      block.text += chunk;
      this.#transcript.touch(block);
      if (this.#turn) this.#turn.phase = "Generating";
      return;
    }
    const item = this.#thread?.item(itemId);
    if (this.#turn && item?.kind === "reasoning") {
      this.#turn.phase = "Thinking";
      this.#turn.heading = reasoningHeading(item.text) ?? this.#turn.heading;
    }
  }

  // Requests and pickers

  #nextRequest(): void {
    if (this.#prompt) return;
    const request = this.#requests[0];
    if (!request) return;
    if (request.kind === "approval") {
      const initial = Math.max(
        0,
        request.options.findIndex((option) => option.id === request.defaultOptionId),
      );
      const command = /^\$ /m.test(request.detail);
      this.#showPrompt(
        request.id,
        {
          header: "Permission needed",
          tag: command ? "Command" : "",
          title: request.title,
          detail: request.detail ? [request.detail] : [],
          options: request.options.map((option) => ({ label: option.label, description: "" })),
          multiSelect: false,
          allowOther: false,
          secret: false,
          initial,
        },
        (result) => {
          const option =
            result.kind === "options" ? request.options[result.indexes[0] ?? 0] : undefined;
          this.#respond(
            request.id,
            option ? { kind: "approval", optionId: option.id } : { kind: "cancel" },
          );
        },
      );
      return;
    }
    const answers: Record<string, string[]> = {};
    const ask = (index: number) => {
      const question = request.questions[index];
      if (!question) {
        this.#respond(request.id, { kind: "question", answers });
        return;
      }
      this.#showPrompt(
        request.id,
        {
          header: "Question",
          tag: question.header,
          title: question.question,
          detail: [],
          options: question.options,
          multiSelect: question.multiSelect,
          allowOther: question.allowOther,
          secret: question.secret,
          initial: 0,
        },
        (result) => {
          if (result.kind === "cancel") {
            this.#respond(request.id, { kind: "cancel" });
            return;
          }
          answers[question.id] =
            result.kind === "other"
              ? [result.text]
              : result.indexes.map((choice) => question.options[choice]?.label ?? "");
          ask(index + 1);
        },
      );
    };
    ask(0);
  }

  #showPrompt(
    requestId: string | null,
    config: ChoiceConfig,
    onDone: (result: ChoiceResult) => void,
  ): void {
    const prompt = new ChoicePrompt(config, (result) => {
      if (this.#prompt?.prompt === prompt) this.#prompt = null;
      onDone(result);
      this.#schedule();
    });
    this.#prompt = { prompt, requestId };
    this.#scroll = 0;
    this.#schedule();
  }

  #respond(requestId: string, response: Parameters<Thread["respond"]>[1]): void {
    this.#requests = this.#requests.filter((request) => request.id !== requestId);
    this.#thread
      ?.respond(requestId, response)
      .catch((error: unknown) => this.#notice("error", errorMessage(error)));
    this.#nextRequest();
  }

  #pick(title: string, entries: MenuEntry[], initial = 0, filter = false): Promise<number | null> {
    return new Promise((resolve) => {
      if (entries.length === 0) {
        resolve(null);
        return;
      }
      this.#panel = {
        kind: "menu",
        menu: new Menu({ title, entries, initial, filter }),
        onDone: resolve,
      };
      this.#schedule();
    });
  }

  // Input

  #input(chunk: string): void {
    if (this.#sequenceTimer) clearTimeout(this.#sequenceTimer);
    this.#sequenceTimer = null;
    for (const event of this.#decoder.feed(chunk)) this.#handle(event);
    if (this.#decoder.pending) {
      this.#sequenceTimer = setTimeout(() => {
        for (const event of this.#decoder.flush()) this.#handle(event);
        this.#renderNow();
      }, SEQUENCE_TIMEOUT_MS);
    }
    // Typing renders at once; streamed output is batched into frames.
    if (!this.#exiting) this.#renderNow();
  }

  #handle(event: InputEvent): void {
    switch (event.type) {
      case "attributes":
        this.#themeReply?.();
        return;
      case "background":
        setLightTheme(event.light);
        this.#transcript.invalidate();
        return;
      case "wheel":
        this.#scrollBy(-event.delta * WHEEL_ROWS);
        return;
      case "paste":
        if (this.#prompt) {
          if (this.#prompt.prompt.typing) this.#prompt.prompt.paste(event.text);
        } else if (!this.#panel) {
          this.#editor.insert(event.text);
          this.#syncCompletion();
        }
        return;
      case "key":
        this.#key(event.key);
        return;
    }
  }

  #key(key: Key): void {
    if (key.ctrl && key.name === "z") {
      this.#suspend();
      return;
    }
    if (key.ctrl && key.name === "l") {
      this.#screen.invalidate();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      if (!this.#panel) {
        const page = Math.max(1, this.#screen.rows - 8);
        this.#scrollBy(key.name === "pageup" ? page : -page);
        return;
      }
    }
    if (this.#prompt) {
      this.#prompt.prompt.key(key);
      return;
    }
    if (this.#panel) {
      this.#panelKey(key);
      return;
    }
    if (this.#slash && this.#slashKey(key)) return;
    if (this.#args && this.#argsKey(key)) return;
    if (this.#mention && this.#mentionKey(key)) return;
    this.#composerKey(key);
    this.#syncCompletion();
  }

  #panelKey(key: Key): void {
    const panel = this.#panel;
    if (!panel) return;
    if (panel.kind === "info") {
      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.text === "q" ||
        (key.ctrl && key.name === "c")
      )
        this.#panel = null;
      return;
    }
    const result = panel.menu.key(key);
    if (!result) return;
    this.#panel = null;
    panel.onDone(result.kind === "choose" ? result.index : null);
  }

  /** Keys for the slash command menu; returns false for keys that go to the composer. */
  #slashKey(key: Key): boolean {
    const menu = this.#slash;
    if (!menu) return false;
    // The composer takes typing, so only arrows and ctrl+j/k move here.
    const step = lineStep(key);
    if (step) {
      menu.move(step);
      return true;
    }
    if (key.name === "escape") {
      this.#slashDismissed = this.#editor.text;
      this.#slash = null;
      return true;
    }
    const selected = menu.selected();
    if (!selected) return false;
    if (key.name === "tab" && !key.shift) {
      this.#editor.set(`${selected.label} `);
      this.#syncCompletion();
      return true;
    }
    if (key.name === "return" && !key.meta) {
      this.#slash = null;
      this.#editor.set(selected.label);
      this.#submit(this.#editor.text);
      return true;
    }
    return false;
  }

  #syncCompletion(): void {
    this.#syncSlash();
    this.#syncArgs();
    this.#syncMention();
  }

  /** Opens, narrows, or closes the list of words that can follow a command. */
  #syncArgs(): void {
    const text = this.#editor.text;
    if (text !== this.#argsDismissed) this.#argsDismissed = null;
    const match = this.#argsDismissed === null ? /^\/(\S+) ([^\n]*)$/.exec(text) : null;
    const command = match ? this.#commands.find(match[1] ?? "") : undefined;
    const found =
      match && command && this.#isAvailable(command)
        ? (command.complete?.(this.#context, match[2] ?? "") ?? null)
        : null;
    if (!match || !found) {
      this.#args = null;
      return;
    }
    const typed = (match[2] ?? "").slice(found.start).toLowerCase();
    const items = found.items.filter((item) => item.value.toLowerCase().startsWith(typed));
    if (items.length === 0) {
      this.#args = null;
      return;
    }
    const entries = items.map((item) => entry(item.value, item.detail));
    const menu = this.#args?.menu ?? new Menu({ title: "", entries, bare: true });
    menu.setEntries(entries);
    const start = text.length - (match[2] ?? "").length + found.start;
    // Lined up under the word, past the composer's `┃ ` marker.
    menu.indent = 2 + visibleWidth(text.slice(0, start));
    this.#args = { menu, start, items };
  }

  /** Keys for the argument list; returns false for keys that go to the composer. */
  #argsKey(key: Key): boolean {
    const args = this.#args;
    if (!args) return false;
    const step = lineStep(key);
    if (step) {
      args.menu.move(step);
      return true;
    }
    if (key.name === "escape") {
      this.#argsDismissed = this.#editor.text;
      this.#args = null;
      return true;
    }
    const tab = key.name === "tab" && !key.shift;
    if (!tab && !(key.name === "return" && !key.meta)) return false;
    const selected = args.menu.selected();
    const item = args.items.find((candidate) => candidate.value === selected?.label);
    if (!item) return false;
    const text = `${this.#editor.text.slice(0, args.start)}${item.value}${item.more ? " " : ""}`;
    this.#editor.set(text);
    // Enter runs a finished command; a word that needs another keeps the list open.
    if (!tab && !item.more) this.#submit(text);
    else this.#syncCompletion();
    return true;
  }

  /**
   * A list kept for the thread. The first call starts the fetch and returns
   * nothing; completion menus fill in when it arrives.
   */
  #lookup<T>(key: string, load: () => Promise<T[]>): T[] {
    const cached = this.#lookups.get(key);
    if (Array.isArray(cached)) return cached as T[];
    if (cached === undefined) void this.#fetch(key, load).catch(() => {});
    return [];
  }

  #fetch<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
    const cached = this.#lookups.get(key);
    if (cached !== undefined) return Promise.resolve(cached as T[] | Promise<T[]>);
    const thread = this.#thread;
    const loading = load().then(
      (items) => {
        if (thread !== this.#thread || this.#lookups.get(key) !== loading) return items;
        this.#lookups.set(key, items);
        this.#syncCompletion();
        this.#schedule();
        return items;
      },
      (error: unknown) => {
        if (this.#lookups.get(key) === loading) this.#lookups.delete(key);
        throw error;
      },
    );
    this.#lookups.set(key, loading);
    return loading;
  }

  /** Commands the current session can run, in registration order. */
  #available(): CommandDefinition[] {
    return this.#commands.list().filter((command) => this.#isAvailable(command));
  }

  #isAvailable(command: CommandDefinition): boolean {
    try {
      return command.available?.(this.#context) ?? true;
    } catch {
      return false;
    }
  }

  /** Opens, narrows, or closes the slash menu to match the composer. */
  #syncSlash(): void {
    const text = this.#editor.text;
    if (text !== this.#slashDismissed) this.#slashDismissed = null;
    if (!/^\/\S*$/.test(text) || this.#slashDismissed !== null) {
      this.#slash = null;
      return;
    }
    const entries = this.#available()
      .filter((command) =>
        [command.name, ...(command.aliases ?? [])].some((name) => `/${name}`.startsWith(text)),
      )
      .map((command) => entry(`/${command.name}`, command.description, { tag: command.group }));
    for (const command of this.#nativeCommands) {
      if (![command.name, ...command.aliases].some((name) => `/${name}`.startsWith(text))) continue;
      entries.push(entry(`/${command.name}`, command.description, { tag: this.#tag(command) }));
    }
    if (entries.length === 0) {
      this.#slash = null;
      return;
    }
    if (this.#slash) this.#slash.setEntries(entries);
    else this.#slash = new Menu({ title: "Commands", entries });
  }

  /** Opens, narrows, or closes the file menu for an `@` word at the cursor. */
  #syncMention(): void {
    const text = this.#editor.text;
    if (text !== this.#mentionDismissed) this.#mentionDismissed = null;
    const token = this.#slash || this.#args ? null : this.#editor.token("@");
    const matches =
      token && this.#mentionDismissed === null
        ? this.#fileIndex().search(token.query, MENTION_LIMIT)
        : [];
    if (!token || matches.length === 0) {
      this.#mention = null;
      return;
    }
    const entries = matches.map((match) => {
      const trimmed = match.directory ? match.path.slice(0, -1) : match.path;
      const slash = trimmed.lastIndexOf("/");
      const name = trimmed.slice(slash + 1) + (match.directory ? "/" : "");
      return entry(name, trimmed.slice(0, slash + 1));
    });
    const menu = this.#mention?.menu ?? new Menu({ title: "Files", entries });
    menu.setEntries(entries);
    this.#mention = { menu, start: token.start, entries, matches };
  }

  /** The folder's file index, which loads and scans on first use. */
  #fileIndex(): FileIndex {
    if (this.#files?.cwd === this.#cwd()) return this.#files;
    this.#files?.close();
    const files = new FileIndex(this.#cwd());
    this.#files = files;
    files.load().then(
      () => {
        // Results fill in once the scan is done.
        if (this.#files !== files) return;
        this.#syncMention();
        this.#schedule();
      },
      (error: unknown) =>
        this.#notice("warning", `File completion is unavailable: ${errorMessage(error)}`),
    );
    return files;
  }

  /** Keys for the file menu; returns false for keys that go to the composer. */
  #mentionKey(key: Key): boolean {
    const mention = this.#mention;
    if (!mention) return false;
    // The composer takes typing, so only arrows and ctrl+j/k move here.
    const step = lineStep(key);
    if (step) {
      mention.menu.move(step);
      return true;
    }
    if (key.name === "escape") {
      this.#mentionDismissed = this.#editor.text;
      this.#mention = null;
      return true;
    }
    const accept = (key.name === "tab" && !key.shift) || (key.name === "return" && !key.meta);
    const selected = mention.menu.selected();
    const match = selected ? mention.matches[mention.entries.indexOf(selected)] : undefined;
    if (!accept || !match) return false;
    // A folder stays open for its contents; a file ends the word.
    const text = mentionText(match.path);
    this.#editor.replaceToken(mention.start, match.directory ? text : `${text} `);
    this.#syncCompletion();
    return true;
  }

  #composerKey(key: Key): void {
    if (key.ctrl && key.name === "c") {
      if (!this.#editor.empty) this.#editor.clear();
      else if (this.#thread?.busy) void this.#interrupt();
      else if (this.#exitArmed) void this.#exit();
      else {
        this.#exitArmed = true;
        setTimeout(() => {
          this.#exitArmed = false;
          this.#schedule();
        }, 1500);
      }
      return;
    }
    this.#exitArmed = false;
    if (key.ctrl && key.name === "d") {
      if (this.#editor.empty) void this.#exit();
      else this.#editor.delete();
      return;
    }
    if ((key.ctrl && key.name === "j") || (key.name === "return" && (key.meta || key.shift))) {
      this.#editor.insert("\n");
      return;
    }
    switch (key.name) {
      case "return":
        this.#submit(this.#editor.text);
        return;
      case "tab":
        if (key.shift) void this.#command("/plan");
        else if (this.#thread?.busy && this.#editor.text.trim() !== "") {
          this.#scroll = 0;
          this.#thread.send({ text: this.#editor.take() });
        }
        return;
      case "escape":
        if (this.#thread?.busy) void this.#interrupt();
        else this.#scroll = 0;
        return;
      case "up":
        if (!this.#editor.up()) this.#editor.historyUp();
        return;
      case "down":
        if (!this.#editor.down()) this.#editor.historyDown();
        return;
    }
    if (key.ctrl && key.name === "p") {
      this.#editor.historyUp();
      return;
    }
    if (key.ctrl && key.name === "n") {
      this.#editor.historyDown();
      return;
    }
    applyEditingKey(this.#editor, key);
  }

  #scrollBy(rows: number): void {
    this.#scroll = Math.max(0, this.#scroll + rows);
  }

  #submit(raw: string): void {
    const text = raw.trim();
    if (text === "") return;
    this.#editor.take();
    this.#slash = null;
    this.#args = null;
    this.#mention = null;
    this.#scroll = 0;
    if (text.startsWith("/") && !text.startsWith("//")) {
      void this.#command(text);
      return;
    }
    this.#send(text.startsWith("//") ? text.slice(1) : text);
  }

  #send(text: string): void {
    const thread = this.#thread;
    if (!thread || thread.closed) {
      this.#notice("error", "No session is running. Use /new to start one.");
      return;
    }
    const input: UserInput = { text };
    if (thread.session.capabilities.images) {
      const images = mentionedImages(text, this.#cwd());
      if (images.length > 0) input.images = images;
    }
    if (thread.busy) void thread.steer(input);
    else thread.send(input);
  }

  async #interrupt(): Promise<void> {
    try {
      await this.#thread?.interrupt();
    } catch (error) {
      this.#notice("error", `Interrupt failed: ${errorMessage(error)}`);
    }
  }

  // Commands

  async #command(text: string): Promise<void> {
    // Arguments keep their lines, since a skill may take a whole prompt.
    const [, name = "", arg = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
    try {
      const own = this.#commands.find(name);
      if (own) {
        if (!this.#isAvailable(own)) throw new Error(`/${own.name} is not available here`);
        await own.run(this.#context, arg.trim());
        return;
      }
      const native = this.#nativeCommands.find(
        (command) => command.name === name || command.aliases.includes(name),
      );
      if (native || this.#thread?.session.capabilities.nativeSlashCommands) {
        // The harness runs its own commands and skills, such as Claude's /context or Codex's /review.
        if (!this.#thread || this.#thread.closed) throw new Error("No session is running.");
        // One the harness did not list goes as a message; the harness says if it has none.
        if (native) await this.#thread.command(native, arg.trim());
        else this.#thread.send({ text });
        return;
      }
      this.#notice("warning", `Unknown command /${name}. Type /help for commands.`);
    } catch (error) {
      this.#notice("error", errorMessage(error));
    } finally {
      this.#schedule();
    }
  }

  #tag(command: NativeCommand): string {
    return command.kind === "skill" ? "skills" : this.#harness;
  }

  #session() {
    const thread = this.#thread;
    if (!thread || thread.closed) throw new Error("No session is running. Use /new to start one.");
    return thread.session;
  }

  #help(): void {
    const own = this.#available();
    const entries = own.map((command) =>
      entry(
        command.usage ? `/${command.name} ${command.usage}` : `/${command.name}`,
        command.description,
        { group: command.group },
      ),
    );
    // The harness's own commands under a tab named after it, and its skills under their own.
    const native = [...this.#nativeCommands];
    for (const command of native) {
      const usage = command.argumentHint
        ? `/${command.name} ${command.argumentHint}`
        : `/${command.name}`;
      entries.push(entry(usage, command.description, { group: this.#tag(command) }));
    }
    for (const [keys, description] of KEYS)
      entries.push(entry(keys, description, { group: "Keys", inert: true }));
    this.#panel = {
      kind: "menu",
      menu: new Menu({ title: "Commands", entries, tabs: true, action: "open" }),
      onDone: (index) => {
        if (index === null) return;
        const chosen = own[index]?.name ?? native[index - own.length]?.name;
        if (chosen) void this.#command(`/${chosen}`);
      },
    };
  }

  #status(): void {
    const info = this.#info;
    if (!info) return;
    const usage = this.#usageSummary();
    const rows: [string, string][] = [
      ["Harness", `${info.harness}${info.version ? ` ${info.version}` : ""}`],
      ["Thread", info.threadId ?? "not started"],
      ["Folder", info.cwd],
      ["Model", `${info.model ?? "default"}${info.effort ? ` · ${info.effort}` : ""}`],
      ["Mode", `${info.runtimeMode}${info.interactionMode === "plan" ? " · plan" : ""}`],
    ];
    if (usage) rows.push(["Usage", usage]);
    const limits = this.#thread?.usage?.limits ?? [];
    if (limits.length > 0) rows.push(["Limits", limits.map(describeLimit).join("\n")]);
    this.#panel = { kind: "info", title: "Status", rows };
  }

  #report(report: Report): void {
    this.#transcript.add({ kind: "report", ...report });
    this.#scroll = 0;
    this.#schedule();
  }

  // Output

  #cwd(): string {
    return this.#info?.cwd ?? this.#settings.cwd;
  }

  #notice(level: "info" | "warning" | "error", text: string): void {
    this.#transcript.add({ kind: "notice", level, text });
    this.#schedule();
  }

  #usageSummary(): string {
    const usage = this.#thread?.usage;
    if (!usage) return "";
    const parts: string[] = [];
    if (usage.contextTokens !== null && usage.contextWindow) {
      const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
      parts.push(
        `ctx ${formatTokens(usage.contextTokens)}/${formatTokens(usage.contextWindow)} (${percent}%)`,
      );
    }
    if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 1 ? 3 : 2)}`);
    return parts.join(" · ");
  }

  #schedule(): void {
    if (this.#frame || this.#exiting) return;
    this.#frame = setTimeout(() => this.#renderNow(), FRAME_MS);
  }

  #renderNow(): void {
    if (this.#frame) clearTimeout(this.#frame);
    this.#frame = null;
    if (this.#exiting) return;
    const width = this.#screen.columns;
    const height = this.#screen.rows;
    const context = { width, cwd: this.#cwd(), blink: this.#blinkOn };
    let footer = this.#footer(width, height);
    const room = Math.max(0, height - footer.rows.length);
    let view = this.#transcript.view(context, room, this.#scroll);
    if (this.#scroll > 0) {
      // Hold the view still while output arrives below it.
      const scroll = Math.min(
        Math.max(0, view.total - room),
        this.#scroll + Math.max(0, view.total - this.#total),
      );
      if (scroll !== this.#scroll) {
        this.#scroll = scroll;
        view = this.#transcript.view(context, room, scroll);
        footer = this.#footer(width, height);
      }
    }
    this.#total = view.total;
    const cursor = footer.cursor
      ? { row: view.rows.length + footer.cursor.row, column: footer.cursor.column }
      : null;
    this.#screen.render([...view.rows, ...footer.rows], cursor);
    this.#animate();
  }

  /** Runs the blink only while something on screen is in progress. */
  #animate(): void {
    const active = this.#turn !== null || this.#transcript.animating;
    if (active && !this.#blinkTimer) {
      this.#blinkTimer = setInterval(() => {
        this.#blinkOn = !this.#blinkOn;
        this.#schedule();
      }, BLINK_MS);
    } else if (!active && this.#blinkTimer) {
      clearInterval(this.#blinkTimer);
      this.#blinkTimer = null;
      this.#blinkOn = true;
    }
  }

  /** The rows below the transcript: activity, queue, and the composer or a panel. */
  #footer(width: number, height: number): { rows: string[]; cursor: CursorPosition | null } {
    const rows: string[] = [""];
    if (this.#turn && !this.#prompt) rows.push(this.#activity(width), "");
    const queue = this.#thread?.queue ?? [];
    for (const queued of queue)
      rows.push(truncate(style.muted(`  ↳ queued: ${oneLine(queued.text)}`), width));
    if (queue.length > 0) rows.push("");

    let cursor: CursorPosition | null = null;
    if (this.#prompt) {
      const rendered = this.#prompt.prompt.render(width);
      if (rendered.cursor)
        cursor = { row: rows.length + rendered.cursor.row, column: rendered.cursor.column };
      rows.push(...rendered.rows);
    } else {
      const limit = Math.max(1, Math.min(10, Math.floor(height / 3)));
      const layout = this.#editor.layout(`${style.strong("┃")} `, width);
      const start = Math.max(
        0,
        Math.min(layout.cursor.row - limit + 1, layout.rows.length - limit),
      );
      if (!this.#panel)
        cursor = { row: rows.length + layout.cursor.row - start, column: layout.cursor.column };
      rows.push(...layout.rows.slice(start, start + limit));
      // Room for the list: the screen less the rows above it, the panel chrome, and a little transcript.
      const listRows = Math.max(3, Math.min(14, height - rows.length - 8));
      if (this.#panel?.kind === "menu") rows.push(...this.#panel.menu.render(width, listRows));
      else if (this.#panel?.kind === "info")
        rows.push(...infoPanel(this.#panel.title, this.#panel.rows, width));
      else if (this.#slash) rows.push(...this.#slash.render(width, listRows));
      // fx keeps the status line under an argument list.
      else if (this.#args)
        rows.push(...this.#args.menu.render(width, listRows), this.#statusLine(width));
      else if (this.#mention) rows.push(...this.#mention.menu.render(width, listRows));
      else rows.push("", this.#statusLine(width));
    }
    if (rows.length > height) {
      const cut = rows.length - height;
      if (cursor) cursor = { ...cursor, row: Math.max(0, cursor.row - cut) };
      return { rows: rows.slice(cut), cursor };
    }
    return { rows, cursor };
  }

  /** fx's activity line: a blinking dot, the phase and elapsed time, then the token estimate. */
  #activity(width: number): string {
    const turn = this.#turn;
    if (!turn) return "";
    const seconds = Math.floor((Date.now() - turn.startedAt) / 1000);
    // Streaming text, then running tools, then what the model says it is doing.
    const phase =
      turn.phase === "Generating"
        ? "Generating"
        : this.#transcript.animating
          ? "Running"
          : (turn.heading ?? turn.phase);
    const dot = this.#blinkOn ? style.text("•") : " ";
    const tokens = `(↑${formatTokens(Math.ceil(turn.up))} ↓${formatTokens(Math.ceil(turn.down))})`;
    const hint = this.#thread?.session.capabilities.steer
      ? "esc interrupt · enter adds to turn · tab queues"
      : "esc interrupt · enter queues";
    return spread(
      `${dot} ${style.text(`${phase} (${seconds}s)`)} ${style.muted(tokens)}`,
      style.muted(hint),
      width,
    );
  }

  #statusLine(width: number): string {
    if (this.#exitArmed) return style.muted("Press ctrl+c again to exit");
    const info = this.#info;
    const parts: string[] = [this.#harness];
    if (info) {
      parts.push(info.model ?? "default model");
      if (info.effort) parts.push(info.effort);
    }
    const usage = this.#usageSummary();
    if (usage) parts.push(usage);
    // Subscription limits appear once they need attention.
    for (const limit of this.#thread?.usage?.limits ?? []) {
      if (limit.status === "ok") continue;
      parts.push(
        limit.status === "exceeded"
          ? `${limit.label} limit reached`
          : `${limit.label} ${limit.usedPercent === null ? "near limit" : `${Math.round(limit.usedPercent)}%`}`,
      );
    }
    let left = `${style.text(info?.runtimeMode ?? this.#settings.runtimeMode)}${style.muted(` · ${parts.join(" · ")}`)}`;
    if (info?.interactionMode === "plan") left += `${style.muted(" · ")}${style.strong("plan")}`;
    const right = this.#scroll > 0 ? style.muted(`↓ ${this.#scroll} more lines · pgdn`) : "";
    return spread(left, right, width);
  }
}
