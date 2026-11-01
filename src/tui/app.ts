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
  NativeCommand,
  RateLimit,
  SessionInfo,
  SessionOptions,
  UserInput,
} from "../core/events.ts";
import { FileIndex, mentionedImages, type FileMatch } from "../core/files.ts";
import { configDir, stateDir } from "../core/paths.ts";
import { errorMessage, type Thread, type ThreadEvent } from "../core/thread.ts";
import { findDriver } from "../drivers/index.ts";
import type { ToolDefinition } from "../extensions/api.ts";
import { ExtensionHost } from "../extensions/host.ts";
import { ToolServer } from "../extensions/tool-server.ts";
import {
  ThreadManager,
  type ManagedThread,
  type ManagerEvent,
  type SwitchResult,
} from "../host/manager.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { agentRowOf, agentStatus, harnessLabel, treePrefixes } from "./agents.ts";
import { Editor, applyEditingKey } from "./editor.ts";
import { InputDecoder, type InputEvent, type Key } from "./input.ts";
import { Menu, entry, infoPanel, lineStep, type MenuEntry } from "./menu.ts";
import { ChoicePrompt, type ChoiceConfig, type ChoiceResult } from "./prompt.ts";
import { Screen, type CursorPosition } from "./screen.ts";
import {
  STATUS_QUERY,
  StatusReporter,
  statusRecords,
  type ThreadStatusInput,
} from "./program-status.ts";
import { setLightTheme, style } from "./theme.ts";
import { spread, truncate, visibleWidth } from "./text.ts";
import { formatTokens, type Block } from "./transcript.ts";
import { ThreadView, queuedText } from "./view.ts";

export interface AppOptions {
  harness: HarnessId;
  session: SessionOptions;
  version: string;
  prompt: string | null;
  /** Extension modules to load besides the discovered ones. */
  extensions: string[];
  /** Problems with the config files, shown once the screen is up. */
  warnings: string[];
}

const KEYS: [string, string][] = [
  ["enter", "send; while working, add to the running turn"],
  ["tab", "while working, queue as the next turn"],
  ["alt+enter, ctrl+j", "new line"],
  ["shift+tab", "toggle plan mode"],
  ["ctrl+t", "switch threads"],
  ["ctrl+o", "open the agent that needs you"],
  ["alt+↑", "go to the thread that started this one"],
  ["@", "mention a file or folder"],
  ["ctrl+j, ctrl+k", "move in any list, completions included"],
  ["j k, g G, ctrl+d ctrl+u", "move in lists that take no typing"],
  ["h l, q", "switch tabs and close in those lists"],
  ["esc", "stop the running turn and the agents under it"],
  ["pgup, pgdn, wheel", "scroll the conversation"],
  ["ctrl+c", "clear input, interrupt, or exit"],
  ["ctrl+z", "suspend"],
  ["shift+drag", "select text in most terminals"],
];

const FRAME_MS = 16;
const MENTION_LIMIT = 50;
const BLINK_MS = 500;
const WHEEL_ROWS = 3;
const THEME_TIMEOUT_MS = 150;
// Program status reports go out at most this often, coalescing bursts of events.
const STATUS_INTERVAL_MS = 250;
// Input held for the rest of a split escape sequence is released after this.
const SEQUENCE_TIMEOUT_MS = 40;
// The SDK warns that full access skips canUseTool, which 1harness keeps for later mode changes.
const IGNORED_STDERR = [/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, /^\(Use `node --trace-warnings/];

interface OpenRequest {
  threadId: string;
  request: HarnessRequest;
}

function sameRequest(a: OpenRequest, threadId: string, requestId: string): boolean {
  return a.threadId === threadId && a.request.id === requestId;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** How a file mention is written: `@path`, quoted when the path has spaces. */
function mentionText(path: string): string {
  return /[\s"\\]/.test(path) ? `@"${path.replace(/["\\]/g, "\\$&")}"` : `@${path}`;
}

function harnessName(harness: HarnessId): string {
  return findDriver(harness)?.label ?? harness;
}

/** A resumed thread this large, or idle this long, costs more to pick up than it looks. */
const HEAVY_RESUME_TOKENS = 100_000;
const COLD_RESUME_MS = 60 * 60 * 1000;

function idleFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * What a move to another harness did, in a sentence or two, and how loudly to
 * say it: a warning when the thread it resumed is large or long idle, since its
 * first message pays for all of that context again.
 */
