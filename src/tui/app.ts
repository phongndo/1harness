import { randomUUID } from "node:crypto";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import {
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
  type CommandThread,
  type Completion,
  type Completions,
  type PickEntry,
  type Report,
  type SessionHandle,
} from "../commands/registry.ts";
import type {
  HarnessId,
  HarnessRequest,
  NativeCommand,
  RateLimit,
  RequestResponse,
  SessionInfo,
  SessionOptions,
} from "../core/events.ts";
import type { FileMatch } from "../core/files.ts";
import { errorMessage } from "../core/thread.ts";
import type { ClientEvent, HostClient } from "../client/client.ts";
import {
  RpcError,
  SESSION_CALLS,
  type CommandInfo,
  type LogEntry,
  type ThreadState,
  type UiRequest,
} from "../protocol.ts";
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
  threadStatusInput,
  type ThreadStatusInput,
} from "./program-status.ts";
import { setLightTheme, style } from "./theme.ts";
import { spread, truncate, visibleWidth } from "./text.ts";
import { formatTokens, type Block } from "./transcript.ts";
import { ThreadView, queuedText, type ViewContext } from "./view.ts";

export interface AppOptions {
  /** The host the terminal works through, in this process or a server's. */
  client: HostClient;
  harness: HarnessId;
  /** What the first thread starts with; `resume` opens a stored or native thread instead. */
  session: SessionOptions;
  version: string;
  prompt: string | null;
  /** Problems the terminal found itself, shown once the screen is up. */
  warnings: string[];
  /** Things worth saying once the screen is up, such as which server it reached. */
  notes?: string[];
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

/** What a thread's view shows of a log too long to load at once. */
interface Paged {
  entries: { seq: number; entry: LogEntry }[];
  /** The first entry loaded, which the page before ends at. */
  oldest: number | null;
  more: boolean;
  children: Map<string, ThreadState>;
}

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

/** A short date and time, for lists of threads. */
function day(time: number): string {
  return new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** A command's pick entry as a menu row. */
function pickEntry(item: PickEntry): MenuEntry {
  return entry(item.label, item.detail ?? "", {
    tag: item.tag ?? "",
    ...(item.group ? { group: item.group } : {}),
  });
}

/** How a file mention is written: `@path`, quoted when the path has spaces. */
function mentionText(path: string): string {
  return /[\s"\\]/.test(path) ? `@"${path.replace(/["\\]/g, "\\$&")}"` : `@${path}`;
}

/** How often a file search the host is still indexing for is asked again. */
const FILES_RETRY_MS = 300;
/** How many log entries a thread's view loads at a time. */
const PAGE_ENTRIES = 400;

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
  /** The host, and every thread's state as it last said. */
  #client: HostClient;
  /** The harness and settings the next thread starts with. */
  #harness: HarnessId;
  #settings: SessionOptions;
  #version: string;
  #views = new Map<string, ThreadView>();
  /** What shows before the first thread starts; the first thread then takes it over. */
  #home = new ThreadView("home");
  #homeTaken = false;
  #currentId: string | null = null;
  /** Threads this terminal has seen created, whose views it built from the start. */
  #known = new Set<string>();
  /** Threads whose logs are loading, and the live entries that arrived meanwhile. */
  #loading = new Map<string, { seq: number; entry: LogEntry }[]>();
  /** Threads whose views show only the newest part of their logs. */
  #paged = new Map<string, Paged>();
  /** Threads this terminal opened or showed, which its program status covers. */
  #own = new Set<string>();
  /** The line a thread being opened shows first, such as "New codex thread". */
  #announce: string | null = null;
  /** Lists that commands keep for the thread, such as models, fetched on first use. */
  #lookups = new Map<string, unknown[] | Promise<unknown[]>>();
  /** 1harness's commands, the host's included. */
  #commands = new CommandRegistry();
  /** The host's commands, such as extensions', as registered here. */
  #hostCommands: (() => void)[] = [];
  /** Completions the host gave for its commands, by command and arguments. */
  #completions = new Map<string, Completions | null | Promise<void>>();
  #context: CommandContext;
  #warnings: string[];
  #notes: string[];
  /** Commands the harness runs itself, shown beside 1harness's own. */
  #nativeCommands: NativeCommand[] = [];
  /** Whether the host keeps threads, so one can be resumed by its 1harness ID. */
  #stored = false;

  /** The prompt on screen, and the request it answers; request IDs are only unique per thread. */
  #prompt: { prompt: ChoicePrompt; asking: OpenRequest } | null = null;
  /** Open requests from every thread, oldest first; background ones say whose they are. */
  #requests: OpenRequest[] = [];
  #panel:
    | {
        kind: "menu";
        menu: Menu;
        onDone: (index: number | null) => void;
        /** The host's pick request it answers. */
        pick?: string;
      }
    | { kind: "info"; title: string; rows: [string, string][] }
    | null = null;
  /** The host's progress lines, by request. */
  #progress = new Map<string, (level: "info" | "warning" | "error", text: string) => void>();
  #slash: Menu | null = null;
  /** Composer text at which the slash menu was dismissed. */
  #slashDismissed: string | null = null;
  /** Completion for the words after a command, such as `/mcp login NAME`. */
  #args: { menu: Menu; start: number; items: Completion[] } | null = null;
  #argsDismissed: string | null = null;
  /** Files for `@` mentions, as the host found them, by folder and query. */
  #fileResults = new Map<string, FileMatch[] | Promise<void>>();
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
    this.#client = options.client;
    this.#harness = options.harness;
    this.#settings = { ...options.session };
    this.#version = options.version;
    if (options.prompt) this.#editor.set(options.prompt);
    this.#context = this.#commandContext();
    for (const command of [...BUILTIN_COMMANDS, ...this.#clientCommands()])
      this.#commands.register(command);
    this.#warnings = options.warnings;
    this.#notes = options.notes ?? [];
    this.#client.on((event) => this.#hostEvent(event));
  }

  /** The view on screen: the current thread's, or the startup one. */
  get #view(): ThreadView {
    return (this.#currentId && this.#views.get(this.#currentId)) || this.#home;
  }

  get #current(): ThreadState | undefined {
    return this.#currentId ? this.#client.threads.get(this.#currentId) : undefined;
  }

  /** The thread on screen, unless it has ended. */
  get #live(): ThreadState | null {
    const current = this.#current;
    return current && current.status !== "closed" ? current : null;
  }

  get #info(): SessionInfo | null {
    return this.#current?.info ?? null;
  }

  /** Calls a session operation on a thread, wherever its host runs. */
  #callSession(threadId: string, method: (typeof SESSION_CALLS)[number], args: unknown[]) {
    return this.#client.call("thread.call", { threadId, method, args });
  }

  /** The thread as commands reach it. */
  #threadHandle(state: ThreadState): CommandThread {
    return {
      id: state.id,
      closed: state.status === "closed",
      busy: state.busy,
      parked: state.status === "parked",
      send: async (text) => {
        await this.#client.call("thread.send", { threadId: state.id, text });
      },
      unqueue: async () =>
        (await this.#client.call("thread.unqueue", { threadId: state.id })) ?? undefined,
    };
  }

  /** The thread's session as commands reach it: the methods its harness has, through the host. */
  #sessionHandle(state: ThreadState): SessionHandle {
    const id = state.id;
    const handle: Record<string, unknown> = {
      capabilities: state.capabilities,
      info: state.info,
      setRuntimeMode: (mode: unknown) => this.#callSession(id, "setRuntimeMode", [mode]),
      setInteractionMode: (mode: unknown) => this.#callSession(id, "setInteractionMode", [mode]),
    };
    for (const method of state.methods) {
      const call = SESSION_CALLS.find((candidate) => candidate === method);
      if (call) handle[call] = (...args: unknown[]) => this.#callSession(id, call, args);
    }
    return handle as unknown as SessionHandle;
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
            entries.map(pickEntry),
            options?.initial ?? 0,
            options?.filter ?? false,
            {
              tabs: options?.tabs ?? false,
            },
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
      session: () => {
        const live = this.#live;
        if (!live) throw new Error("No session is running. Use /new to start one.");
        return this.#sessionHandle(live);
      },
      harnesses: () => this.#client.harnesses,
      threads: (scope) => this.#client.call("threads.list", { scope }),
      lookup: (key, load) => this.#lookup(key, load),
      fetch: (key, load) => this.#fetch(key, load),
      forget: (key) => {
        this.#lookups.delete(key);
      },
      openThread: async (options = {}) => {
        if (options.resume) {
          await this.#resume(options.resume, options.harness ?? this.#harness);
          return;
        }
        await this.#open(options.harness ?? this.#harness, {
          ...this.#settings,
          resume: null,
          ...(options.defaultModel ? { model: null, effort: null } : {}),
        });
      },
      switchHarness: (harness, options) => this.#switchHarness(harness, options?.fresh === true),
      exit: () => this.#exit(),
    } satisfies Omit<CommandContext, "harness" | "thread" | "info">;
    // Read live, since the thread changes under a command that outlives it.
    return Object.defineProperties(context, {
      harness: { get: () => this.#harness },
      thread: {
        get: () => {
          const current = this.#current;
          return current ? this.#threadHandle(current) : null;
        },
      },
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
        usage: "[id | words]",
        description:
          "open threads, recent and archived ones, or search what they said (also ctrl+t)",
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
        name: "rename",
        usage: "<title>",
        description: "rename this thread",
        group: "Session",
        available: () => this.#current !== undefined,
        run: async (_context, args) => {
          const current = this.#current;
          if (!current) throw new Error("No thread to rename");
          if (!args) throw new Error("Usage: /rename <title>");
          await this.#client.call("thread.rename", { threadId: current.id, title: args });
          this.#notice("info", `Renamed ${current.id}: ${args}`);
        },
      },
      {
        name: "pin",
        usage: "[id]",
        description: "keep a thread at the top of /threads and /resume, or unpin it",
        group: "Session",
        run: async (_context, args) => {
          const id = args || this.#currentId;
          if (!id) throw new Error("No thread to pin");
          const pinned = !(this.#client.threads.get(id)?.pinned ?? false);
          const listed = await this.#client.call("thread.flag", { threadId: id, pinned });
          this.#notice("info", `${listed.pinned ? "Pinned" : "Unpinned"} ${id}`);
        },
      },
      {
        name: "archive",
        usage: "[id]",
        description: "end a thread and move it out of the lists, into /threads' Archived tab",
        group: "Session",
        run: async (_context, args) => {
          const id = args || this.#currentId;
          if (!id) throw new Error("No thread to archive");
          await this.#client.call("thread.flag", { threadId: id, archived: true });
          this.#notice("info", `Archived ${id}; /threads lists it under Archived.`);
        },
      },
      {
        name: "unarchive",
        usage: "<id>",
        description: "bring an archived thread back into the lists",
        group: "Session",
        run: async (_context, args) => {
          if (!args) throw new Error("Usage: /unarchive <id>");
          await this.#client.call("thread.flag", { threadId: args, archived: false });
          this.#notice("info", `Brought ${args} back; /resume ${args} opens it.`);
        },
      },
      {
        name: "fork",
        usage: "[turn]",
        description: "start a new thread from this one's turns, through a turn or all of them",
        group: "Session",
        available: () => (this.#current?.runCount ?? 0) > 0,
        run: async (_context, args) => {
          const current = this.#current;
          if (!current) throw new Error("No thread to fork");
          const turn = args ? Number(args) : undefined;
          if (turn !== undefined && !Number.isInteger(turn)) throw new Error("Usage: /fork [turn]");
          const fork = await this.#client.call("thread.fork", {
            threadId: current.id,
            ...(turn === undefined ? {} : { turn }),
          });
          const shown = this.#client.threads.get(fork.id) ?? fork;
          if (this.#currentId !== shown.id) this.#show(shown);
        },
      },
      {
        name: "forget",
        usage: "[id]",
        description: "delete a thread and the threads it started, for good",
        group: "Session",
        run: async (_context, args) => {
          const id = args || this.#currentId;
          if (!id) throw new Error("No thread to forget");
          const title = this.#client.threads.get(id)?.title;
          const answer = await this.#pick(
            `Forget ${id}${title ? ` (${title})` : ""}? Its transcript and the threads it started go too.`,
            [entry("Keep it"), entry("Forget it for good")],
          );
          if (answer !== 1) return;
          const { forgotten } = await this.#client.call("thread.forget", { threadId: id });
          this.#notice("info", `Forgot ${forgotten.join(", ")}`);
          if (this.#currentId === null || forgotten.includes(this.#currentId)) {
            const next = this.#threadOrder().find((thread) => thread.status !== "closed");
            if (next) this.#show(next);
            else await this.#open(this.#harness, { ...this.#settings, resume: null });
          }
        },
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
        available: () =>
          [...this.#client.threads.values()].some((thread) => thread.status !== "closed"),
        run: async (_context, args) => {
          const id = args || this.#currentId;
          const thread = id ? this.#client.threads.get(id) : undefined;
          if (!thread) throw new Error(`No thread ${id ?? ""}`);
          await this.#client.call("thread.close", { threadId: thread.id });
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
    for (const note of this.#notes) this.#notice("info", note);
    const initial = this.#editor.text;
    this.#editor.clear();
    this.#renderNow();
    let hello;
    try {
      hello = await this.#client.connect();
    } catch (error) {
      this.#notice("error", `Could not reach 1harness: ${errorMessage(error)}`);
      this.#renderNow();
      await this.#exit();
      return;
    }
    this.#stored = hello.store !== null;
    for (const thread of hello.threads) this.#known.add(thread.id);
    for (const warning of hello.warnings)
      this.#notice(warning.startsWith("This folder has") ? "info" : "warning", warning);
    this.#registerHostCommands(hello.commands);
    for (const request of hello.pending) this.#ui(request);
    const held = hello.threads.filter((thread) => thread.held).map((thread) => thread.id);
    if (held.length > 0)
      this.#notice(
        "info",
        `${held.join(", ")} ${held.length === 1 ? "has" : "have"} messages waiting from before 1harness stopped; /threads opens ${held.length === 1 ? "it" : "them"}.`,
      );
    const resume = this.#settings.resume;
    if (resume) await this.#resume(resume, this.#harness);
    else await this.#open(this.#harness, this.#settings, false);
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
    const threads = this.#ownThreads().map((thread) => this.#statusInput(thread));
    this.#programStatus.update(
      statusRecords(threads, (id) =>
        Math.max(this.#seenRuns.get(id) ?? 0, this.#client.threads.get(id)?.seenRuns ?? 0),
      ),
    );
  }

  /**
   * The threads this terminal reports: the ones it opened or showed, and the
   * agents they started. Another terminal on the same host reports its own.
   */
  #ownThreads(): ThreadState[] {
    const all = [...this.#client.threads.values()];
    const mine = (thread: ThreadState): boolean =>
      this.#own.has(thread.id) ||
      (thread.parentId !== null &&
        (() => {
          const parent = this.#client.threads.get(thread.parentId);
          return parent ? mine(parent) : false;
        })());
    return all.filter(mine);
  }

  /**
   * Marks the thread's finished runs seen, here and on the host, which other
   * clients go by; one still running is news when it ends.
   */
  #markSeen(id: string): void {
    const thread = this.#client.threads.get(id);
    if (!thread) return;
    const running = thread.lastRun?.status === "running";
    const seen = thread.runCount - (running ? 1 : 0);
    if (seen > (this.#seenRuns.get(id) ?? 0) && seen > thread.seenRuns)
      void this.#client.call("thread.seen", { threadId: id, runs: seen }).catch(() => {});
    this.#seenRuns.set(id, seen);
  }

  #statusInput(thread: ThreadState): ThreadStatusInput {
    return threadStatusInput(thread, this.#views.get(thread.id)?.turn?.heading ?? null);
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
   * Starts a thread and shows it. The one shown before stays open; if the new
   * thread cannot start, the one shown before stays on screen.
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
      // The host announces the thread as it starts, which shows it.
      const state = await this.#client.call("thread.open", { harness, settings });
      if (this.#currentId !== state.id) this.#show(state);
    } catch (error) {
      if (previous && previous.id !== this.#currentId) {
        const again = this.#client.threads.get(previous.id);
        if (again) this.#show(again);
      }
      this.#harness = before.harness;
      this.#settings = before.settings;
      this.#notice("error", `Could not start ${harness}: ${errorMessage(error)}`);
      return;
    } finally {
      this.#announce = null;
    }
    // As asked for, since the harness may not report them all yet.
    this.#settings = { ...settings, resume: null };
  }

  /** Opens an earlier thread: 1harness's own, such as `t42`, or a harness's by its ID. */
  async #resume(id: string, harness: HarnessId): Promise<void> {
    this.#announce = `Resuming ${id}`;
    try {
      const state = await this.#client.call("thread.resume", {
        id,
        harness,
        settings: { ...this.#settings, resume: null },
      });
      this.#show(state);
    } catch (error) {
      this.#notice("error", `Could not resume ${id}: ${errorMessage(error)}`);
      // With nothing to show, start somewhere to type.
      if (!this.#current) await this.#open(harness, { ...this.#settings, resume: null }, false);
    } finally {
      this.#announce = null;
    }
  }

  /**
   * Moves the thread on screen to another harness, carrying its context over.
   * With no thread running, starts one on that harness instead. The host says
   * in the thread how it went.
   */
  async #switchHarness(harness: HarnessId, fresh: boolean): Promise<void> {
    const current = this.#live;
    if (!current) {
      // Models and efforts are harness-specific, so the new thread uses its defaults.
      await this.#open(harness, { ...this.#settings, resume: null, model: null, effort: null });
      return;
    }
    try {
      await this.#client.call("thread.switchHarness", { threadId: current.id, harness, fresh });
    } catch (error) {
      // The host notes in the thread why a switch failed, unless there was no thread to note it in.
      if (error instanceof RpcError) this.#notice("error", errorMessage(error));
    }
  }

  /** Shows a thread, picking one from the tree of threads when no ID is given. */
  /**
   * Shows a thread by its ID, or picks one: the open ones as a tree, recent
   * and archived ones from the host's records, or, given words, the threads
   * whose titles or transcripts match them.
   */
  async #switchThread(args: string): Promise<void> {
    const words = args.trim();
    const named = /^t\d+$/.test(words) ? words : null;
    if (named) {
      const open = this.#client.threads.get(named);
      if (open && open.status !== "closed") this.#show(open);
      else if (named !== this.#currentId) await this.#resume(named, this.#harness);
      return;
    }
    const choices: { id: string; open: boolean }[] = [];
    const entries: MenuEntry[] = [];
    const add = (id: string, open: boolean, made: MenuEntry) => {
      choices.push({ id, open });
      entries.push(made);
    };
    if (words) {
      const found = await this.#client.call("threads.search", { query: words });
      const titled = await this.#client.call("threads.list", { scope: "recent", query: words });
      const ids = new Set<string>();
      for (const { thread, snippet } of found) {
        ids.add(thread.id);
        add(
          thread.id,
          false,
          entry(thread.title || thread.id, oneLine(snippet), { tag: thread.id }),
        );
      }
      for (const thread of titled)
        if (!ids.has(thread.id))
          add(
            thread.id,
            false,
            entry(thread.title || thread.id, `${thread.harness} · ${thread.status}`, {
              tag: thread.id,
            }),
          );
      if (entries.length === 0) {
        this.#notice("info", `No thread mentions ${words}.`);
        return;
      }
      const index = await this.#pick(`Threads matching ${words}`, entries, 0, true);
      const chosen = index === null ? undefined : choices[index];
      if (chosen) await this.#resume(chosen.id, this.#harness);
      return;
    }
    const open = this.#threadOrder().filter(
      (thread) => thread.status !== "closed" && !thread.archived,
    );
    const prefixes = treePrefixes(open);
    open.forEach((thread, row) =>
      add(
        thread.id,
        true,
        entry(
          `${prefixes[row] ?? ""}${thread.title || thread.id}`,
          `${harnessLabel(thread)} · ${agentStatus(thread)}`,
          { tag: this.#marker(thread), group: "Open" },
        ),
      ),
    );
    const [recent, archived] = await Promise.all([
      this.#client.call("threads.list", { scope: "recent", limit: 100 }).catch(() => []),
      this.#client.call("threads.list", { scope: "archived", limit: 100 }).catch(() => []),
    ]);
    const shown = new Set(open.map((thread) => thread.id));
    const cwd = this.#cwd();
    for (const thread of recent)
      if (!shown.has(thread.id) && thread.parentId === null)
        add(
          thread.id,
          false,
          entry(
            thread.title || thread.id,
            `${thread.id} · ${thread.harness} · ${thread.status}${thread.cwd === cwd ? "" : ` · ${thread.cwd}`}`,
            {
              tag: thread.pinned ? "pinned" : thread.unseen ? "new" : day(thread.updatedAt),
              group: "Recent",
            },
          ),
        );
    for (const thread of archived)
      add(
        thread.id,
        false,
        entry(thread.title || thread.id, `${thread.id} · ${thread.harness}`, {
          tag: day(thread.updatedAt),
          group: "Archived",
        }),
      );
    const index = await this.#pick(
      "Threads",
      entries,
      Math.max(
        0,
        choices.findIndex((choice) => choice.id === this.#currentId),
      ),
      true,
      { tabs: true },
    );
    const chosen = index === null ? undefined : choices[index];
    if (!chosen || chosen.id === this.#currentId) return;
    const target = this.#client.threads.get(chosen.id);
    if (chosen.open && target) this.#show(target);
    else await this.#resume(chosen.id, this.#harness);
  }

  /** What the thread list marks a thread with: what needs the user, what is new, or where it is. */
  #marker(thread: ThreadState): string {
    if (thread.id === this.#currentId) return "current";
    if (thread.status === "waiting") return "needs you";
    const finished = thread.lastRun && thread.lastRun.status !== "running";
    if (finished && thread.runCount > Math.max(thread.seenRuns, this.#seenRuns.get(thread.id) ?? 0))
      return "new";
    if (thread.pinned) return "pinned";
    return thread.status === "parked" ? "parked" : thread.id;
  }

  #show(thread: ThreadState): void {
    const changed = this.#currentId !== thread.id;
    this.#currentId = thread.id;
    this.#own.add(thread.id);
    if (changed) void this.#client.call("client.show", { threadId: thread.id }).catch(() => {});
    if (!this.#views.has(thread.id)) void this.#load(thread.id);
    // Opening a thread shows what it finished.
    this.#statusChanged();
    // A prompt belongs to the thread it asks for; it comes back with that thread.
    if (this.#prompt && this.#prompt.asking.threadId !== thread.id) this.#prompt = null;
    this.#nextRequest();
    // /new and /harness start from the thread on screen.
    const info = thread.info;
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
    this.#completions.clear();
    this.#nativeCommands = [];
    void this.#loadCommands();
    void this.#refreshHostCommands();
    this.#schedule();
  }

  /** The view for a thread the terminal sees from its start; the first takes over the startup one. */
  #newView(id: string): ThreadView {
    const view = this.#homeTaken ? new ThreadView(id) : this.#home;
    this.#homeTaken = true;
    this.#views.set(id, view);
    return view;
  }

  /**
   * Builds the view of a thread the terminal did not see start, from the
   * host's log of it, then follows it live.
   */
  async #load(id: string): Promise<void> {
    if (this.#loading.has(id)) return;
    this.#loading.set(id, []);
    try {
      const page = await this.#client.call("thread.attach", { threadId: id, limit: PAGE_ENTRIES });
      const children = new Map(page.children.map((child) => [child.id, child]));
      const live = (this.#loading.get(id) ?? []).filter((logged) => logged.seq > page.cursor);
      const paged: Paged = {
        entries: [...page.entries, ...live],
        oldest: page.entries[0]?.seq ?? null,
        more: page.more,
        children,
      };
      if (paged.more) this.#paged.set(id, paged);
      const view = this.#views.get(id) ?? this.#newView(id);
      this.#replay(view, paged);
    } catch (error) {
      this.#notice("error", `Could not load ${id}: ${errorMessage(error)}`);
    } finally {
      this.#loading.delete(id);
      this.#schedule();
    }
  }

  /** Shows a thread's loaded entries in its view, oldest first. */
  #replay(view: ThreadView, paged: Paged): void {
    if (paged.more) view.notice("info", "Earlier turns are above; scroll up to load them.");
    const context: ViewContext = {
      busy: false,
      agent: (childId) => {
        const child = this.#client.threads.get(childId) ?? paged.children.get(childId);
        return child ? agentRowOf(child) : null;
      },
    };
    for (const logged of paged.entries) view.apply(logged.entry, context);
  }

  /**
   * Loads the page of a thread's log before what its view shows, and shows
   * the view again from there, keeping the rows on screen where they were.
   */
  async #loadEarlier(id: string): Promise<void> {
    const paged = this.#paged.get(id);
    if (!paged?.more || paged.oldest === null || this.#loading.has(id)) return;
    this.#loading.set(id, []);
    try {
      const page = await this.#client.call("thread.attach", {
        threadId: id,
        limit: PAGE_ENTRIES,
        before: paged.oldest,
      });
      for (const child of page.children) paged.children.set(child.id, child);
      paged.entries = [...page.entries, ...paged.entries, ...(this.#loading.get(id) ?? [])];
      paged.oldest = page.entries[0]?.seq ?? paged.oldest;
      paged.more = page.more;
      if (!paged.more) this.#paged.delete(id);
      const old = this.#views.get(id);
      const view = new ThreadView(id);
      this.#replay(view, paged);
      if (old) {
        const rows = (current: ThreadView) =>
          current.transcript.view(
            { width: this.#screen.columns, cwd: this.#cwd(), blink: true, now: Date.now() },
            0,
            0,
          ).total;
        // The same rows stay on screen; the earlier ones are above them.
        view.scroll = old.scroll + Math.max(0, rows(view) - rows(old));
        view.turn = old.turn;
      }
      this.#views.set(id, view);
    } catch (error) {
      this.#notice("error", `Could not load earlier turns: ${errorMessage(error)}`);
    } finally {
      this.#loading.delete(id);
      this.#schedule();
    }
  }

  #viewContext(threadId: string): ViewContext {
    return {
      busy: this.#client.threads.get(threadId)?.busy ?? false,
      agent: (childId) => {
        const child = this.#client.threads.get(childId);
        return child ? agentRowOf(child) : null;
      },
    };
  }

  /** Threads with each one's children right after it. */
  #threadOrder(): ThreadState[] {
    const all = [...this.#client.threads.values()];
    const under = (parentId: string | null): ThreadState[] =>
      all
        .filter((thread) => thread.parentId === parentId)
        .flatMap((thread) => [thread, ...under(thread.id)]);
    return under(null);
  }

  /** Fetches the harness's own commands for completion and /help. */
  async #loadCommands(): Promise<void> {
    const thread = this.#live;
    // A parked thread's harness is not running; its commands load once it wakes.
    if (!thread || thread.status === "parked" || !thread.methods.includes("listCommands")) return;
    const version = thread.commandsVersion;
    try {
      const commands = ((await this.#callSession(thread.id, "listCommands", [])) ??
        []) as NativeCommand[];
      // A switch keeps the thread but not the session, whose commands no longer apply.
      const now = this.#current;
      if (now?.id !== thread.id || now.commandsVersion !== version) return;
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

  /** Lists the host's commands again, for the thread on screen. */
  async #refreshHostCommands(): Promise<void> {
    const threadId = this.#currentId;
    try {
      const commands = await this.#client.call("commands.list", { threadId });
      if (this.#currentId !== threadId) return;
      this.#registerHostCommands(commands);
      this.#syncSlash();
      this.#schedule();
    } catch {
      // The commands already registered stay.
    }
  }

  /** Registers the host's commands, which run there, beside the terminal's own. */
  #registerHostCommands(commands: CommandInfo[]): void {
    for (const undo of this.#hostCommands) undo();
    this.#hostCommands = [];
    const builtin = new Set(
      [...BUILTIN_COMMANDS, ...this.#clientCommands()].flatMap((command) => [
        command.name,
        ...(command.aliases ?? []),
      ]),
    );
    for (const info of commands) {
      // 1harness's own commands keep their names.
      if (builtin.has(info.name)) continue;
      const definition: CommandDefinition = {
        name: info.name,
        aliases: info.aliases,
        ...(info.usage ? { usage: info.usage } : {}),
        description: info.description,
        group: info.group,
        available: () => info.available,
        ...(info.completes
          ? {
              complete: (_context: CommandContext, args: string) =>
                this.#hostCompletion(info.name, args),
            }
          : {}),
        run: async (_context, args) => {
          await this.#client.call("commands.run", {
            threadId: this.#currentId,
            name: info.name,
            args,
          });
          // A command may change what is available, such as by trusting a folder.
          void this.#refreshHostCommands();
        },
      };
      this.#hostCommands.push(this.#commands.register(definition));
    }
  }

  /** Completions for a host command's arguments: fetched once, then shown when they arrive. */
  #hostCompletion(name: string, args: string): Completions | null {
    const key = `${name}\0${args}`;
    const cached = this.#completions.get(key);
    if (cached !== undefined && !(cached instanceof Promise)) return cached;
    if (cached === undefined) {
      const threadId = this.#currentId;
      const loading = this.#client.call("commands.complete", { threadId, name, args }).then(
        (found) => {
          if (this.#completions.get(key) !== loading) return;
          this.#completions.set(key, found);
          this.#syncCompletion();
          this.#schedule();
        },
        () => {
          this.#completions.set(key, null);
        },
      );
      this.#completions.set(key, loading);
    }
    return null;
  }

  async #exit(): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    const current = this.#current;
    const harness = this.#harness;
    this.#prompt = null;
    this.#requests = [];
    // Leaving detaches from the host; a server keeps the threads working.
    await this.#client.close().catch(() => {});
    for (const timer of [this.#blinkTimer, this.#frame, this.#sequenceTimer, this.#statusTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#programStatus?.clear();
    this.#screen.leave();
    if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
    this.#in.setRawMode(false);
    this.#in.pause();
    if (current && current.runCount > 0) {
      const hint = this.#stored
        ? `1harness --resume ${current.id}`
        : current.info.threadId
          ? `1harness --harness ${harness} --resume ${current.info.threadId}`
          : null;
      if (hint) process.stdout.write(style.muted(`Resume with: ${hint}\n`));
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

  // Host events

  #hostEvent(event: ClientEvent): void {
    if (this.#exiting) return;
    switch (event.type) {
      case "thread":
        this.#threadState(event.thread);
        this.#statusChanged();
        break;
      case "removed": {
        this.#views.delete(event.threadId);
        this.#paged.delete(event.threadId);
        this.#dropRequests(event.threadId);
        this.#own.delete(event.threadId);
        if (this.#currentId === event.threadId) this.#currentId = null;
        this.#statusChanged();
        break;
      }
      case "entry": {
        const loading = this.#loading.get(event.threadId);
        if (loading) {
          loading.push({ seq: event.seq, entry: event.entry });
          break;
        }
        // A paged view keeps what it shows, to show it again with earlier pages.
        this.#paged.get(event.threadId)?.entries.push({ seq: event.seq, entry: event.entry });
        this.#views.get(event.threadId)?.apply(event.entry, this.#viewContext(event.threadId));
        break;
      }
      case "notice":
        this.#notice(event.level, event.text);
        break;
      case "ui":
        this.#ui(event.request);
        break;
      case "ui.done":
        if (this.#panel?.kind === "menu" && this.#panel.pick === event.id) this.#panel = null;
        break;
      case "commands":
        void this.#refreshHostCommands();
        break;
      case "harnesses":
        break;
      case "resync":
        this.#resynced();
        break;
      case "connection":
        this.#notice(
          event.state === "connected" ? "info" : "warning",
          event.state === "connected"
            ? "Reconnected to 1harness."
            : `Lost the connection to 1harness${event.error ? ` (${event.error})` : ""}; reconnecting…`,
        );
        break;
    }
    this.#schedule();
  }

  /** Applies a thread's new state: its view, requests, and the commands it offers. */
  #threadState(thread: ThreadState): void {
    const first = !this.#known.has(thread.id);
    this.#known.add(thread.id);
    if (first) {
      // Seen from its start, its view fills in live.
      const view = this.#newView(thread.id);
      // Threads this terminal opens are shown; agents' run in the background.
      if (thread.openedBy === this.#client.id) {
        this.#show(thread);
        if (this.#announce) view.notice("info", this.#announce);
      }
    }
    if (thread.parentId) this.#childRow(thread);
    this.#syncRequests(thread);
    if (thread.status === "closed") {
      // For a harness that closes without saying so; otherwise already done.
      const view = this.#views.get(thread.id);
      view?.endTurn(null, null);
      view?.settle();
    }
    if (thread.id !== this.#currentId) return;
    this.#settings = {
      ...this.#settings,
      model: thread.info.model,
      effort: thread.info.effort,
      runtimeMode: thread.info.runtimeMode,
      interactionMode: thread.info.interactionMode,
    };
    if (this.#harness !== thread.harness) {
      // Another harness: its models, commands, and settings replace the old one's.
      this.#show(thread);
      return;
    }
    if (thread.commandsVersion !== this.#commandsSeen) {
      this.#commandsSeen = thread.commandsVersion;
      this.#lookups.clear();
      void this.#loadCommands();
    }
  }

  /** The commands version of the thread on screen whose commands were last loaded. */
  #commandsSeen = -1;

  /** The host caught the terminal up after it missed events; every view is built again. */
  #resynced(): void {
    const current = this.#currentId;
    this.#views.clear();
    this.#paged.clear();
    this.#homeTaken = true;
    this.#requests = [];
    this.#prompt = null;
    for (const thread of this.#client.threads.values()) {
      this.#known.add(thread.id);
      this.#syncRequests(thread);
    }
    const shown = current ? this.#client.threads.get(current) : undefined;
    if (shown) void this.#load(shown.id);
    else this.#currentId = null;
    this.#nextRequest();
  }

  /** Keeps the list of open requests in step with a thread's. */
  #syncRequests(thread: ThreadState): void {
    const open = new Set(thread.requests.map((request) => request.id));
    this.#requests = this.#requests.filter(
      (request) => request.threadId !== thread.id || open.has(request.request.id),
    );
    for (const request of thread.requests)
      if (!this.#requests.some((other) => sameRequest(other, thread.id, request.id)))
        this.#requests.push({ threadId: thread.id, request });
    const asking = this.#prompt?.asking;
    if (asking && asking.threadId === thread.id && !open.has(asking.request.id))
      this.#prompt = null;
    this.#nextRequest();
  }

  /** Forgets a thread's requests, closing its prompt if one is open. */
  #dropRequests(threadId: string): void {
    this.#requests = this.#requests.filter((open) => open.threadId !== threadId);
    if (this.#prompt?.asking.threadId === threadId) {
      this.#prompt = null;
      this.#nextRequest();
    }
  }

  /** Updates the row in a parent's transcript for a thread it started. */
  #childRow(child: ThreadState): void {
    const view = child.parentId ? this.#views.get(child.parentId) : undefined;
    // The parent's log places the row; until then there is nothing to update.
    if (view?.hasAgent(child.id)) view.agent(agentRowOf(child));
  }

  /** Something the host shows or asks through this terminal, for a command it runs. */
  #ui(request: UiRequest): void {
    switch (request.method) {
      case "notify":
        this.#notice(request.level, request.text);
        return;
      case "report":
        this.#report(request.report);
        return;
      case "panel":
        this.#panel = { kind: "info", title: request.title, rows: request.rows };
        return;
      case "pick": {
        void this.#pick(
          request.title,
          request.entries.map(pickEntry),
          request.initial,
          request.filter,
          { pick: request.id, tabs: request.tabs },
        ).then((index) =>
          this.#client.call("ui.reply", { id: request.id, result: index }).catch(() => {}),
        );
        return;
      }
      case "progress":
        this.#progress.set(request.id, this.#context.ui.progress(request.text));
        return;
      case "settle":
        this.#progress.get(request.progress)?.(request.level, request.text);
        this.#progress.delete(request.progress);
        return;
      case "setInput":
        this.#editor.set(request.text);
        return;
      case "show": {
        const thread = this.#client.threads.get(request.threadId);
        if (thread) this.#show(thread);
        return;
      }
      case "exit":
        void this.#exit();
        return;
    }
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
    const respond = (response: RequestResponse) => this.#respond(next, response);
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

  #respond(asked: OpenRequest, response: RequestResponse): void {
    const { threadId, request } = asked;
    this.#requests = this.#requests.filter((open) => !sameRequest(open, threadId, request.id));
    this.#client
      .call("thread.respond", { threadId, requestId: request.id, response })
      .catch((error: unknown) => this.#notice("error", errorMessage(error)));
    this.#nextRequest();
  }

  /** `pick` is the host's request the menu answers, when it asked; `tabs` groups entries in tabs. */
  #pick(
    title: string,
    entries: MenuEntry[],
    initial = 0,
    filter = false,
    options: { pick?: string; tabs?: boolean } = {},
  ): Promise<number | null> {
    return new Promise((resolve) => {
      if (entries.length === 0) {
        resolve(null);
        return;
      }
      this.#panel = {
        kind: "menu",
        menu: new Menu({
          title,
          entries,
          initial,
          filter,
          ...(options.tabs ? { tabs: true } : {}),
        }),
        onDone: resolve,
        ...(options.pick ? { pick: options.pick } : {}),
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
      const thread = asking ? this.#client.threads.get(asking.threadId) : undefined;
      if (thread) this.#show(thread);
      return;
    }
    // Without a parent, alt+↑ is up.
    const parent = this.#client.threads.get(this.#current?.parentId ?? "");
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
    const thread = this.#currentId;
    const loading = load().then(
      (items) => {
        if (thread !== this.#currentId || this.#lookups.get(key) !== loading) return items;
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
    const matches = token && this.#mentionDismissed === null ? this.#searchFiles(token.query) : [];
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

  /**
   * Files matching an `@` mention, which the host searches where the thread
   * runs. The first call for a query asks; the menu fills in when it answers,
   * and again while the host is still indexing the folder.
   */
  #searchFiles(query: string): FileMatch[] {
    const cwd = this.#cwd();
    const key = `${cwd}\0${query}`;
    const cached = this.#fileResults.get(key);
    if (Array.isArray(cached)) return cached;
    if (cached === undefined) {
      if (this.#fileResults.size > 200) this.#fileResults.clear();
      const asking = this.#client.call("files.search", { cwd, query, limit: MENTION_LIMIT }).then(
        ({ matches, loading }) => {
          if (this.#fileResults.get(key) !== asking) return;
          this.#fileResults.set(key, matches);
          // Results fill in as the host's first scan goes on.
          if (loading)
            setTimeout(() => {
              if (this.#fileResults.get(key) === matches) this.#fileResults.delete(key);
              this.#syncMention();
              this.#schedule();
            }, FILES_RETRY_MS).unref();
          this.#syncMention();
          this.#schedule();
        },
        (error: unknown) => {
          this.#fileResults.set(key, []);
          this.#notice("warning", `File completion is unavailable: ${errorMessage(error)}`);
        },
      );
      this.#fileResults.set(key, asking);
    }
    return [];
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
      else if (this.#live?.busy) void this.#stop();
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
        else if (this.#live?.busy && this.#editor.text.trim() !== "") {
          this.#view.scroll = 0;
          this.#send(this.#editor.take(), false);
        }
        return;
      case "escape":
        if (this.#live?.busy) void this.#stop();
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
    const view = this.#view;
    view.scroll = Math.max(0, view.scroll + rows);
    // At the top of what is loaded, the page before it loads.
    if (rows > 0 && this.#currentId && view.scroll >= view.total - this.#screen.rows)
      void this.#loadEarlier(this.#currentId);
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

  /** Sends a message; while a turn runs it joins the turn, or queues when `steer` is false. */
  #send(text: string, steer = true): void {
    const thread = this.#live;
    if (!thread) {
      this.#notice("error", "No session is running. Use /new to start one.");
      return;
    }
    // The host finds `@` mentioned images where the thread runs.
    this.#client
      .call("thread.send", {
        threadId: thread.id,
        text,
        steer: steer && thread.busy,
        // A send retried after a dropped connection is sent once.
        requestId: randomUUID(),
      })
      .catch((error: unknown) => this.#notice("error", errorMessage(error)));
  }

  /** Stops the turn on screen and every agent under it. */
  async #stop(): Promise<void> {
    const id = this.#currentId;
    if (!id) return;
    try {
      await this.#client.call("thread.stop", { threadId: id });
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
      const thread = this.#live;
      if (native || thread?.capabilities.nativeSlashCommands) {
        // The harness runs its own commands and skills, such as Claude's /context or Codex's /review.
        if (!thread) throw new Error("No session is running.");
        // One the harness did not list goes as a message; the harness says if it has none.
        if (native)
          await this.#client.call("thread.command", {
            threadId: thread.id,
            command: native,
            args: arg.trim(),
          });
        else await this.#client.call("thread.send", { threadId: thread.id, text, command: true });
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
    const limits = this.#current?.usage?.limits ?? [];
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
    const usage = this.#current?.usage;
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
    const queue = this.#current?.queue ?? [];
    // A queue held after a restart waits for the user's next message.
    const held = this.#current?.held === true;
    for (const queued of queue)
      rows.push(
        truncate(
          style.muted(`  ↳ ${held ? "held" : "queued"}: ${oneLine(queuedText(queued))}`),
          width,
        ),
      );
    if (held && queue.length > 0)
      rows.push(style.muted("    your next message runs these first · /unqueue takes one back"));
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
    const thread = first ? this.#client.threads.get(first.threadId) : undefined;
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
    const hint = this.#current?.capabilities.steer
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
    const threads = [...this.#client.threads.values()].filter(
      (thread) => thread.status !== "closed",
    );
    if (threads.length > 1 && this.#currentId) parts.push(this.#currentId);
    const others = threads.filter(
      (thread) =>
        thread.id !== this.#currentId && thread.status !== "idle" && thread.status !== "parked",
    ).length;
    if (others > 0) parts.push(`${others} other ${others === 1 ? "thread" : "threads"} working`);
    // Subscription limits appear once they need attention.
    for (const limit of this.#current?.usage?.limits ?? []) {
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