function describeSwitch(result: SwitchResult): { level: "info" | "warning"; text: string } {
  const to = harnessName(result.to);
  const lines: string[] = [];
  if (result.resumeError)
    lines.push(
      `Could not resume ${to}'s earlier thread (${result.resumeError}); started a new one.`,
    );
  const context = result.resumedContext;
  const size = context?.tokens ? `about ${formatTokens(context.tokens)} tokens of context, ` : "";
  const where = context
    ? `its earlier thread (${size}last used ${idleFor(context.idleMs)})`
    : "a new thread";
  const turns = `${result.handedOver} ${result.handedOver === 1 ? "turn" : "turns"}`;
  lines.push(
    result.handedOver > 0
      ? `Now on ${to}, in ${where}. Your next message brings it up to date on ${context ? `the ${turns} since` : `the ${turns} before`}.`
      : `Now on ${to}, in ${where}.`,
  );
  const heavy =
    context !== null &&
    ((context.tokens ?? 0) >= HEAVY_RESUME_TOKENS || context.idleMs >= COLD_RESUME_MS);
  if (heavy)
    lines.push(
      `Its whole earlier context is sent again with that message. /harness ${result.to} fresh starts a new ${to} thread with a handoff instead.`,
    );
  return { level: heavy ? "warning" : "info", text: lines.join("\n") };
}

/** What an approval asks to do, in one line, such as `Run: pnpm test`. */
function approvalLine(request: Extract<HarnessRequest, { kind: "approval" }>): string {
  const action = request.action;
  switch (action.type) {
    case "command":
      return `Run: ${action.command}`;
    case "file_change":
      return `Edit ${action.paths.join(", ")}`;
    case "tool":
      return `Use ${action.tool}${request.title ? `: ${request.title}` : ""}`;
    case "other":
      return request.title;
  }
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
  /** The harness and settings the next thread starts with. */
  #harness: HarnessId;
  #settings: SessionOptions;
  #version: string;
  /** Every thread, live or in the background; the one shown is `#currentId`. */
  #manager: ThreadManager;
  #orchestrator: Orchestrator;
  #orchestratorTools: ReadonlyMap<string, { tool: ToolDefinition }>;
  #views = new Map<string, ThreadView>();
  /** What shows before the first thread starts; the first thread then takes it over. */
  #home = new ThreadView("home");
  #currentId: string | null = null;
  /** The line a thread being opened shows first, such as "New codex thread". */
  #announce: string | null = null;
  /** Lists that commands keep for the thread, such as models, fetched on first use. */
  #lookups = new Map<string, unknown[] | Promise<unknown[]>>();
  /** 1harness's commands, extensions' included. */
  #commands = new CommandRegistry();
  #context: CommandContext;
  #extensions: ExtensionHost;
  #extraExtensions: string[];
  #warnings: string[];
  /** Serves extensions' and the orchestrator's tools to every session over MCP. */
  #tools: ToolServer;
  /** Commands the harness runs itself, shown beside 1harness's own. */
  #nativeCommands: NativeCommand[] = [];

  /** The prompt on screen, and the request it answers; request IDs are only unique per thread. */
  #prompt: { prompt: ChoicePrompt; asking: OpenRequest } | null = null;
  /** Open requests from every thread, oldest first; background ones say whose they are. */
  #requests: OpenRequest[] = [];
  /** Threads left running in the background, closed once they and their children are done. */
  #retired = new Set<string>();
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

  #exitArmed = false;
  #exiting = false;
  #blinkOn = true;
  #blinkTimer: NodeJS.Timeout | null = null;
  #frame: NodeJS.Timeout | null = null;
  #sequenceTimer: NodeJS.Timeout | null = null;
  #themeReply: (() => void) | null = null;
  /** Reports each thread's state to a terminal that supports it, such as Rex. */
  #programStatus: StatusReporter | null = null;
  #statusTimer: NodeJS.Timeout | null = null;
  /**
   * Whether the user is looking: the terminal's focus reports say so, and so
   * does typing. Terminals report only changes, so until either arrives it is
   * taken as no, which errs toward telling the user about finished work.
   */
  #focused = false;
  /** How many of each thread's runs the user has seen, for which finished runs are news. */
  #seenRuns = new Map<string, number>();
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
    this.#warnings = options.warnings;
    this.#extensions = new ExtensionHost({
      cwd: options.session.cwd,
      configDir: configDir(),
      stateDir: stateDir(),
      commands: this.#commands,
      ui: this.#context.ui,
    });
    this.#tools = new ToolServer(
      () => new Map([...this.#extensions.tools, ...this.#orchestratorTools]),
      options.version,
    );
    this.#manager = new ThreadManager({
      version: options.version,
      extensions: this.#extensions,
      tools: this.#tools,
      onWarning: (text) => this.#notice("warning", text),
    });
    this.#orchestrator = new Orchestrator(this.#manager);
    this.#orchestratorTools = new Map(
      this.#orchestrator.tools.map((tool) => [tool.name, { tool }]),
    );
    this.#manager.subscribe((event) => this.#managerEvent(event));
  }

  /** The view on screen: the current thread's, or the startup one. */
  get #view(): ThreadView {
    return (this.#currentId && this.#views.get(this.#currentId)) || this.#home;
  }

  get #current(): ManagedThread | undefined {
    return this.#currentId ? this.#manager.get(this.#currentId) : undefined;
  }

  get #thread(): Thread | null {
    return this.#current?.thread ?? null;
  }

  get #info(): SessionInfo | null {
    return this.#current?.thread.info ?? null;
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
          const view = this.#view;
          const line = view.transcript.add<Extract<Block, { kind: "notice" }>>({
            kind: "notice",
            level: "info",
            text,
          });
          this.#schedule();
          return (level, outcome) => {
            line.level = level;
            line.text = outcome;
            view.transcript.touch(line);
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
      switchHarness: (harness, options) => this.#switchHarness(harness, options?.fresh === true),
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
      {
        name: "threads",
        usage: "[id]",
        description: "switch to another thread, such as one an agent started (also ctrl+t)",
        group: "Session",
        complete: () => ({
          start: 0,
          items: this.#threadOrder().map((thread) => ({
            value: thread.id,
            detail: `${thread.harness} · ${thread.status} · ${thread.title}`,
            more: false,
          })),
        }),
        run: (_context, args) => this.#switchThread(args),
      },
      {
        name: "stop",
        description: "stop the running turn and the agents under it (also esc)",
        group: "Session",
        run: () => this.#stop(),
      },
      {
        name: "close",
        usage: "[id]",
        description: "end a thread and the threads it started",
        group: "Session",
        available: () => this.#manager.list().some((thread) => thread.status !== "closed"),
        run: async (_context, args) => {
          const id = args || this.#currentId;
          const thread = id ? this.#manager.get(id) : undefined;
          if (!thread) throw new Error(`No thread ${id ?? ""}`);
          await this.#manager.close(thread.id);
          this.#notice("info", `Closed ${thread.id} ${thread.title}`.trim());
        },
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
    await this.#detectTerminal();

    this.#home.transcript.add({
      kind: "banner",
      title: "1harness",
      subtitle: `v${this.#version} · Run /help for commands`,
    });
    for (const warning of this.#warnings) this.#notice("warning", warning);
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

  /**
   * Asks the terminal for its background and whether it takes program status
   * reports; the device attributes reply, which every terminal sends, bounds
   * the wait. Either can be set instead with ONEHARNESS_THEME and
   * ONEHARNESS_PROGRAM_STATUS.
   */
  async #detectTerminal(): Promise<void> {
    const theme = process.env["ONEHARNESS_THEME"];
    const themeSet = theme === "light" || theme === "dark";
    if (themeSet) setLightTheme(theme === "light");
    const status = process.env["ONEHARNESS_PROGRAM_STATUS"];
    if (status === "1") this.#enableStatus();
    const query = `${themeSet ? "" : "\x1b]11;?\x1b\\"}${status === "0" || status === "1" ? "" : STATUS_QUERY}`;
    if (query === "") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, THEME_TIMEOUT_MS);
      this.#themeReply = () => {
        clearTimeout(timer);
        resolve();
      };
      process.stdout.write(`${query}\x1b[c`);
    });
    this.#themeReply = null;
  }

  #enableStatus(): void {
    this.#programStatus ??= new StatusReporter((data) => process.stdout.write(data));
    this.#statusChanged();
  }

  /** Reports the threads' states soon, coalescing the events that changed them. */
  #statusChanged(): void {
    if (!this.#programStatus || this.#statusTimer || this.#exiting) return;
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = null;
      this.#reportStatus();
    }, STATUS_INTERVAL_MS);
  }

  #reportStatus(): void {
    if (!this.#programStatus || this.#exiting) return;
    // What finishes on screen while the user can see it is not news.
    if (this.#currentId && this.#focused) this.#markSeen(this.#currentId);
    const threads = this.#manager.list().map((thread) => this.#statusInput(thread));
    this.#programStatus.update(statusRecords(threads, (id) => this.#seenRuns.get(id) ?? 0));
  }

  /** Marks the thread's finished runs seen; one still running is news when it ends. */
  #markSeen(id: string): void {
    const runs = this.#manager.get(id)?.runs ?? [];
    const running = runs.at(-1)?.status === "running";
    this.#seenRuns.set(id, runs.length - (running ? 1 : 0));
  }

  #statusInput(managed: ManagedThread): ThreadStatusInput {
    const request = managed.thread.requests[0];
    const run = managed.runs.at(-1);
    return {
      id: managed.id,
      parentId: managed.parentId,
      title: managed.title,
      status: managed.status,
      request: request
        ? {
            kind: request.kind,
            title:
              request.kind === "approval"
                ? approvalLine(request)
                : (request.questions[0]?.question ?? "A question"),
          }
        : null,
      lastRun: run
        ? { index: run.index, status: run.status, result: run.result, error: run.error }
        : null,
      error: managed.error,
      activity: this.#views.get(managed.id)?.turn?.heading ?? null,
      notify: managed.origin === "user",
    };
  }

  /** Restores the terminal however the process ends. */
  #guard(): void {
    const restore = () => {
      this.#programStatus?.clear();
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

  /**
   * Starts a thread and shows it. The one shown before keeps running in the
   * background while it has work, or threads it started do; otherwise it ends.
   * If the new thread cannot start, the one shown before stays.
   */
  async #open(harness: HarnessId, settings: SessionOptions, announce = true): Promise<void> {
    const previous = this.#current;
    const before = { harness: this.#harness, settings: this.#settings };
    this.#announce = settings.resume
      ? `Resuming ${harness} thread ${settings.resume}`
      : announce
        ? `New ${harness} thread`
        : null;
    try {
      // The manager announces the thread, which shows it.
      await this.#manager.create({ harness, settings });
    } catch (error) {
      if (previous && previous.status !== "closed" && previous.id !== this.#currentId)
        this.#show(previous);
      this.#harness = before.harness;
      this.#settings = before.settings;
      this.#notice("error", `Could not start ${harness}: ${errorMessage(error)}`);
      return;
    } finally {
      this.#announce = null;
    }
    // As asked for, since the harness may not report them all yet.
    this.#settings = { ...settings, resume: null };
    void this.#loadCommands();
    if (previous && previous.id !== this.#currentId) await this.#retire(previous);
  }

  /**
   * Moves the thread on screen to another harness, carrying its context over.
   * With no thread running, starts one on that harness instead.
   */
  async #switchHarness(harness: HarnessId, fresh: boolean): Promise<void> {
    const current = this.#current;
    if (!current || current.status === "closed") {
      // Models and efforts are harness-specific, so the new thread uses its defaults.
      await this.#open(harness, { ...this.#settings, resume: null, model: null, effort: null });
      return;
    }
    const settle = this.#context.ui.progress(
      harness === current.harness
        ? `Starting ${harnessName(harness)} over…`
        : `Moving ${current.id} to ${harnessName(harness)}…`,
    );
    try {
      const { level, text } = describeSwitch(
        await this.#manager.switchHarness(current.id, harness, { fresh }),
      );
      settle(level, text);
    } catch (error) {
      settle("error", `Could not move to ${harnessName(harness)}: ${errorMessage(error)}`);
    }
  }

  /** Whether a thread or one it started still has work. */
  #busy(thread: ManagedThread): boolean {
    return [thread, ...this.#manager.descendants(thread.id)].some(
      (other) => other.status !== "closed" && (other.status === "starting" || !other.thread.idle),
    );
  }

  /** Ends a thread left behind, or lets it finish in the background first. */
  async #retire(thread: ManagedThread): Promise<void> {
    if (thread.status === "closed") return;
    if (this.#busy(thread)) {
      this.#retired.add(thread.id);
      this.#notice("info", `${thread.id} keeps working in the background; /threads switches back.`);
      return;
    }
    await this.#manager.close(thread.id);
  }

  /** Closes background threads that have finished, unless the one on screen is among them. */
  #closeRetired(): void {
    for (const id of this.#retired) {
      const thread = this.#manager.get(id);
      if (!thread || thread.status === "closed") {
        this.#retired.delete(id);
        continue;
      }
      const family = [thread, ...this.#manager.descendants(id)];
      if (this.#busy(thread) || family.some((other) => other.id === this.#currentId)) continue;
      this.#retired.delete(id);
      void this.#manager.close(id);
    }
  }

  /** Shows a thread, picking one from the tree of threads when no ID is given. */
  async #switchThread(id: string): Promise<void> {
    let target = id ? this.#manager.get(id) : undefined;
    if (!target) {
      if (id) throw new Error(`No thread ${id}`);
      const threads = this.#threadOrder();
      const prefixes = treePrefixes(threads);
      const index = await this.#pick(
        "Threads",
        threads.map((thread, row) =>
          entry(
            `${prefixes[row] ?? ""}${thread.title || thread.id}`,
            `${harnessLabel(thread)} · ${agentStatus(thread)}`,
            { tag: thread.id === this.#currentId ? "current" : thread.id },
          ),
        ),
        Math.max(
          0,
          threads.findIndex((thread) => thread.id === this.#currentId),
        ),
        true,
      );
      target = index === null ? undefined : threads[index];
    }
    if (!target || target.id === this.#currentId) return;
    this.#show(target);
  }

  #show(thread: ManagedThread): void {
    this.#currentId = thread.id;
    // Opening a thread shows what it finished.
    this.#statusChanged();
    this.#retired.delete(thread.id);
    // A prompt belongs to the thread it asks for; it comes back with that thread.
    if (this.#prompt && this.#prompt.asking.threadId !== thread.id) this.#prompt = null;
    this.#nextRequest();
    // /new and /harness start from the thread on screen.
    const info = thread.thread.info;
    this.#harness = thread.harness;
    this.#settings = {
      ...this.#settings,
      cwd: info.cwd,
      model: info.model,
      effort: info.effort,
      runtimeMode: info.runtimeMode,
      interactionMode: info.interactionMode,
      resume: null,
    };
    this.#lookups.clear();
    this.#nativeCommands = [];
    void this.#loadCommands();
    this.#schedule();
  }

  /** Threads with each one's children right after it. */
  #threadOrder(): ManagedThread[] {
    const all = this.#manager.list();
    const under = (parentId: string | null): ManagedThread[] =>
      all
        .filter((thread) => thread.parentId === parentId)
        .flatMap((thread) => [thread, ...under(thread.id)]);
    return under(null);
  }

  /** Fetches the harness's own commands for completion and /help. */
  async #loadCommands(): Promise<void> {
    const thread = this.#thread;
    const session = thread?.session;
    try {
      const commands = (await session?.listCommands?.()) ?? [];
      // A switch keeps the thread but not the session, whose commands no longer apply.
      if (thread !== this.#thread || session !== this.#thread?.session) return;
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

  async #exit(): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    const resume = this.#info?.threadId;
    const harness = this.#harness;
    this.#prompt = null;
    this.#requests = [];
    await this.#manager.closeAll();
    this.#files?.close();
    await this.#tools.close();
    await this.#extensions.close();
    for (const timer of [this.#blinkTimer, this.#frame, this.#sequenceTimer, this.#statusTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#programStatus?.clear();
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
    // A suspended 1harness reports nothing; its records come back when it resumes.
    this.#programStatus?.clear();
    this.#screen.leave();
    this.#in.setRawMode(false);
    process.once("SIGCONT", () => {
      this.#in.setRawMode(true);
      this.#screen.enter();
      this.#renderNow();
      this.#statusChanged();
    });
    process.kill(process.pid, "SIGTSTP");
  }

  // Thread events

  #managerEvent(event: ManagerEvent): void {
    this.#statusChanged();
    switch (event.type) {
      case "thread.created": {
        const thread = event.thread;
        // The first thread takes over the startup view, banner and all.
        const firstView = this.#currentId === null && !this.#views.has(this.#home.id);
        const view = firstView ? this.#home : new ThreadView(thread.id);
        this.#views.set(thread.id, view);
        if (firstView) this.#views.set(this.#home.id, view);
        if (thread.parentId) this.#childRow(thread);
        // Threads the user opens are shown; ones agents start run in the background.
        if (thread.origin === "user") {
          this.#show(thread);
          if (this.#announce) view.notice("info", this.#announce);
        }
        break;
      }
      case "thread.updated": {
        const thread = event.thread;
        if (thread.parentId) this.#childRow(thread);
        if (thread.status === "closed") {
          this.#dropRequests(thread.id);
          // For a harness that closes without saying so; otherwise already done.
          const view = this.#views.get(thread.id);
          view?.endTurn(null, null);
          view?.settle();
        }
        this.#closeRetired();
        break;
      }
      case "thread.event":
        this.#threadEvent(event.threadId, event.event);
        break;
    }
    this.#schedule();
  }

  #threadEvent(threadId: string, event: ThreadEvent): void {
    const managed = this.#manager.get(threadId);
    const view = this.#views.get(threadId);
    const current = threadId === this.#currentId;
    switch (event.type) {
      case "session.updated":
        if (current)
          this.#settings = {
            ...this.#settings,
            model: event.info.model,
            effort: event.info.effort,
            runtimeMode: event.info.runtimeMode,
            interactionMode: event.info.interactionMode,
          };
        return;
      case "request.opened":
        this.#requests.push({ threadId, request: event.request });
        this.#nextRequest();
        return;
      case "request.resolved": {
        this.#requests = this.#requests.filter(
          (open) => !sameRequest(open, threadId, event.requestId),
        );
        const asking = this.#prompt?.asking;
        if (asking && sameRequest(asking, threadId, event.requestId)) {
          this.#prompt = null;
          this.#nextRequest();
        }
        return;
      }
      case "commands.updated":
        if (current) void this.#loadCommands();
        return;
      case "session.replaced":
        // Another harness: its models, commands, and settings replace the old one's.
        if (current && managed) this.#show(managed);
        return;
      case "session.closed":
        this.#dropRequests(threadId);
        break;
      default:
        break;
    }
    if (view && managed) view.apply(event, managed.thread);
  }

  /** Forgets a closed thread's requests, closing its prompt if one is open. */
  #dropRequests(threadId: string): void {
    this.#requests = this.#requests.filter((open) => open.threadId !== threadId);
    if (this.#prompt?.asking.threadId === threadId) {
      this.#prompt = null;
      this.#nextRequest();
    }
  }

  /** The row in a parent's transcript for a thread it started. */
  #childRow(child: ManagedThread): void {
    const view = child.parentId ? this.#views.get(child.parentId) : undefined;
    view?.agent(agentRowOf(child));
  }

  // Requests and pickers

  /**
   * Shows the current thread's oldest request. Other threads' requests wait
   * for the user to open them, announced by the attention line, so a prompt
   * never takes over the composer for a thread not on screen.
   */
  #nextRequest(): void {
    if (this.#prompt) return;
    const next = this.#requests.find((open) => open.threadId === this.#currentId);
    if (!next) return;
    const request = next.request;
    const respond = (response: Parameters<Thread["respond"]>[1]) => this.#respond(next, response);
    if (request.kind === "approval") {
      const initial = Math.max(
        0,
        request.options.findIndex((option) => option.id === request.defaultOptionId),
      );
      const command = /^\$ /m.test(request.detail);
      this.#showPrompt(
        next,
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
          respond(option ? { kind: "approval", optionId: option.id } : { kind: "cancel" });
        },
      );
      return;
    }
    const answers: Record<string, string[]> = {};
    const ask = (index: number) => {
      const question = request.questions[index];
      if (!question) {
        respond({ kind: "question", answers });
        return;
      }
      this.#showPrompt(
        next,
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
            respond({ kind: "cancel" });
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
    asking: OpenRequest,
    config: ChoiceConfig,
    onDone: (result: ChoiceResult) => void,
  ): void {
    const prompt = new ChoicePrompt(config, (result) => {
      if (this.#prompt?.prompt === prompt) this.#prompt = null;
      onDone(result);
      this.#schedule();
    });
    this.#prompt = { prompt, asking };
    this.#view.scroll = 0;
    this.#schedule();
  }

  #respond(asked: OpenRequest, response: Parameters<Thread["respond"]>[1]): void {
    const { threadId, request } = asked;
    this.#requests = this.#requests.filter((open) => !sameRequest(open, threadId, request.id));
    this.#manager
      .get(threadId)
      ?.thread.respond(request.id, response)
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
    if (
      (event.type === "key" || event.type === "paste" || event.type === "wheel") &&
      !this.#focused
    ) {
      this.#focused = true;
      this.#statusChanged();
    }
    switch (event.type) {
      case "attributes":
        this.#themeReply?.();
        return;
      case "programStatus":
        if (process.env["ONEHARNESS_PROGRAM_STATUS"] !== "0") this.#enableStatus();
        return;
      case "focus":
        this.#focused = event.focused;
        this.#statusChanged();
        return;
      case "background":
        setLightTheme(event.light);
        for (const view of new Set([this.#home, ...this.#views.values()]))
          view.transcript.invalidate();
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
    if (key.ctrl && key.name === "t" && !this.#prompt && !this.#panel) {
      void this.#switchThread("").catch((error: unknown) =>
        this.#notice("error", errorMessage(error)),
      );
      return;
    }
    // Moving between threads works under a prompt, which comes back with its thread.
    if (key.ctrl && key.name === "o" && !this.#panel) {
      const asking = this.#requests.find((open) => open.threadId !== this.#currentId);
      const thread = asking ? this.#manager.get(asking.threadId) : undefined;
      if (thread) this.#show(thread);
      return;
    }
    // Without a parent, alt+↑ is up.
    const parent = this.#manager.get(this.#current?.parentId ?? "");
    if (key.meta && key.name === "up" && !this.#panel && parent) {
      this.#show(parent);
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
    const entries: MenuEntry[] = [];
    // A command typed in full comes first and is selected, so /mode runs /mode, not /model.
    let exact: string | null = null;
    const add = (names: string[], made: MenuEntry) => {
      if (!names.some((name) => `/${name}`.startsWith(text))) return;
      if (exact === null && names.some((name) => `/${name}` === text)) {
        exact = made.label;
        entries.unshift(made);
      } else entries.push(made);
    };
    for (const command of this.#available())
      add(
        [command.name, ...(command.aliases ?? [])],
        entry(`/${command.name}`, command.description, { tag: command.group }),
      );
    for (const command of this.#nativeCommands)
      add(
        [command.name, ...command.aliases],
        entry(`/${command.name}`, command.description, { tag: this.#tag(command) }),
      );
    if (entries.length === 0) {
      this.#slash = null;
      return;
    }
    if (this.#slash) this.#slash.setEntries(entries);
    else this.#slash = new Menu({ title: "Commands", entries });
    if (exact !== null) this.#slash.select(exact);
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
      else if (this.#thread?.busy) void this.#stop();
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
          this.#view.scroll = 0;
          this.#thread.send({ text: this.#editor.take() });
        }
        return;
      case "escape":
        if (this.#thread?.busy) void this.#stop();
        else this.#view.scroll = 0;
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
    this.#view.scroll = Math.max(0, this.#view.scroll + rows);
  }

  #submit(raw: string): void {
    const text = raw.trim();
    if (text === "") return;
    this.#editor.take();
    this.#slash = null;
    this.#args = null;
    this.#mention = null;
    this.#view.scroll = 0;
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
    if (thread.capabilities.images) {
      const images = mentionedImages(text, this.#cwd());
      if (images.length > 0) input.images = images;
    }
    if (thread.busy) void thread.steer(input);
    else thread.send(input);
  }

  /** Stops the turn on screen and every agent under it. */
  async #stop(): Promise<void> {
    const id = this.#currentId;
    if (!id) return;
    try {
      await this.#orchestrator.stop(id);
    } catch (error) {
      this.#notice("error", `Could not stop ${id}: ${errorMessage(error)}`);
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
      if (native || this.#thread?.capabilities.nativeSlashCommands) {
        // The harness runs its own commands and skills, such as Claude's /context or Codex's /review.
        if (!this.#thread || this.#thread.closed) throw new Error("No session is running.");
        // One the harness did not list goes as a message; the harness says if it has none.
        if (native) await this.#thread.command(native, arg.trim());
        else this.#thread.send({ text }, undefined, { command: true });
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
    if (!thread.session) throw new Error("The session is closed; send a message to resume it.");
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
      ["Thread", `${this.#currentId ?? ""} · ${info.threadId ?? "not started"}`],
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
    this.#view.report(report);
    this.#schedule();
  }

  // Output

  #cwd(): string {
    return this.#info?.cwd ?? this.#settings.cwd;
  }

  #notice(level: "info" | "warning" | "error", text: string): void {
    this.#view.notice(level, text);
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
    const context = { width, cwd: this.#cwd(), blink: this.#blinkOn, now: Date.now() };
    const shown = this.#view;
    let footer = this.#footer(width, height);
    const room = Math.max(0, height - footer.rows.length);
    let view = shown.transcript.view(context, room, shown.scroll);
    if (shown.scroll > 0) {
      // Hold the view still while output arrives below it.
      const scroll = Math.min(
        Math.max(0, view.total - room),
        shown.scroll + Math.max(0, view.total - shown.total),
      );
      if (scroll !== shown.scroll) {
        shown.scroll = scroll;
        view = shown.transcript.view(context, room, scroll);
        footer = this.#footer(width, height);
      }
    }
    shown.total = view.total;
    const cursor = footer.cursor
      ? { row: view.rows.length + footer.cursor.row, column: footer.cursor.column }
      : null;
    this.#screen.render([...view.rows, ...footer.rows], cursor);
    this.#animate();
  }

  /** Runs the blink only while something on screen is in progress. */
  #animate(): void {
    const active = this.#view.turn !== null || this.#view.transcript.animating;
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
    if (this.#view.turn && !this.#prompt) rows.push(this.#activity(width), "");
    const queue = this.#thread?.queue ?? [];
    for (const queued of queue)
      rows.push(truncate(style.muted(`  ↳ queued: ${oneLine(queuedText(queued))}`), width));
    if (queue.length > 0) rows.push("");
    const attention = this.#attention(width);
    if (attention) rows.push(attention, "");

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

  /**
   * The line that says another thread needs the user, such as an agent's
   * approval: the oldest one, with how many more are waiting.
   */
  #attention(width: number): string | null {
    const waiting = this.#requests.filter((open) => open.threadId !== this.#currentId);
    const [first] = waiting;
    const thread = first ? this.#manager.get(first.threadId) : undefined;
    if (!first || !thread) return null;
    const what = first.request.kind === "question" ? "has a question" : "needs approval";
    const others = new Set(waiting.map((open) => open.threadId)).size - 1;
    const more = others > 0 ? style.muted(` · ${others} more`) : "";
    const left = `${style.attention("◆")} ${style.text(thread.id)} ${style.soft(harnessLabel(thread))}${style.muted(" · ")}${style.strong(thread.title || "untitled")} ${style.attention(what)}${more}`;
    return spread(truncate(left, Math.max(0, width - 14)), style.muted("ctrl+o open"), width);
  }

  /** fx's activity line: a blinking dot, the phase and elapsed time, then the token estimate. */
  #activity(width: number): string {
    const turn = this.#view.turn;
    if (!turn) return "";
    const seconds = Math.floor((Date.now() - turn.startedAt) / 1000);
    // Streaming text, then running tools, then what the model says it is doing.
    const phase =
      turn.phase === "Generating"
        ? "Generating"
        : this.#view.transcript.running
          ? "Running"
          : (turn.heading ?? turn.phase);
    const dot = this.#blinkOn ? style.text("•") : " ";
    const tokens = `(↑${formatTokens(Math.ceil(turn.up))} ↓${formatTokens(Math.ceil(turn.down))})`;
    const hint = this.#thread?.capabilities.steer
      ? "esc stop · enter adds to turn · tab queues"
      : "esc stop · enter queues";
    const left = `${dot} ${style.text(`${phase} (${seconds}s)`)} ${style.muted(tokens)}`;
    // A narrow screen keeps what the turn is doing and drops the keys.
    if (visibleWidth(left) + visibleWidth(hint) + 2 > width) return truncate(left, width);
    return spread(left, style.muted(hint), width);
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
    // With more than one thread, which one this is and what the others are doing.
    const threads = this.#manager.list().filter((thread) => thread.status !== "closed");
    if (threads.length > 1 && this.#currentId) parts.push(this.#currentId);
    const others = threads.filter(
      (thread) => thread.id !== this.#currentId && thread.status !== "idle",
    ).length;
    if (others > 0) parts.push(`${others} other ${others === 1 ? "thread" : "threads"} working`);
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
    const scroll = this.#view.scroll;
    const right = scroll > 0 ? style.muted(`↓ ${scroll} more lines · pgdn`) : "";
    return spread(left, right, width);
  }
}
