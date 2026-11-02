import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { BUILTIN_COMMANDS } from "../commands/builtins.ts";
import {
  CommandRegistry,
  completion,
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
  ModelOption,
  NativeCommand,
  RateLimit,
  RequestResponse,
  SessionInfo,
  SessionOptions,
} from "../core/events.ts";
import type { FileMatch } from "../core/files.ts";
import { appendDelta, errorMessage } from "../core/thread.ts";
import type { ClientEvent, HostClient } from "../client/client.ts";
import {
  RpcError,
  SESSION_CALLS,
  type CommandInfo,
  type HelloResult,
  type LiveFrame,
  type LogEntry,
  type PageEvent,
  type ThreadListing,
  type ThreadState,
  type UiRequest,
} from "../protocol.ts";
import { agentRowOf, agentStatus, harnessLabel, isLive, statusDot } from "./agents.ts";
import { Editor, applyEditingKey } from "./editor.ts";
import { InputDecoder, type InputEvent, type Key } from "./input.ts";
import { Menu, entry, infoPanel, lineStep, type MenuEntry } from "./menu.ts";
import { listedEntry, ResumeView, type ResumeEntry } from "./resume.ts";
import {
  ChoicePrompt,
  QuestionPrompt,
  type ChoiceConfig,
  type ChoiceResult,
  type QuestionsResult,
} from "./prompt.ts";
import { Screen, type CursorPosition } from "./screen.ts";
import {
  STATUS_QUERY,
  StatusReporter,
  statusRecords,
  threadStatusInput,
  type ThreadStatusInput,
} from "./program-status.ts";
import { isLightTheme, setLightTheme, style } from "./theme.ts";
import { spread, truncate, visibleWidth, wrap } from "./text.ts";
import { IMAGE_INDENT, formatTokens, type Hit, type Target } from "./transcript.ts";
import {
  ordered,
  pageKey,
  paintSelection,
  selectedText,
  viewerFrame,
  wordAt,
  type Point,
  type Selection,
} from "./pointer.ts";
import { runsScripts } from "../host/media.ts";
import { FIGURE_NAMES, Figures, type Figure } from "./figures.ts";
import {
  CELL_QUERY,
  DEFAULT_CELL,
  GRAPHICS_QUERY,
  PLACEHOLDER_LIMIT,
  fit,
  maxImageRows,
  picture,
  placeholderRow,
  pngSize,
  type CellSize,
  type MediaContext,
  type Picture,
  type Shown,
} from "./images.ts";
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
  /** The server the terminal works through, for /status and what quitting says. */
  server?: ServerInfo;
  /**
   * The servers /connect offers, by name, where the terminal can move to
   * another; `check` resolves once the named one answers, or throws why not.
   */
  connect?: { hosts: () => Record<string, string>; check: (spec: string) => Promise<void> };
}

/** A picture shown on the whole screen: what was clicked, and the picture drawn for the screen. */
interface Viewer {
  target: Extract<Target, { kind: "picture" }>;
  picture: Picture;
  /** A page running live, which takes the mouse and keys while open. */
  live?: LivePage;
  /** Where the picture was last drawn, to put the mouse on the page. */
  layout?: { left: number; top: number; columns: number; rows: number; scroll: number };
  /** The first of its rows on screen, for one taller than the screen. */
  scroll: number;
  /** When it opened, so the click that opened it does not close it. */
  opened: number;
}

/** A page kept running on the host, as the transcript and the viewer show it. */
interface LivePage {
  html: string;
  /** The host's ID for it, once it is open. */
  id: string | null;
  /** Its latest frame; new frames change this picture, so rows showing it stay. */
  picture: Picture | null;
  /** Its viewport in CSS pixels now, and as the transcript shows it, at its density there. */
  css: { width: number; height: number };
  inline: { width: number; height: number; scale: number };
  /** A request is out for it. */
  busy: boolean;
  /** It could not run; it is drawn once instead, or as text. */
  failed: boolean;
  /** When a frame last showed it. */
  seen: number;
}

/** Where the terminal's host runs. */
export interface ServerInfo {
  /** `local`, or the server's name or address, as -S gave it. */
  label: string;
  /** On this machine. */
  local: boolean;
  /** In this process, so threads stop working when 1harness exits. */
  inProcess: boolean;
  /** Who the server takes this terminal to be, where its listener tells. */
  identity: string | null;
  /** Its socket path or URL. */
  address: string;
  pid: number | null;
}

/**
 * The order the command menu and /help list 1harness's commands in, a group
 * at a time: Threads, Model, Permissions, Tools, General; others follow.
 */
const COMMAND_ORDER = [
  "new",
  "resume",
  "rename",
  "fork",
  "compact",
  "unqueue",
  "close",
  "model",
  "effort",
  "harness",
  "mode",
  "plan",
  "mcp",
  "extensions",
  "help",
  "status",
  "copy",
  "connect",
];
/** Listed last, after commands the harness and extensions add. */
const LAST_COMMANDS = ["quit"];
/** Where a command goes in menus: by COMMAND_ORDER, then unlisted ones, then LAST_COMMANDS. */
function commandRank(command: CommandDefinition): number {
  const at = COMMAND_ORDER.indexOf(command.name);
  if (at !== -1) return at;
  return LAST_COMMANDS.includes(command.name) ? COMMAND_ORDER.length + 1 : COMMAND_ORDER.length;
}

/** An argument hint longer than this goes with the description rather than the name. */
const HINT_LIMIT = 16;

const KEYS: [string, string][] = [
  ["enter", "send; while working, add to the running turn"],
  ["tab", "while working, queue as the next turn"],
  ["alt+enter, ctrl+j", "new line"],
  ["shift+tab", "toggle plan mode"],
  ["ctrl+t", "switch threads"],
  ["ctrl+o", "open the agent that needs you"],
  ["ctrl+x", "show tool calls whole: commands, output, diffs; in a prompt, all of it"],
  ["alt+↑", "go to the thread that started this one"],
  ["@", "mention a file or folder"],
  ["ctrl+j, ctrl+k", "move in any list, completions included"],
  ["j k, g G, ctrl+d ctrl+u", "move in lists that take no typing"],
  ["h l, q", "switch tabs and close in those lists"],
  ["esc", "stop the running turn and the agents under it"],
  ["pgup, pgdn, wheel", "scroll the conversation"],
  ["ctrl+c", "clear input, interrupt, or exit"],
  ["ctrl+z", "suspend"],
  ["drag", "select text and copy it; double-click a word, triple-click a row"],
  ["click code", "copy the code block"],
  [
    "click a picture",
    "show it whole and sharp: a diagram, an equation, a page, an image; c copies its source",
  ],
  ["click a live page", "it takes the click; its caption opens it whole, where it takes keys too"],
  ["click a list's row", "choose it"],
  ["click a tool call", "show tool calls whole, or in brief again, as ctrl+x does"],
  ["shift+drag", "the terminal's own selection, in most terminals"],
];

const FRAME_MS = 16;
/** How long a word in the status line, such as what was copied, stays. */
const TOAST_MS = 2500;
/** The most time between clicks that make a double or triple one. */
const CLICK_MS = 400;
/** How often a live page on screen is asked for a new frame. */
const LIVE_MS = 150;
/** A live page out of sight this long is closed, and opened afresh when seen again. */
const LIVE_IDLE_MS = 120_000;
/**
 * The most pixels a live page's frame may have, and the most bytes of frames
 * sent each second: the terminal decodes and keeps every frame, so a page
 * that runs away must not take the terminal with it.
 */
const LIVE_MAX_PIXELS = 6_000_000;
const LIVE_BYTES_PER_SECOND = 2_000_000;
/** How long a new prompt ignores keys, which were likely typed for what it covered. */
const PROMPT_GRACE_MS = 400;
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
  /** Entries without streamed chunks, which their items hold. */
  entries: { seq: number; entry: LogEntry }[];
  /** Where each item's latest entry is in `entries`, for chunks to go into. */
  items: Map<string, number>;
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
/**
 * Keeps an entry for building a view again: a streamed chunk goes into the
 * entry of the item it streams into, so the item's text stays whole.
 */
function keep(paged: Paged, logged: { seq: number; entry: LogEntry }): void {
  const given = logged.entry;
  if (given.type === "delta") {
    const at = paged.items.get(given.itemId);
    const kept = at === undefined ? undefined : paged.entries[at];
    if (kept?.entry.type === "item")
      kept.entry = { ...kept.entry, item: appendDelta(kept.entry.item, given.chunk) };
    return;
  }
  paged.entries.push(logged);
  if (given.type === "item") paged.items.set(given.item.id, paged.entries.length - 1);
}

/** The widest the column gets, in columns; ONEHARNESS_COLUMN sets another. */
const COLUMN_WIDTH = 100;

function columnWidth(): number {
  const set = Number(process.env["ONEHARNESS_COLUMN"]);
  return Number.isInteger(set) && set >= 40 ? set : COLUMN_WIDTH;
}

/** How many log entries a thread's view loads at a time. */
const PAGE_ENTRIES = 400;
/** The line over a view whose earlier turns are not loaded yet. */
const EARLIER_ABOVE = "Earlier turns are above; scroll up to load them.";

/** `$0.16`, or `<$0.01` for less. */
function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function describeLimit(limit: RateLimit): string {
  const used = limit.usedPercent === null ? limit.status : `${Math.round(limit.usedPercent)}% used`;
  const resets =
    limit.resetsAt === null ? "" : ` · resets ${new Date(limit.resetsAt).toLocaleString()}`;
  return `${limit.label}: ${used}${resets}`;
}

/** When a thread last did something: its latest run, or its start. */
function lastActive(thread: ThreadState): number {
  return thread.lastRun?.endedAt ?? thread.lastRun?.startedAt ?? thread.createdAt;
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
  /** The host's run the terminal last caught up with, to tell when it restarted. */
  #instance: string | null = null;
  #server: ServerInfo;
  #connect: AppOptions["connect"];
  /** The server /connect moves to once the terminal exits; "" for this machine's. */
  #next: string | undefined = undefined;
  /** Whether tool calls show whole, with their output and diffs. */
  #details = false;
  /** Whether the terminal shows images, which it says when asked. */
  #graphics = false;
  /** A character cell's size in pixels, which images are sized by. */
  #cell: CellSize = DEFAULT_CELL;
  /** Pictures of image files, by path, as the host sent them. */
  #images = new Map<string, Picture | null | "loading">();
  /** What the last frame's transcript rows do when clicked, by screen row; `#top` is the first one's place. */
  #targets: (Hit | null)[] = [];
  /** Whether the host runs pages live, scripts and all. */
  #liveHost = false;
  /** Live pages, by page, width, theme, and cells, and by the picture showing each. */
  #livePages = new Map<string, LivePage>();
  #liveByPicture = new Map<number, LivePage>();
  /** The live pages the last frame showed: on screen, and kept moving until a frame does not show them. */
  #liveShown = new Set<LivePage>();
  #liveTimer: NodeJS.Timeout | null = null;
  /** Bytes of live frames sent in the current second, and when that second began. */
  #liveBudget = { since: 0, bytes: 0 };
  #top = 0;
  /** The last frame's transcript rows as rendered, for picking a word out of one. */
  #shownRows: string[] = [];
  /** The list the last frame showed, and the screen row its rows start on, so a click can choose. */
  #listAt: { menu: Menu; row: number } | null = null;
  /** Text selected, or being selected, with the mouse, in the transcript's rows. */
  #selection: Selection | null = null;
  /** Where the left button went down, to tell a click from a drag; the last clicks, for double ones. */
  #press: { row: number; column: number; dragged: boolean; anchor: Point | null } | null = null;
  #clicks = { at: 0, row: -1, column: -1, count: 0 };
  /** A word in the status line for a moment, such as what was copied. */
  #toast: { text: string; until: number } | null = null;
  /** A picture on the whole screen, opened by a click on it, drawn sharper once it can be. */
  #viewer: Viewer | null = null;
  /** Pages drawn as pictures, by theme, width, cell size, and content. */
  #pages = new Map<string, Picture | null | "loading">();
  /** Diagrams and equations drawn as pictures; as more can be shown, the views draw again. */
  #figures = new Figures(() => this.#redrawViews());
  /** The default model's ID by thread, for a harness that names it only once a turn runs. */
  #defaultModels = new Map<string, string | null>();

  /** The prompt on screen, and the request it answers; request IDs are only unique per thread. */
  #prompt: { prompt: ChoicePrompt | QuestionPrompt; asking: OpenRequest } | null = null;
  /** Open requests from every thread, oldest first; background ones say whose they are. */
  #requests: OpenRequest[] = [];
  #panel:
    | {
        kind: "menu";
        menu: Menu;
        onDone: (index: number | null) => void;
        /** The host's pick request it answers. */
        pick?: string;
        /** Called instead of `onDone` when another list takes the panel. */
        onReplaced?: () => void;
      }
    | { kind: "info"; title: string; rows: [string, string][] }
    | { kind: "resume"; view: ResumeView; onDone: (id: string | null) => void }
    | null = null;
  /** The host's progress lines, by request. */
  #progress = new Map<string, (level: "info" | "warning" | "error", text: string) => void>();
  #slash: Menu | null = null;
  /** Composer text at which the slash menu was dismissed. */
  #slashDismissed: string | null = null;
  /** Composer text at which the user moved in the slash menu, which keeps their choice. */
  #slashMoved: string | null = null;
  /** Completion for the words after a command, such as `/mcp login NAME`. */
  #args: {
    menu: Menu;
    start: number;
    items: Completion[];
    moved: boolean;
    typed: string;
    required: boolean;
  } | null = null;
  /** Where the word goes that a chosen word needs after it, such as `/mcp show`'s server. */
  #argsRequired: number | null = null;
  #argsDismissed: string | null = null;
  /** Files for `@` mentions, as the host found them, by folder and query. */
  #fileResults = new Map<string, FileMatch[] | Promise<void>>();
  #mention: { menu: Menu; start: number; entries: MenuEntry[]; matches: FileMatch[] } | null = null;
  #mentionDismissed: string | null = null;

  #exitArmed = false;
  #exitTimer: NodeJS.Timeout | null = null;
  #exiting = false;
  /** Undoes what the App hooked into the process, once it exits. */
  #unlisten: (() => void)[] = [];
  /** When the terminal last took a key, of any kind. */
  #typedAt = 0;
  /** Whether typing was going on when the prompt on screen appeared, and goes on still. */
  #strayTyping = false;
  /** The state of the thread last shown, as whatever showed it had it. */
  #shownState: ThreadState | null = null;
  /** Whether the composer's text came from history, so ↑↓ keep walking it. */
  #recalled = false;
  /** Loads of threads' logs in flight, which later callers wait for too. */
  #loads = new Map<string, Promise<void>>();
  /** Threads whose earlier turns are loading. */
  #earlierLoading = new Set<string>();
  /** Counts catch-ups with the host, so a load begun before one is dropped. */
  #generation = 0;
  /** The thread shown when its first state arrived, while an open or resume waited on its reply. */
  #openedId: string | null = null;
  /** Opens and resumes waiting on their replies. */
  #opening = 0;
  /** A view for no thread, once the startup view belongs to one. */
  #nowhere = new ThreadView("none");
  /** Views standing in for shown threads whose logs are not loaded yet. */
  #unloaded = new Map<string, ThreadView>();
  /** The width and detail setting of the last frame, which reflow every row when changed. */
  #layout = "";
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
    this.#server = options.server ?? {
      label: "local",
      local: true,
      inProcess: true,
      identity: null,
      address: "",
      pid: process.pid,
    };
    this.#connect = options.connect;
    this.#client.on((event) => this.#hostEvent(event));
  }

  /** The view on screen: the current thread's, or the startup one. */
  get #view(): ThreadView {
    const shown = this.#currentId ? this.#views.get(this.#currentId) : undefined;
    if (shown) return shown;
    // A thread whose log is not loaded yet shows a view its log fills in once it is,
    // kept apart so a load that failed is tried again when the thread is shown.
    if (this.#currentId) return this.#waiting(this.#currentId);
    return this.#homeTaken ? this.#nowhere : this.#home;
  }

  /**
   * The thread on screen, as the host last said. A reply can come before the
   * event with its state, so until that arrives the reply's state stands in.
   */
  get #current(): ThreadState | undefined {
    if (!this.#currentId) return undefined;
    return (
      this.#client.threads.get(this.#currentId) ??
      (this.#shownState?.id === this.#currentId ? this.#shownState : undefined)
    );
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
          const line = view.say("info", text);
          this.#schedule();
          return (level, outcome) => {
            line.level = level;
            line.text = outcome;
            // Loading earlier turns may have built the view again around the same line.
            for (const shown of new Set([view, this.#home, ...this.#views.values()]))
              shown.transcript.touch(line);
            this.#schedule();
          };
        },
        setInput: (text) => this.#editor.set(text),
        threads: (query) => this.#switchThread(query),
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
        name: "rename",
        usage: "<title>",
        description: "rename this thread",
        group: "Threads",
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
        name: "fork",
        usage: "[turn]",
        description: "start a new thread from this one's turns, through a turn or all of them",
        group: "Threads",
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
          // Shown, unless the user went elsewhere while it was made.
          if (this.#currentId === current.id) this.#show(shown);
        },
      },
      {
        name: "copy",
        usage: "[code]",
        description: "copy the last reply, or its last code block, to the clipboard",
        group: "General",
        run: (_context, args) => {
          const reply = this.#view.transcript.last((block) => block.kind !== "assistant");
          if (reply?.kind !== "assistant") throw new Error("No reply to copy yet");
          let text = reply.text.trim();
          if (args === "code") {
            const blocks = [...text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\s*\1\s*$/gm)];
            const last = blocks.at(-1)?.[2];
            if (last === undefined) throw new Error("The last reply has no code block");
            text = last;
          }
          // OSC 52: the terminal puts it on the clipboard, the one where you sit, over SSH or Rex too.
          process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
          const lines = text.split("\n").length;
          this.#notice(
            "info",
            `Copied ${args === "code" ? "the code block" : "the reply"} (${lines} ${lines === 1 ? "line" : "lines"}).`,
          );
        },
      },
      {
        name: "connect",
        usage: "[host]",
        description: "use 1harness on another machine, named in `1harness hosts`, or this one's",
        group: "General",
        available: () => this.#connect !== undefined,
        complete: () => ({
          start: 0,
          items: [
            completion("local", "this machine"),
            ...Object.entries(this.#connect?.hosts() ?? {}).map(([name, address]) =>
              completion(name, address),
            ),
          ],
        }),
        run: async (_context, args) => this.#connectTo(args),
      },
      {
        name: "close",
        usage: "[id]",
        description: "end a thread and the threads it started",
        group: "Threads",
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

  /**
   * Runs until the user quits; resolves with the server /connect chose to
   * move to, "" for this machine's, or undefined.
   */
  async run(): Promise<string | undefined> {
    this.#in.setRawMode(true);
    this.#in.setEncoding("utf8");
    const onData = (chunk: string) => this.#input(chunk);
    const onResize = () => {
      // A new font size changes the cells' pixels too; pictures are drawn for them.
      this.#measureCells();
      this.#screen.invalidate();
      this.#schedule();
    };
    this.#in.on("data", onData);
    this.#in.resume();
    process.stdout.on("resize", onResize);
    // Taken off on exit, so a terminal /connect starts after this one has the keys alone.
    this.#unlisten.push(
      () => this.#in.off("data", onData),
      () => process.stdout.off("resize", onResize),
    );
    this.#guard();
    this.#captureStderr();
    this.#screen.enter();
    await this.#detectTerminal();

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
      return undefined;
    }
    this.#stored = hello.store !== null;
    this.#liveHost = hello.live === true;
    this.#instance = hello.instance;
    for (const thread of hello.threads) this.#known.add(thread.id);
    for (const warning of hello.warnings)
      this.#notice(warning.startsWith("This folder has") ? "info" : "warning", warning);
    this.#registerHostCommands(hello.commands);
    for (const request of hello.pending) this.#ui(request);
    const held = hello.threads.filter((thread) => thread.held).map((thread) => thread.id);
    if (held.length > 0)
      this.#notice(
        "info",
        `${held.join(", ")} ${held.length === 1 ? "has" : "have"} messages waiting from before 1harness stopped; /resume opens ${held.length === 1 ? "it" : "them"}.`,
      );
    const resume = this.#settings.resume;
    if (resume) await this.#resume(resume, this.#harness);
    else await this.#open(this.#harness, this.#settings, false);
    if (initial.trim() !== "") this.#submit(initial);
    await this.#done;
    return this.#next;
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
    // Images: whether the terminal speaks the Kitty graphics protocol, and its cell size.
    const images = process.env["ONEHARNESS_IMAGES"];
    if (images === "1") this.#graphics = true;
    const query = `${themeSet ? "" : "\x1b]11;?\x1b\\"}${status === "0" || status === "1" ? "" : STATUS_QUERY}${images === "0" ? "" : `${images === "1" ? "" : GRAPHICS_QUERY}${CELL_QUERY}`}`;
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

  /**
   * Asks the terminal for its cells' size in pixels again, where it shows
   * pictures: after a resize, which a new font size is, or on coming back
   * into view, as a pane first drawn hidden gets its real cells only then.
   */
  #measureCells(): void {
    if (this.#graphics && process.env["ONEHARNESS_IMAGES"] !== "0" && !this.#exiting)
      process.stdout.write(CELL_QUERY);
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
    const crashed = (error: Error) => {
      restore();
      process.stderr.write(`1harness: ${error.stack ?? error.message}\n`);
      process.exit(1);
    };
    process.once("exit", restore);
    process.on("uncaughtException", crashed);
    this.#unlisten.push(
      () => process.off("exit", restore),
      () => process.off("uncaughtException", crashed),
    );
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
      const stop = () => {
        void this.#exit().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
      };
      process.once(signal, stop);
      this.#unlisten.push(() => process.off(signal, stop));
    }
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
  async #open(
    harness: HarnessId,
    settings: SessionOptions,
    announce = true,
    fallback = true,
  ): Promise<void> {
    const previous = this.#current;
    const startedOn = this.#currentId;
    const before = { harness: this.#harness, settings: this.#settings };
    this.#openedId = null;
    this.#announce = settings.resume
      ? `Resuming ${harness} thread ${settings.resume}`
      : announce
        ? `New ${harness} thread`
        : null;
    this.#opening++;
    try {
      // The host announces the thread as it starts, which shows it.
      const state = await this.#client.call("thread.open", { harness, settings }).finally(() => {
        this.#opening--;
      });
      if (this.#stayed(startedOn) && this.#currentId !== state.id) this.#show(state);
    } catch (error) {
      this.#harness = before.harness;
      this.#settings = before.settings;
      this.#announce = null;
      // Back where the user was, unless they went elsewhere meanwhile.
      if (this.#stayed(startedOn)) {
        const again = previous ? this.#client.threads.get(previous.id) : undefined;
        if (again && again.status !== "closed") this.#show(again);
        else if (fallback && !this.#live && before.harness !== harness)
          // Nothing to go back to: a thread on the harness that was in use, to type in.
          // The same harness again would only fail again.
          await this.#open(before.harness, { ...before.settings, resume: null }, false, false);
      }
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
    const previous = this.#current;
    const startedOn = this.#currentId;
    this.#announce = `Resuming ${id}`;
    this.#openedId = null;
    this.#opening++;
    try {
      const state = await this.#client
        .call("thread.resume", { id, harness, settings: { ...this.#settings, resume: null } })
        .finally(() => {
          this.#opening--;
        });
      if (this.#stayed(startedOn)) this.#show(state);
    } catch (error) {
      this.#announce = null;
      if (this.#stayed(startedOn)) {
        const again = previous ? this.#client.threads.get(previous.id) : undefined;
        if (again && again.status !== "closed") this.#show(again);
        // With nothing to show, start somewhere to type.
        else if (!this.#live) await this.#open(harness, { ...this.#settings, resume: null }, false);
      }
      this.#notice("error", `Could not resume ${id}: ${errorMessage(error)}`);
    } finally {
      this.#announce = null;
    }
  }

  /**
   * Whether the user is still where an open or resume began: on that thread,
   * on none, or on the new one its first state showed. If they went elsewhere
   * meanwhile, its reply leaves them there.
   */
  #stayed(startedOn: string | null): boolean {
    const here = this.#currentId;
    return here === null || here === startedOn || here === this.#openedId;
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
   * Shows a thread by its ID, or picks one from the thread list, or, given
   * words, from the threads whose titles or transcripts mention them.
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
    // A list open already, such as an extension's question, is answered first.
    if (this.#panel?.kind === "menu") {
      this.#notice("info", "Answer the open list first; then ctrl+t shows the threads.");
      return;
    }
    // The lists take a moment, over a network longer: keys meanwhile go to the picker coming,
    // and esc closes it rather than stopping the turn.
    const loading = this.#loadingPanel("Threads");
    try {
      await this.#pickThread(words, loading);
      if (loading.replaced())
        this.#notice(
          "info",
          "A question came up while the threads loaded; ctrl+t shows them after.",
        );
    } finally {
      loading.clear();
    }
  }

  /**
   * Shows a panel that says a list is loading, until a pick replaces it; says
   * whether the user closed it meanwhile.
   */
  #loadingPanel(title: string): {
    dismissed: () => boolean;
    replaced: () => boolean;
    clear: () => void;
  } {
    let dismissed = false;
    let replaced = false;
    const panel = {
      kind: "menu" as const,
      menu: new Menu({ title, entries: [entry("Loading…", "", { inert: true })], count: false }),
      onDone: () => {
        dismissed = true;
      },
      // Another list taking the panel, such as a host's question, ends the wait too.
      onReplaced: () => {
        dismissed = true;
        replaced = true;
      },
    };
    this.#panel = panel;
    this.#schedule();
    return {
      dismissed: () => dismissed,
      replaced: () => replaced,
      clear: () => {
        if (this.#panel === panel) this.#panel = null;
      },
    };
  }

  /**
   * The thread list: each of your threads by what it is doing, newest first,
   * the agents a thread started under it. With `words`, the threads that
   * mention them.
   */
  async #pickThread(
    words: string,
    loading: { dismissed: () => boolean; clear: () => void },
  ): Promise<void> {
    let entries: ResumeEntry[];
    if (words) {
      const found = await this.#client.call("threads.search", { query: words });
      const titled = await this.#client.call("threads.list", { scope: "recent", query: words });
      const seen = new Map<string, ThreadListing>();
      for (const thread of [...found.map((match) => match.thread), ...titled])
        if (!seen.has(thread.id)) seen.set(thread.id, thread);
      entries = [...seen.values()].map(listedEntry);
      if (entries.length === 0 && !loading.dismissed()) {
        this.#notice("info", `No thread mentions ${words}.`);
        return;
      }
    } else {
      // Listed first: the host names threads for their harness's titles as it lists them,
      // and the open threads below are read once those names have come.
      const [recent, archived] = await Promise.all([
        this.#client
          .call("threads.list", { scope: "recent", limit: 100 })
          .catch((): ThreadListing[] => []),
        this.#client
          .call("threads.list", { scope: "archived", limit: 100 })
          .catch((): ThreadListing[] => []),
      ]);
      // The thread on screen with nothing in it yet is where you are, not one to go back to.
      const empty = (thread: { id: string; runCount: number }) =>
        thread.runCount === 0 && thread.id === this.#currentId;
      const open = this.#threadOrder().filter(
        (thread) => thread.status !== "closed" && !thread.archived && !empty(thread),
      );
      // Each of your threads with the agents it started, the groups newest first.
      const groups: { at: number; rows: ResumeEntry[] }[] = [];
      const depth = (thread: ThreadState): number => {
        const parent = thread.parentId ? this.#client.threads.get(thread.parentId) : undefined;
        return parent && open.includes(parent) ? depth(parent) + 1 : 0;
      };
      for (const thread of open) {
        const status = agentStatus(thread);
        const made: ResumeEntry = {
          id: thread.id,
          title: thread.title,
          on: harnessLabel(thread),
          cwd: thread.info.cwd,
          updatedAt: lastActive(thread),
          depth: depth(thread),
          // A thread at work, or waiting on you, says so with its dot.
          dot: isLive(status) ? `${statusDot(status)} ` : "",
        };
        if (made.depth > 0) groups.at(-1)?.rows.push(made);
        else groups.push({ at: made.updatedAt, rows: [made] });
      }
      const shown = new Set(open.map((thread) => thread.id));
      // Agents whose threads closed, as finished tasks' do, go under the thread that started them.
      const agents = new Map<string, ThreadListing[]>();
      for (const thread of recent.toSorted((a, b) => a.createdAt - b.createdAt)) {
        if (shown.has(thread.id) || empty(thread)) continue;
        if (thread.parentId === null)
          groups.push({ at: thread.updatedAt, rows: [listedEntry(thread)] });
        else agents.set(thread.parentId, [...(agents.get(thread.parentId) ?? []), thread]);
      }
      const withAgents = (parent: ResumeEntry): ResumeEntry[] => [
        parent,
        ...(agents.get(parent.id) ?? []).flatMap((agent) =>
          withAgents({ ...listedEntry(agent), depth: parent.depth + 1 }),
        ),
      ];
      entries = groups
        .toSorted((a, b) => b.at - a.at)
        .flatMap((group) => group.rows)
        .flatMap(withAgents);
      // Archived threads, which tab shows on their own.
      for (const thread of archived)
        if (thread.parentId === null) entries.push({ ...listedEntry(thread), archived: true });
    }
    if (loading.dismissed()) return;
    if (entries.length === 0) {
      this.#notice("info", "No threads yet.");
      return;
    }
    loading.clear();
    const chosen = await new Promise<string | null>((resolve) => {
      this.#panel = {
        kind: "resume",
        view: new ResumeView(words ? `Threads mentioning ${words}` : "Resume", entries, {
          initial: this.#currentId,
          cwd: this.#cwd(),
          home: homedir(),
          // What mentions the words, from every folder.
          ...(words ? { all: true } : {}),
        }),
        onDone: resolve,
      };
      this.#schedule();
    });
    if (!chosen || chosen === this.#currentId) return;
    const target = this.#client.threads.get(chosen);
    if (target && target.status !== "closed") this.#show(target);
    else await this.#resume(chosen, this.#harness);
  }

  /** A harness's name as people know it, such as `Claude Code`. */
  #harnessLabel(id: HarnessId): string {
    return this.#client.harnesses.find((harness) => harness.id === id)?.label ?? id;
  }

  /** Whether the terminal uses this machine's own server, which /connect local names. */
  #onLocal(): boolean {
    return this.#server.label === "local" && !this.#server.inProcess;
  }

  /** Moves the terminal to another server, once it answers: exits, and the CLI connects there. */
  async #connectTo(args: string): Promise<void> {
    const connect = this.#connect;
    if (!connect) throw new Error("This 1harness cannot move to another server");
    let target = args.trim();
    if (!target) {
      const hosts = Object.entries(connect.hosts());
      const options = [
        { name: "local", address: "this machine" },
        ...hosts.map(([name, address]) => ({ name, address })),
      ];
      const index = await this.#pick(
        "Servers",
        options.map((option) =>
          entry(option.name, option.address, {
            tag:
              option.name === this.#server.label || (option.name === "local" && this.#onLocal())
                ? "current"
                : "",
          }),
        ),
        0,
        false,
      );
      if (index === null) return;
      target = options[index]?.name ?? "";
      if (hosts.length === 0 && target === "local")
        this.#notice(
          "info",
          "Name servers on other machines with `1harness hosts add <name> <address>`.",
        );
    }
    const local = target === "local";
    if (local ? this.#onLocal() : target === this.#server.label) {
      this.#notice(
        "info",
        `Already using ${target === "local" ? "this machine's 1harness" : target}.`,
      );
      return;
    }
    const settle = this.#context.ui.progress(`Reaching ${target}…`);
    try {
      await connect.check(local ? "" : target);
    } catch (error) {
      settle("error", `Could not reach ${target}: ${errorMessage(error)}`);
      return;
    }
    settle("info", `Moving to ${target}…`);
    this.#next = local ? "" : target;
    await this.#exit();
  }

  #show(thread: ThreadState): void {
    const changed = this.#currentId !== thread.id;
    this.#currentId = thread.id;
    this.#shownState = thread;
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

  /**
   * A view for a thread; the startup one, with its banner and notices, goes to
   * the first thread this terminal shows, not an agent's or another terminal's.
   * One that stood in while the thread's log loaded becomes its view.
   */
  #newView(id: string, shown: boolean): ThreadView {
    const waited = this.#unloaded.get(id);
    this.#unloaded.delete(id);
    const take = !waited && shown && !this.#homeTaken;
    const view = waited ?? (take ? this.#home : new ThreadView(id));
    if (take) this.#homeTaken = true;
    this.#views.set(id, view);
    return view;
  }

  /** The view standing in for a shown thread whose log is not loaded yet. */
  #waiting(id: string): ThreadView {
    let view = this.#unloaded.get(id);
    if (!view) {
      const take = !this.#homeTaken;
      view = take ? this.#home : new ThreadView(id);
      if (take) this.#homeTaken = true;
      this.#unloaded.set(id, view);
    }
    return view;
  }

  /**
   * Builds the view of a thread the terminal did not see start, from the
   * host's log of it, then follows it live.
   */
  #load(id: string): Promise<void> {
    const loading = this.#loads.get(id);
    if (loading) return loading;
    const load = this.#loadNow(id).finally(() => {
      if (this.#loads.get(id) === load) this.#loads.delete(id);
    });
    this.#loads.set(id, load);
    return load;
  }

  async #loadNow(id: string): Promise<void> {
    if (this.#loading.has(id)) return;
    this.#loading.set(id, []);
    const generation = this.#generation;
    try {
      const page = await this.#client.call("thread.attach", { threadId: id, limit: PAGE_ENTRIES });
      const children = new Map(page.children.map((child) => [child.id, child]));
      const live = (this.#loading.get(id) ?? []).filter((logged) => logged.seq > page.cursor);
      // A load from before a resync is out of date; the one the resync started stands.
      if (generation !== this.#generation) return;
      const paged: Paged = {
        entries: [...page.entries, ...live],
        items: new Map(),
        oldest: page.entries[0]?.seq ?? null,
        more: page.more,
        children,
      };
      const view = this.#views.get(id) ?? this.#newView(id, id === this.#currentId);
      this.#replay(view, paged);
      // Kept to build the view again with earlier pages; chunks go into their items.
      const entries = paged.entries;
      paged.entries = [];
      for (const logged of entries) keep(paged, logged);
      if (paged.more) this.#paged.set(id, paged);
      view.awaiting(this.#client.threads.get(id)?.requests ?? []);
    } catch (error) {
      this.#notice("error", `Could not load ${id}: ${errorMessage(error)}`);
    } finally {
      // A resync since may have begun a load of its own, whose buffer this is not.
      if (generation === this.#generation) this.#loading.delete(id);
      this.#schedule();
    }
  }

  /** Shows a thread's loaded entries in its view, oldest first. */
  #replay(view: ThreadView, paged: Paged): void {
    if (paged.more) view.earlier(EARLIER_ABOVE);
    const context = this.#replayContext(paged);
    for (const logged of paged.entries) view.apply(logged.entry, context);
  }

  /** How a view replays a log: as finished work, with the agents it knows of. */
  #replayContext(paged: Paged): ViewContext {
    return {
      busy: false,
      agent: (childId) => {
        const child = this.#client.threads.get(childId) ?? paged.children.get(childId);
        return child ? agentRowOf(child) : null;
      },
    };
  }

  /** What the transcript renders with: the screen's width, and what is on. */
  #renderContext() {
    return {
      width: this.#column().width,
      cwd: this.#cwd(),
      blink: this.#blinkOn,
      now: Date.now(),
      details: this.#details,
      media: this.#media(),
      figure: (figure: Figure, columns: number) => this.#figure(figure, columns),
      image: (path: string) => this.#image(path),
      html: (html: string, columns: number) => this.#page(html, columns),
      threadTitle: (threadId: string) => this.#client.threads.get(threadId)?.title || null,
    };
  }

  /** The most pixels an image takes on screen, which the host shrinks one to. */
  #imageBox(): { width: number; height: number } {
    const media = this.#media();
    return {
      width: Math.max(1, this.#column().width - 4) * media.cell.width,
      height: media.maxRows * media.cell.height,
    };
  }

  /** Draws every view again, as when a picture they wait for comes. */
  #redrawViews(): void {
    for (const view of new Set([this.#home, ...this.#views.values()])) view.transcript.invalidate();
    this.#schedule();
  }

  /**
   * A page's rows, drawn by the host as a picture as wide as `columns`, at
   * the screen's density and in its theme; null for its text, where the
   * terminal shows no pictures or the page cannot be drawn.
   */
  #page(html: string, columns: number): { rows: string[]; picture?: Shown; live?: boolean } | null {
    const media = this.#media();
    if (!media.graphics) return null;
    const light = isLightTheme();
    const digest = createHash("sha1").update(html).digest("hex");
    const key = `${light ? "light" : "dark"}:${columns}:${media.cell.width}x${media.cell.height}:${digest}`;
    // A page with scripts runs live where the host can; one that cannot is drawn once.
    if (this.#liveHost && runsScripts(html)) {
      const live = this.#livePage(key, html, columns);
      if (!live.failed || live.picture) {
        if (!live.picture) return { rows: [style.muted("Starting the page…")], live: true };
        const shown = live.picture;
        const size = fit(shown, columns, { ...media, maxRows: PLACEHOLDER_LIMIT });
        return {
          rows: Array.from({ length: size.rows }, (_, row) =>
            placeholderRow(shown, row, size.columns),
          ),
          picture: { picture: shown, ...size },
          live: true,
        };
      }
    }
    const known = this.#pages.get(key);
    if (known === null) return null;
    if (known === undefined || known === "loading") {
      if (known === undefined) {
        this.#pages.set(key, "loading");
        const { width, scale } = this.#pageSize(columns);
        void this.#client
          .call("media.html", { html, width, scale, dark: !light, transparent: true })
          .then((drawn) => picture(Buffer.from(drawn.data, "base64")))
          .catch(() => null)
          .then((drawn) => {
            this.#pages.set(key, drawn);
            this.#redrawViews();
          });
      }
      return { rows: [style.muted("Drawing the page…")] };
    }
    // A page is as tall as its content; it scrolls with the transcript, so it may run past the screen.
    const size = fit(known, columns, { ...media, maxRows: PLACEHOLDER_LIMIT });
    return {
      rows: Array.from({ length: size.rows }, (_, row) => placeholderRow(known, row, size.columns)),
      picture: { picture: known, ...size },
    };
  }

  /** The live page for a page at a width, opened on the host the first time it is asked for. */
  #livePage(key: string, html: string, columns: number): LivePage {
    const known = this.#livePages.get(key);
    if (known) return known;
    const { width, scale } = this.#pageSize(columns);
    const page: LivePage = {
      html,
      id: null,
      picture: null,
      css: { width, height: 0 },
      inline: { width, height: 0, scale },
      busy: true,
      failed: false,
      seen: Date.now(),
    };
    this.#livePages.set(key, page);
    void this.#client
      .call("page.open", { html, width, scale, dark: !isLightTheme() })
      .then((frame) => {
        page.id = frame.id;
        page.inline = { width: frame.cssWidth, height: frame.cssHeight, scale };
        this.#liveFrame(page, frame);
        this.#pollLive();
      })
      .catch(() => {
        page.failed = true;
        this.#redrawViews();
      })
      .finally(() => {
        page.busy = false;
      });
    return page;
  }

  /**
   * Takes a live page's new frame into the picture showing it, so the rows
   * that show it stay as they are and the terminal is sent the frame alone;
   * a frame of another size lays them out again.
   */
  #liveFrame(page: LivePage, frame: LiveFrame | null): void {
    if (!frame || page.failed) return;
    // A frame too large is not sent: the page stops where it was, as a picture.
    if (frame.width * frame.height > LIVE_MAX_PIXELS) {
      page.failed = true;
      if (page.id) void this.#client.call("page.close", { id: page.id }).catch(() => {});
      this.#notice("warning", "A live page grew too large to keep running; it stays as it was.");
      return;
    }
    this.#liveBudget.bytes += frame.data.length;
    page.css = { width: frame.cssWidth, height: frame.cssHeight };
    const current = page.picture;
    if (!current) {
      const first = picture(Buffer.from(frame.data, "base64"));
      if (!first) return;
      page.picture = first;
      this.#liveByPicture.set(first.id, page);
      this.#redrawViews();
      return;
    }
    const size = pngSize(Buffer.from(frame.data.slice(0, 64), "base64"));
    if (!size) return;
    const resized = size.width !== current.pixelWidth || size.height !== current.pixelHeight;
    current.data = frame.data;
    current.pixelWidth = size.width;
    current.pixelHeight = size.height;
    current.version = (current.version ?? 0) + 1;
    if (resized) this.#redrawViews();
    else this.#schedule();
  }

  /** Passes what the user did to a live page, and shows what it did. */
  #liveInput(page: LivePage, event: PageEvent): void {
    if (!page.id) return;
    void this.#client
      .call("page.input", { id: page.id, event })
      .then((frame) => this.#liveFrame(page, frame))
      .catch(() => {});
  }

  /** Asks for new frames of the live pages on screen soon; at rest, now and then, to close old ones. */
  #pollLive(delay = LIVE_MS): void {
    if (this.#liveTimer || this.#exiting || this.#livePages.size === 0) return;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = null;
      this.#liveTick();
    }, delay);
  }

  #liveTick(): void {
    const now = Date.now();
    let showing = false;
    if (now - this.#liveBudget.since >= 1000) this.#liveBudget = { since: now, bytes: 0 };
    // Pages move only while someone can be watching, and within the second's budget.
    const paused = !this.#focused || this.#liveBudget.bytes >= LIVE_BYTES_PER_SECOND;
    for (const [key, page] of this.#livePages) {
      if (this.#liveShown.has(page)) page.seen = now;
      if (now - page.seen > LIVE_IDLE_MS && !page.busy) {
        this.#dropLive(key, page);
        continue;
      }
      if (!this.#liveShown.has(page)) continue;
      showing = true;
      if (page.busy || !page.id || paused || page.failed) continue;
      page.busy = true;
      void this.#client
        .call("page.frame", { id: page.id })
        .then((frame) => this.#liveFrame(page, frame))
        .catch(() => this.#dropLive(key, page))
        .finally(() => {
          page.busy = false;
        });
    }
    this.#pollLive(showing ? LIVE_MS : 5000);
  }

  /** Forgets a live page, closed or lost; seen again, it opens afresh. */
  #dropLive(key: string, page: LivePage): void {
    if (this.#livePages.get(key) !== page) return;
    this.#livePages.delete(key);
    if (page.picture) this.#liveByPicture.delete(page.picture.id);
    if (page.id) void this.#client.call("page.close", { id: page.id }).catch(() => {});
    this.#redrawViews();
  }

  /** The live pages a frame shows are on screen, and kept moving. */
  #liveSeen(pictures: readonly (Picture | undefined)[]): void {
    const now = Date.now();
    this.#liveShown = new Set();
    for (const shown of pictures) {
      const page = shown ? this.#liveByPicture.get(shown.id) : undefined;
      if (page) {
        page.seen = now;
        this.#liveShown.add(page);
      }
    }
    if (this.#liveShown.size > 0) this.#pollLive();
  }

  /**
   * The CSS width a page is drawn at to fill `columns`, and the device pixels
   * per CSS pixel: small cells mean a dense screen, which the page is drawn
   * at, so its text stays legible.
   */
  #pageSize(columns: number): { width: number; scale: number } {
    const { cell } = this.#media();
    const scale = Math.min(3, Math.max(1, Math.round((cell.height / 16) * 4) / 4));
    return { width: Math.round((columns * cell.width) / scale), scale };
  }

  /**
   * An image file's picture, from the host, where the file is: asked for the
   * first time, and the views drawn again once it comes.
   */
  #image(path: string): Picture | null | undefined {
    // Fetched again for other cells, as a new font size makes, so it stays sharp.
    const key = this.#imageKey(path);
    const known = this.#images.get(key);
    if (known !== undefined) return known === "loading" ? undefined : known;
    this.#images.set(key, "loading");
    void this.#client
      .call("files.image", { path, ...this.#imageBox() })
      .then((found) => (found ? picture(Buffer.from(found.data, "base64")) : null))
      .catch(() => null)
      .then((shown) => {
        this.#images.set(key, shown);
        if (shown) this.#redrawViews();
      });
    return undefined;
  }

  #imageKey(path: string): string {
    return `${this.#cell.width}x${this.#cell.height}\0${path}`;
  }

  #media(): MediaContext {
    return { graphics: this.#graphics, cell: this.#cell, maxRows: maxImageRows(this.#screen.rows) };
  }

  /**
   * A figure's rows, centered in the column as a figure is: a picture where
   * the terminal shows images, else text that fits (a diagram in box-drawing
   * characters, an equation in Unicode), else null for its source.
   */
  #figure(figure: Figure, columns: number): { rows: string[]; picture?: Shown } | null {
    const media = this.#media();
    const renderer = this.#figures.renderer(figure.kind);
    if (media.graphics && renderer.available) {
      const drawn = renderer.picture(
        figure.source,
        isLightTheme(),
        columns * media.cell.width,
        media.cell,
      );
      if (drawn === undefined) {
        // Until it is drawn, its text holds its place, or a line saying it is coming.
        const text = figure.kind === "math" ? renderer.text(figure.source) : null;
        if (text) return { rows: this.#centered(text.map(style.soft), columns) };
        return { rows: [style.muted(FIGURE_NAMES[figure.kind].drawing)] };
      }
      if (drawn) {
        const size = fit(drawn, columns, media);
        const indent = " ".repeat(Math.max(0, Math.floor((columns - size.columns) / 2)));
        return {
          rows: Array.from(
            { length: size.rows },
            (_, row) => indent + placeholderRow(drawn, row, size.columns),
          ),
          picture: { picture: drawn, ...size },
        };
      }
    }
    const text = renderer.text(figure.source);
    if (!text) return null;
    const paint = figure.kind === "math" ? style.text : style.soft;
    // A diagram too wide for characters shows its source; an equation's text wraps.
    if (figure.kind === "mermaid" && text.some((line) => visibleWidth(line) > columns)) return null;
    return { rows: this.#centered(text.map(paint), columns) };
  }

  /** Lines set in the middle of `columns` together, keeping their alignment; wrapped where too wide. */
  #centered(lines: string[], columns: number): string[] {
    const widest = Math.max(0, ...lines.map((line) => visibleWidth(line)));
    if (widest > columns) return lines.flatMap((line) => wrap(line, columns, "  "));
    const indent = " ".repeat(Math.max(0, Math.floor((columns - widest) / 2)));
    return lines.map((line) => indent + line);
  }

  /**
   * The column everything is laid out in: the screen's width up to a reading
   * width, centered with the margin split on both sides.
   */
  #column(): { width: number; margin: number } {
    const screen = this.#screen.columns;
    const width = Math.min(screen, columnWidth());
    return { width, margin: Math.floor((screen - width) / 2) };
  }

  /**
   * Loads the page of a thread's log before what its view shows, and shows
   * the view again from there, keeping the rows on screen where they were.
   */
  async #loadEarlier(id: string): Promise<void> {
    const paged = this.#paged.get(id);
    // Live entries go on into the view meanwhile, since the page goes above them.
    if (!paged?.more || paged.oldest === null || this.#loading.has(id) || this.#loads.has(id))
      return;
    if (this.#earlierLoading.has(id)) return;
    this.#earlierLoading.add(id);
    const generation = this.#generation;
    try {
      const page = await this.#client.call("thread.attach", {
        threadId: id,
        limit: PAGE_ENTRIES,
        before: paged.oldest,
      });
      for (const child of page.children) paged.children.set(child.id, child);
      if (generation !== this.#generation) return;
      const shift = page.entries.length;
      paged.entries = [...page.entries, ...paged.entries];
      paged.items = new Map();
      paged.entries.forEach((logged, index) => {
        if (logged.entry.type === "item") paged.items.set(logged.entry.item.id, index);
      });
      paged.oldest = page.entries[0]?.seq ?? paged.oldest;
      paged.more = page.more;
      if (!paged.more) this.#paged.delete(id);
      const old = this.#views.get(id);
      if (!old) return;
      // The startup view keeps being the startup view.
      const wasHome = old === this.#home;
      // Built again as one log, so a turn across the pages' cut reads whole, with the
      // terminal's own lines back in their places.
      const view = new ThreadView(id);
      view.rebuild(
        old,
        paged.entries.map((logged) => logged.entry),
        shift,
        this.#replayContext(paged),
        paged.more ? EARLIER_ABOVE : null,
      );
      view.turn = old.turn;
      // Rows count from the bottom, so the same scroll shows the same rows; the rows
      // added above are not new output for the view to hold still against.
      view.scroll = old.scroll;
      view.total = view.transcript.view(this.#renderContext(), 0, 0).total;
      view.awaiting(this.#client.threads.get(id)?.requests ?? []);
      this.#views.set(id, view);
      if (wasHome) this.#home = view;
    } catch (error) {
      this.#notice("error", `Could not load earlier turns: ${errorMessage(error)}`);
    } finally {
      this.#earlierLoading.delete(id);
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
    // Your threads newest first; the agents each started under it, as they were started.
    const under = (parentId: string | null): ThreadState[] =>
      all
        .filter((thread) => thread.parentId === parentId)
        .toSorted((a, b) => (parentId === null ? lastActive(b) - lastActive(a) : 0))
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
      // 1harness owns the commands; from a harness come only your skills, and
      // none that would shadow one of 1harness's.
      this.#nativeCommands = commands.filter(
        (command) =>
          command.kind === "skill" &&
          !own.has(command.name) &&
          !command.aliases.some((alias) => own.has(alias)),
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
    this.#prompt = null;
    this.#requests = [];
    // What was still working, before a host in this process stops it on the way out.
    const working = this.#ownThreads()
      .filter((thread) => thread.busy && thread.status !== "closed")
      .map((thread) => thread.id);
    // Leaving detaches from the host; a server keeps the threads working.
    await this.#client.close().catch(() => {});
    for (const timer of [
      this.#blinkTimer,
      this.#frame,
      this.#sequenceTimer,
      this.#statusTimer,
      this.#exitTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.#programStatus?.clear();
    this.#screen.leave();
    if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
    this.#in.setRawMode(false);
    this.#in.pause();
    for (const undo of this.#unlisten.splice(0)) undo();
    const server = this.#server;
    if (this.#next !== undefined) {
      process.stdout.write(
        style.muted(`Connecting to ${this.#next || "this machine's 1harness"}…\n`),
      );
    } else {
      const on = server.local ? "" : ` -S ${server.label}`;
      // The thread on screen, or one still working when that one has nothing to go back to.
      const target =
        current && current.runCount > 0
          ? current
          : working.length > 0
            ? this.#client.threads.get(working[0] ?? "")
            : undefined;
      const hint = !target
        ? null
        : this.#stored
          ? `1harness${on} --resume ${target.id}`
          : target.info.threadId
            ? `1harness${on} --harness ${target.harness} --resume ${target.info.threadId}`
            : null;
      // A server keeps what was working going; this process takes it down with it.
      const they = working.length === 1 ? "it" : "they";
      if (working.length > 0)
        process.stdout.write(
          style.muted(
            server.inProcess
              ? `${working.join(", ")} stopped working: without a server, ${they} ran in this 1harness.\n`
              : `${working.join(", ")} ${working.length === 1 ? "is" : "are"} still working; ${they} ${working.length === 1 ? "carries" : "carry"} on in 1harness's server${server.local ? "" : ` on ${server.label}`}.\n`,
          ),
        );
      if (hint)
        process.stdout.write(
          style.muted(
            `${working.length > 0 && !server.inProcess ? "Come back" : "Resume"} with: ${hint}\n`,
          ),
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
        if (this.#shownState?.id === event.threadId) this.#shownState = null;
        if (this.#currentId === event.threadId) {
          // Gone from under the terminal, as when another forgets it: on to another open one.
          this.#currentId = null;
          const next = this.#threadOrder().find(
            (thread) => thread.status !== "closed" && thread.parentId === null && !thread.archived,
          );
          // An open or resume under way goes back on its own if it fails.
          if (next && this.#opening === 0) this.#show(next);
        }
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
        const paged = this.#paged.get(event.threadId);
        if (paged) keep(paged, { seq: event.seq, entry: event.entry });
        const view = this.#views.get(event.threadId);
        view?.apply(event.entry, this.#viewContext(event.threadId));
        // A call can arrive after the approval asking for it.
        const requests = this.#client.threads.get(event.threadId)?.requests ?? [];
        if (event.entry.type === "item" && requests.length > 0) view?.awaiting(requests);
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
        this.#resynced(event.hello);
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
      // Seen from its start, its view fills in live. One that comes back parked,
      // reopened or restored, has a log to load when it is shown.
      const back = thread.status === "parked" || thread.status === "closed";
      const mine = thread.openedBy === this.#client.id;
      const view = back ? null : this.#newView(thread.id, mine);
      // Threads this terminal opens are shown; agents' run in the background.
      if (mine) {
        // One an open or resume is waiting on; its reply knows it was shown.
        if (this.#opening > 0) this.#openedId = thread.id;
        this.#show(thread);
        if (this.#announce) view?.say("info", this.#announce);
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
  #resynced(hello: HelloResult): void {
    const current = this.#currentId;
    // Loads begun before this catch-up read the old feed; their results are dropped.
    this.#generation++;
    this.#loads.clear();
    this.#loading.clear();
    const restarted = this.#instance !== null && hello.instance !== this.#instance;
    this.#instance = hello.instance;
    this.#stored = hello.store !== null;
    this.#registerHostCommands(hello.commands);
    this.#views.clear();
    this.#unloaded.clear();
    this.#paged.clear();
    this.#homeTaken = true;
    this.#requests = [];
    this.#prompt = null;
    for (const thread of this.#client.threads.values()) {
      this.#known.add(thread.id);
      this.#syncRequests(thread);
    }
    const shown = current ? this.#client.threads.get(current) : undefined;
    // Rebuilt views lose the terminal's own lines, so this one goes in once the view is back.
    const say = () => {
      if (restarted)
        this.#notice(
          "info",
          `1harness's server started again${this.#server.local ? "" : ` on ${this.#server.label}`}, and its threads are back. A parked thread's harness starts with your next message.`,
        );
    };
    if (shown) void this.#load(shown.id).then(say);
    else {
      this.#currentId = null;
      say();
    }
    // The host it caught up with may be a new one, which has to be told what is on screen.
    void this.#client.call("client.show", { threadId: this.#currentId }).catch(() => {});
    for (const request of hello.pending) this.#ui(request);
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
    // Calls waiting for an answer say so, rather than seem to run.
    this.#views.get(thread.id)?.awaiting(thread.requests);
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
      const config: ChoiceConfig = {
        header: "Permission needed",
        tag: command ? "Command" : "",
        title: request.title,
        detail: request.detail ? [request.detail] : [],
        options: request.options.map((option) => ({ label: option.label, description: "" })),
        multiSelect: false,
        allowOther: false,
        secret: false,
        initial,
        // A refusal can say why, which the agent hears and goes on with.
        commentable: (index) => request.options[index]?.effect === "deny",
      };
      this.#showPrompt(
        next,
        (done: (result: ChoiceResult) => void) => new ChoicePrompt(config, done),
        (result) => {
          const option =
            result.kind === "options" ? request.options[result.indexes[0] ?? 0] : undefined;
          const reason = result.kind === "options" ? result.comment?.text : undefined;
          respond(
            !option
              ? { kind: "cancel" }
              : option.effect === "deny" && reason
                ? { kind: "decline", reason }
                : { kind: "approval", optionId: option.id },
          );
        },
      );
      return;
    }
    // All of a request's questions in one prompt, to move between and annotate.
    const configs: ChoiceConfig[] = request.questions.map((question) => ({
      header: "Question",
      tag: question.header,
      title: question.question,
      detail: [],
      options: question.options,
      multiSelect: question.multiSelect,
      allowOther: question.allowOther,
      secret: question.secret,
      initial: 0,
      commentable: () => true,
    }));
    this.#showPrompt(
      next,
      (done: (result: QuestionsResult) => void) => new QuestionPrompt(configs, done),
      (result) => {
        if (result.kind === "cancel") {
          respond({ kind: "cancel" });
          return;
        }
        const answers: Record<string, string[]> = {};
        request.questions.forEach((question, index) => {
          const answer = result.answers[index];
          if (!answer) return;
          // A comment goes beside the answer, as one more of its values, saying
          // which option it is on where there could be more than one.
          const { comment } = answer;
          const on = question.options[comment?.index ?? -1]?.label;
          answers[question.id] = [
            ...answer.indexes.map((choice) => question.options[choice]?.label ?? ""),
            ...(answer.text !== null ? [answer.text] : []),
            ...(comment
              ? [
                  question.multiSelect && on
                    ? `comment on ${on}: ${comment.text}`
                    : `comment: ${comment.text}`,
                ]
              : []),
          ];
        });
        respond({ kind: "question", answers });
      },
    );
  }

  /** Shows the prompt `make` builds, which calls `onDone` with its answer. */
  #showPrompt<R>(
    asking: OpenRequest,
    make: (done: (result: R) => void) => ChoicePrompt | QuestionPrompt,
    onDone: (result: R) => void,
  ): void {
    const prompt = make((result) => {
      if (this.#prompt?.prompt === prompt) this.#prompt = null;
      onDone(result);
      // The prompt that follows an answer, such as the next request's, takes keys at once.
      this.#strayTyping = false;
      this.#schedule();
    });
    this.#prompt = { prompt, asking };
    this.#strayTyping = Date.now() - this.#typedAt < PROMPT_GRACE_MS;
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
    options: { pick?: string; tabs?: boolean; describe?: boolean; count?: boolean } = {},
  ): Promise<number | null> {
    return new Promise((resolve) => {
      if (entries.length === 0) {
        resolve(null);
        return;
      }
      // The menu this one replaces is dismissed, which answers a host waiting on it;
      // the same pick shown again, after a resync, is still waited on.
      const replaced = this.#panel;
      if (replaced?.kind === "menu" && !(options.pick && replaced.pick === options.pick)) {
        this.#panel = null;
        if (replaced.onReplaced) replaced.onReplaced();
        else replaced.onDone(null);
      }
      this.#panel = {
        kind: "menu",
        menu: new Menu({
          title,
          entries,
          initial,
          filter,
          ...(options.tabs ? { tabs: true } : {}),
          ...(options.describe ? { describe: true } : {}),
          ...(options.count === false ? { count: false } : {}),
        }),
        onDone: resolve,
        ...(options.pick ? { pick: options.pick } : {}),
      };
      this.#schedule();
    });
  }

  // Input

  #input(chunk: string): void {
    if (this.#exiting) return;
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
      (event.type === "key" ||
        event.type === "paste" ||
        event.type === "wheel" ||
        event.type === "mouse") &&
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
        if (event.focused) this.#measureCells();
        this.#statusChanged();
        return;
      case "graphics":
        if (process.env["ONEHARNESS_IMAGES"] !== "0") this.#graphics = event.ok;
        return;
      case "cellSize":
        if (event.width === this.#cell.width && event.height === this.#cell.height) return;
        // Pictures are drawn for the cells they fill: each is drawn again for the new ones.
        this.#cell = { width: event.width, height: event.height };
        this.#redrawViews();
        return;
      case "background":
        setLightTheme(event.light);
        for (const view of new Set([this.#home, ...this.#views.values()]))
          view.transcript.invalidate();
        return;
      case "wheel":
        if (this.#viewer?.live) {
          const { live } = this.#viewer;
          this.#liveInput(live, {
            type: "wheel",
            x: live.css.width / 2,
            y: live.css.height / 2,
            delta_y: event.delta * 100,
          });
        } else if (this.#viewer) this.#viewer.scroll += event.delta * WHEEL_ROWS;
        else this.#scrollBy(-event.delta * WHEEL_ROWS);
        return;
      case "mouse":
        this.#mouse(event);
        return;
      case "paste":
        if (this.#viewer?.live) {
          this.#liveInput(this.#viewer.live, { type: "text", text: event.text });
          return;
        }
        if (this.#panel?.kind === "resume") {
          this.#panel.view.paste(event.text);
        } else if (this.#prompt) {
          if (this.#prompt.prompt.typing) this.#prompt.prompt.paste(event.text);
        } else if (this.#panel?.kind === "menu") {
          this.#panel.menu.paste(event.text);
        } else {
          this.#panel = null;
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
    const now = Date.now();
    const sinceLast = now - this.#typedAt;
    this.#typedAt = now;
    if (this.#viewer) {
      this.#viewerKey(key);
      return;
    }
    // A key ends what the mouse selected.
    this.#selection = null;
    if (key.ctrl && key.name === "z") {
      this.#suspend();
      return;
    }
    if (key.ctrl && key.name === "l") {
      this.#screen.invalidate();
      return;
    }
    // The thread list opens over a prompt too, which waits for its thread to show again.
    if (key.ctrl && key.name === "t" && !this.#panel) {
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
    // A prompt shows its own request whole; elsewhere, tool calls show whole.
    if (key.ctrl && key.name === "x" && !this.#prompt && !this.#panel) {
      this.#details = !this.#details;
      return;
    }
    // Without a parent, alt+↑ is up.
    const parent = this.#client.threads.get(this.#current?.parentId ?? "");
    if (key.meta && key.name === "up" && !this.#panel && parent) {
      this.#show(parent);
      return;
    }
    // Page keys scroll a request shown whole that runs past the screen.
    if ((key.name === "pageup" || key.name === "pagedown") && this.#prompt?.prompt.scrolls) {
      this.#prompt.prompt.key(key);
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      if (!this.#panel) {
        const page = Math.max(1, this.#screen.rows - 8);
        this.#scrollBy(key.name === "pageup" ? page : -page);
        return;
      }
    }
    // A list opened over a prompt, such as the thread list, shows and takes keys first.
    if (this.#prompt && this.#panel && this.#panelKey(key)) return;
    if (this.#prompt) {
      // Typing that was going on when a prompt appeared was meant for something else:
      // its keys are dropped until it pauses. Keys after a pause, or after an answer
      // for the next question, are the prompt's.
      if (this.#strayTyping && sinceLast < PROMPT_GRACE_MS) return;
      this.#strayTyping = false;
      this.#prompt.prompt.key(key);
      return;
    }
    if (this.#panel && this.#panelKey(key)) return;
    // ↑↓ and ctrl+p/n through history go on through entries that open a menu, such as /status.
    const historyKey =
      (!key.ctrl && !key.meta && (key.name === "up" || key.name === "down")) ||
      (key.ctrl && (key.name === "p" || key.name === "n"));
    const walking = this.#recalled && historyKey;
    this.#recalled = walking;
    if (!walking) {
      if (this.#slash && this.#slashKey(key)) return;
      if (this.#args && this.#argsKey(key)) return;
      if (this.#mention && this.#mentionKey(key)) return;
    }
    const before = this.#editor.text;
    this.#composerKey(key);
    // A text that history put there; the next ↑↓ walks on.
    if (historyKey && this.#editor.text !== before) this.#recalled = true;
    this.#syncCompletion();
  }

  /** Keys for a panel; returns false for a key that closed an info panel and goes on to the composer. */
  #panelKey(key: Key): boolean {
    const panel = this.#panel;
    if (!panel) return false;
    if (panel.kind === "info") {
      // A panel to read closes on any key; typing goes on into the composer.
      this.#panel = null;
      return key.name === "escape" || key.name === "return" || (key.ctrl && key.name === "c");
    }
    if (panel.kind === "resume") {
      const result = panel.view.key(key, Math.max(1, this.#screen.rows - 12));
      if (!result) return true;
      // Renaming and archiving happen in the list, which stays open.
      if (result.kind === "rename" || result.kind === "archive") {
        const call =
          result.kind === "rename"
            ? this.#client.call("thread.rename", { threadId: result.id, title: result.title })
            : this.#client.call("thread.flag", { threadId: result.id, archived: result.archived });
        void call.catch((error: unknown) => this.#notice("error", errorMessage(error)));
        return true;
      }
      this.#panel = null;
      panel.onDone(result.kind === "choose" ? result.id : null);
      return true;
    }
    const result = panel.menu.key(key);
    if (!result) return true;
    this.#panel = null;
    panel.onDone(result.kind === "choose" ? result.index : null);
    return true;
  }

  /** Keys for the slash command menu; returns false for keys that go to the composer. */
  #slashKey(key: Key): boolean {
    const menu = this.#slash;
    if (!menu) return false;
    // The composer takes typing, so only arrows and ctrl+j/k move here.
    const step = lineStep(key);
    if (step) {
      menu.move(step);
      this.#slashMoved = this.#editor.text;
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
    // A move holds while the word is the same; typing more of it starts over.
    const moved = this.#args?.start === start && this.#args.typed === typed && this.#args.moved;
    // A word typed in full is chosen over longer ones, so /resume t1 is not t12.
    const exact = items.find((item) => item.value.toLowerCase() === typed);
    if (exact && !moved) menu.select(exact.value);
    // The word after one that needs another, as `/mcp show NAME`, is the list's to give.
    const required = this.#argsRequired === start;
    this.#args = { menu, start, items, moved, typed, required };
  }

  /** Keys for the argument list; returns false for keys that go to the composer. */
  #argsKey(key: Key): boolean {
    const args = this.#args;
    if (!args) return false;
    const step = lineStep(key);
    if (step) {
      args.menu.move(step);
      args.moved = true;
      return true;
    }
    if (key.name === "escape") {
      this.#argsDismissed = this.#editor.text;
      this.#args = null;
      return true;
    }
    const tab = key.name === "tab" && !key.shift;
    if (!tab && !(key.name === "return" && !key.meta)) return false;
    // With nothing typed for the word, the list only suggests: enter runs what is there,
    // so `/harness codex ` does not become `/harness codex fresh`. Moving to a word picks it.
    if (!tab && !args.moved && !args.required && this.#editor.text.slice(args.start).trim() === "")
      return false;
    const selected = args.menu.selected();
    const item = args.items.find((candidate) => candidate.value === selected?.label);
    if (!item) return false;
    const text = `${this.#editor.text.slice(0, args.start)}${item.value}${item.more ? " " : ""}`;
    this.#editor.set(text);
    this.#argsRequired = item.more ? text.length : null;
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

  /** Commands the current session can run: 1harness's in a set order, then the rest, then /quit. */
  #available(): CommandDefinition[] {
    return this.#commands
      .list()
      .filter((command) => this.#isAvailable(command))
      .map((command, index) => ({ command, index }))
      .toSorted((a, b) => commandRank(a.command) - commandRank(b.command) || a.index - b.index)
      .map(({ command }) => command);
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
    const own = this.#available();
    const last = own.filter((command) => LAST_COMMANDS.includes(command.name));
    for (const command of own.filter((candidate) => !last.includes(candidate)))
      add(
        [command.name, ...(command.aliases ?? [])],
        entry(`/${command.name}`, command.description, { tag: command.group }),
      );
    for (const command of this.#nativeCommands)
      add(
        [command.name, ...command.aliases],
        entry(`/${command.name}`, command.description, { tag: "Skills" }),
      );
    for (const command of last)
      add(
        [command.name, ...(command.aliases ?? [])],
        entry(`/${command.name}`, command.description, { tag: command.group }),
      );
    if (entries.length === 0) {
      this.#slash = null;
      return;
    }
    if (this.#slash) this.#slash.setEntries(entries);
    else this.#slash = new Menu({ title: "Commands", entries, describe: true });
    // A command the user moved to stays chosen while the text is the same, as lists refresh.
    if (this.#slashMoved !== text) this.#slashMoved = null;
    if (exact !== null && this.#slashMoved === null) this.#slash.select(exact);
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
        if (this.#exitTimer) clearTimeout(this.#exitTimer);
        this.#exitTimer = setTimeout(() => {
          this.#exitArmed = false;
          this.#exitTimer = null;
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
          const text = this.#editor.text.trim();
          // A command runs now, as enter would; `//` sends a message that starts with `/`.
          if (text.startsWith("/") && !text.startsWith("//")) {
            this.#submit(text);
            return;
          }
          this.#view.scroll = 0;
          this.#editor.take();
          this.#send(text.startsWith("//") ? text.slice(1) : text, false);
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

  /**
   * The mouse: a drag over the transcript selects its text, copied when the
   * button is let go; a double click takes a word, a third the row. A click
   * chooses a list's entry, copies a code block, or opens a picture whole.
   */
  #mouse(event: Extract<InputEvent, { type: "mouse" }>): void {
    const viewer = this.#viewer;
    if (viewer?.live) {
      this.#viewerMouse(viewer, viewer.live, event);
      return;
    }
    if (viewer) {
      // Any click closes the view, but the one that opened it.
      if (event.action === "release" && Date.now() - viewer.opened > CLICK_MS) this.#closeViewer();
      return;
    }
    if (event.button !== 0) return;
    const { margin, width } = this.#column();
    const column = Math.max(0, Math.min(width - 1, event.column - margin));
    const rows = this.#targets.length;
    if (event.action === "press") {
      // A selection starts where the button went down, once it moves.
      const anchor = event.row < rows ? { row: this.#top + event.row, column } : null;
      this.#press = { row: event.row, column: event.column, dragged: false, anchor };
      this.#selection = null;
      this.#schedule();
      return;
    }
    const press = this.#press;
    if (event.action === "drag") {
      if (!press?.anchor || rows === 0) return;
      if (!press.dragged && event.row === press.row && event.column === press.column) return;
      press.dragged = true;
      this.#selection ??= { anchor: press.anchor, head: press.anchor };
      // Held past the transcript's top or bottom, it scrolls to take in more.
      if (event.row <= 0) this.#scrollBy(1);
      else if (event.row >= rows && this.#view.scroll > 0) this.#scrollBy(-1);
      const row = Math.max(0, Math.min(rows - 1, event.row));
      this.#selection.head = { row: this.#top + row, column };
      this.#schedule();
      return;
    }
    this.#press = null;
    if (press?.dragged && this.#selection) {
      this.#copySelection();
      return;
    }
    this.#selection = null;
    if (!press) return;
    const now = Date.now();
    const last = this.#clicks;
    const again =
      now - last.at < CLICK_MS &&
      last.row === event.row &&
      Math.abs(last.column - event.column) <= 1;
    this.#clicks = {
      at: now,
      row: event.row,
      column: event.column,
      count: again ? last.count + 1 : 1,
    };
    if (this.#clicks.count > 1 && event.row < rows) {
      this.#selectAt(event.row, column, this.#clicks.count > 2);
      return;
    }
    this.#click(event.row, column);
  }

  /** A click: on a list's entry it chooses it, on code it copies it, on a picture it shows it whole. */
  #click(row: number, column: number): void {
    const list = this.#listAt;
    if (list && row >= list.row) {
      if (list.menu.entryAt(row - list.row))
        this.#key({ name: "return", text: "", ctrl: false, meta: false, shift: false });
      return;
    }
    const hit = this.#targets[row];
    if (!hit) return;
    const { target } = hit;
    // A live page takes a click on itself; its caption opens it whole.
    const live = target.kind === "picture" ? this.#liveByPicture.get(target.picture.id) : undefined;
    if (live && target.kind === "picture") {
      const columns = this.#column().width - IMAGE_INDENT * 2;
      const size = fit(target.picture, columns, { ...this.#media(), maxRows: PLACEHOLDER_LIMIT });
      const across = column - IMAGE_INDENT;
      if (hit.row < size.rows && across >= 0 && across < size.columns) {
        this.#liveInput(live, {
          type: "click",
          x: ((across + 0.5) / size.columns) * live.css.width,
          y: ((hit.row + 0.5) / size.rows) * live.css.height,
        });
        return;
      }
    }
    if (target.kind === "details") {
      this.#details = !this.#details;
      this.#schedule();
    } else if (target.kind === "code") {
      const lines = target.code.split("\n").length;
      this.#copy(
        target.code,
        `Copied the ${target.lang ? `${target.lang} ` : ""}code, ${lines} ${lines === 1 ? "line" : "lines"}`,
      );
    } else this.#openViewer(target);
  }

  /** Selects and copies the word under a double click, or a triple click's whole row. */
  #selectAt(row: number, column: number, whole: boolean): void {
    const text = this.#shownRows[row] ?? "";
    const range = whole
      ? { from: 0, to: Math.max(0, visibleWidth(text) - 1) }
      : wordAt(text, column);
    if (!range) return;
    const at = this.#top + row;
    this.#selection = {
      anchor: { row: at, column: range.from },
      head: { row: at, column: range.to },
    };
    this.#copySelection();
  }

  /** Copies the selected text; it stays shown selected until the next key or click. */
  #copySelection(): void {
    const selection = this.#selection;
    if (!selection) return;
    const [start, end] = ordered(selection);
    const total = this.#view.total;
    const lines = this.#view.transcript.view(
      this.#renderContext(),
      end.row - start.row + 1,
      Math.max(0, total - end.row - 1),
    ).rows;
    const text = selectedText(lines, selection);
    if (!text) {
      this.#selection = null;
      this.#schedule();
      return;
    }
    const count = text.split("\n").length;
    this.#copy(text, count > 1 ? `Copied ${count} lines` : `Copied “${truncate(text, 48)}”`);
  }

  /** Puts text on the clipboard where the user sits, through the terminal, and says so for a moment. */
  #copy(text: string, said: string): void {
    // OSC 52: the terminal sets the clipboard, the one where you sit, over SSH or Rex too.
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    this.#toast = { text: said, until: Date.now() + TOAST_MS };
    setTimeout(() => this.#schedule(), TOAST_MS + 50);
    this.#schedule();
  }

  /** Opens a picture on the whole screen, and draws it again for that size. */
  #openViewer(target: Extract<Target, { kind: "picture" }>): void {
    const live = this.#liveByPicture.get(target.picture.id);
    const viewer: Viewer = {
      target,
      picture: target.picture,
      scroll: 0,
      opened: Date.now(),
      ...(live ? { live } : {}),
    };
    this.#viewer = viewer;
    this.#selection = null;
    this.#schedule();
    if (!live) {
      void this.#sharpen(viewer);
      return;
    }
    // A live page keeps its width and is zoomed to the screen's, its viewport as tall as the screen.
    const media = this.#media();
    const room = {
      width: Math.max(1, this.#screen.columns - 4) * media.cell.width,
      height: Math.max(1, this.#screen.rows - 2) * media.cell.height,
    };
    const scale = Math.min(4, Math.max(live.inline.scale, room.width / live.inline.width));
    if (live.id)
      void this.#client
        .call("page.resize", {
          id: live.id,
          width: live.inline.width,
          height: Math.floor(room.height / scale),
          scale,
        })
        .then((frame) => this.#liveFrame(live, frame))
        .catch(() => {});
  }

  /**
   * Draws the viewer's picture again at the screen's size, where it has
   * something to draw from: its file, its diagram's source, or its page, drawn
   * denser so it reads the same.
   */
  async #sharpen(viewer: Viewer): Promise<void> {
    const media = this.#media();
    const box = {
      width: Math.max(1, this.#screen.columns - 4) * media.cell.width,
      height: Math.max(1, this.#screen.rows - 2) * media.cell.height,
    };
    const { target } = viewer;
    let sharper: Picture | null | undefined = null;
    try {
      if (target.path) {
        const found = await this.#client.call("files.image", { path: target.path, ...box });
        sharper = found ? picture(Buffer.from(found.data, "base64")) : null;
      } else if (target.figure) {
        sharper = this.#figures
          .renderer(target.figure.kind)
          .picture(target.figure.source, isLightTheme(), box.width, media.cell, box.height);
      } else if (target.html !== undefined) {
        const { width } = this.#pageSize(this.#column().width - IMAGE_INDENT * 2);
        const scale = Math.round(Math.min(4, Math.max(1, box.width / width)) * 100) / 100;
        const drawn = await this.#client.call("media.html", {
          html: target.html,
          width,
          scale,
          dark: !isLightTheme(),
          transparent: true,
        });
        sharper = picture(Buffer.from(drawn.data, "base64"));
      }
    } catch {
      // The picture it opened with stays.
    }
    if (sharper && this.#viewer === viewer) {
      viewer.picture = sharper;
      this.#schedule();
    }
  }

  /** The mouse over a live page shown whole goes to it; a click off it closes the view. */
  #viewerMouse(
    viewer: Viewer,
    live: LivePage,
    event: Extract<InputEvent, { type: "mouse" }>,
  ): void {
    const layout = viewer.layout;
    if (!layout || event.button !== 0) return;
    const across = event.column - layout.left;
    const down = event.row - layout.top;
    const inside = across >= 0 && across < layout.columns && down >= 0 && down < layout.rows;
    if (!inside) {
      if (event.action === "release" && Date.now() - viewer.opened > CLICK_MS) this.#closeViewer();
      return;
    }
    this.#liveInput(live, {
      type: "mouse",
      action:
        event.action === "press"
          ? "mousePressed"
          : event.action === "release"
            ? "mouseReleased"
            : "mouseMoved",
      x: ((across + 0.5) / layout.columns) * live.css.width,
      y: ((down + layout.scroll + 0.5) / layout.rows) * live.css.height,
      buttons: event.action === "release" ? 0 : 1,
    });
  }

  #closeViewer(): void {
    const live = this.#viewer?.live;
    this.#viewer = null;
    this.#schedule();
    // A live page goes back to the transcript's width and height.
    if (live?.id)
      void this.#client
        .call("page.resize", {
          id: live.id,
          width: live.inline.width,
          height: live.inline.height,
          scale: live.inline.scale,
        })
        .then((frame) => this.#liveFrame(live, frame))
        .catch(() => {});
  }

  /** Keys while a picture is shown whole: it scrolls, copies what it was drawn from, or closes. */
  #viewerKey(key: Key): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    if (viewer.live) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) this.#closeViewer();
      else {
        const event = pageKey(key);
        if (event) this.#liveInput(viewer.live, event);
      }
      return;
    }
    const page = Math.max(1, this.#screen.rows - 4);
    const step = lineStep(key);
    if (step) viewer.scroll += step;
    else if (key.name === "pageup" || key.name === "pagedown")
      viewer.scroll += key.name === "pageup" ? -page : page;
    else if (key.name === "home" || key.text === "g") viewer.scroll = 0;
    else if (key.name === "end" || key.text === "G") viewer.scroll = Number.MAX_SAFE_INTEGER;
    else if (key.text === "c") {
      const { target } = viewer;
      if (target.html !== undefined) this.#copy(target.html, "Copied the page's HTML");
      else if (target.figure)
        this.#copy(target.figure.source, FIGURE_NAMES[target.figure.kind].copied);
      else if (target.path) this.#copy(target.path, "Copied the image's path");
    } else if (
      key.name === "escape" ||
      key.name === "return" ||
      key.name === "space" ||
      key.text === "q" ||
      (key.ctrl && key.name === "c")
    )
      this.#closeViewer();
    this.#schedule();
  }

  /** The viewer's frame: the picture as large as the screen takes, under its name. */
  #renderViewer(): void {
    const viewer = this.#viewer;
    if (!viewer) return;
    const { target } = viewer;
    const what =
      target.html !== undefined
        ? "HTML"
        : target.figure
          ? target.figure.kind === "math"
            ? "TeX"
            : "source"
          : target.path
            ? "path"
            : "";
    const toast = this.#toast && Date.now() < this.#toast.until ? `✓ ${this.#toast.text} · ` : "";
    const hints = viewer.live
      ? "the mouse and keys go to the page · esc closes"
      : `${toast}${what ? `c copies the ${what} · ` : ""}esc closes`;
    const shown = viewer.live?.picture ?? viewer.picture;
    this.#liveSeen(viewer.live ? [shown] : []);
    const frame = viewerFrame(
      shown,
      target.title,
      hints,
      { columns: this.#screen.columns, rows: this.#screen.rows },
      this.#media(),
      viewer.scroll,
      target.html !== undefined && !viewer.live,
    );
    viewer.scroll = frame.scroll;
    viewer.layout = {
      left: frame.left,
      top: frame.top,
      columns: frame.shown.columns,
      rows: frame.shown.rows,
      scroll: frame.scroll,
    };
    this.#targets = [];
    this.#listAt = null;
    this.#screen.render(frame.rows, null, [frame.shown]);
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
    const message = !text.startsWith("/") || text.startsWith("//");
    if (message && !this.#live) {
      // The text stays in the composer for a thread that can take it, wherever it came from.
      if (this.#editor.text.trim() === "") this.#editor.set(raw);
      const current = this.#current;
      this.#notice(
        "error",
        current
          ? `${current.id} is closed. /resume ${current.id} opens it again; /new or ctrl+t goes elsewhere.`
          : "No thread is open. /new starts one.",
      );
      return;
    }
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
      if (native) {
        // The harness runs your skills, such as /sol-loop; its own commands stay its own.
        if (!thread) throw new Error("No session is running.");
        await this.#client.call("thread.command", {
          threadId: thread.id,
          command: native,
          args: arg.trim(),
        });
        return;
      }
      this.#notice("warning", `Unknown command /${name}. Type /help for commands.`);
    } catch (error) {
      this.#notice("error", errorMessage(error));
    } finally {
      this.#schedule();
    }
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
      // A hint that is a sentence, as skills' often are, reads as part of the description.
      const hint = command.argumentHint ?? "";
      const short = hint !== "" && hint.length <= HINT_LIMIT;
      entries.push(
        entry(
          short ? `/${command.name} ${hint}` : `/${command.name}`,
          hint && !short ? `${command.description} · takes: ${hint}` : command.description,
          { group: "Skills" },
        ),
      );
    }
    for (const [keys, description] of KEYS)
      entries.push(entry(keys, description, { group: "Keys", inert: true }));
    this.#panel = {
      kind: "menu",
      menu: new Menu({ title: "Commands", entries, tabs: true, action: "insert", describe: true }),
      onDone: (index) => {
        if (index === null) return;
        // Into the composer, to add to or send; a command that does something now waits for enter.
        const ownCommand = own[index];
        const nativeCommand = native[index - own.length];
        const name = ownCommand?.name ?? nativeCommand?.name;
        if (!name) return;
        const takes = ownCommand ? Boolean(ownCommand.usage) : Boolean(nativeCommand?.argumentHint);
        this.#editor.set(`/${name}${takes ? " " : ""}`);
        this.#slashDismissed = this.#editor.text;
        this.#syncCompletion();
      },
    };
  }

  #status(): void {
    const info = this.#info;
    const current = this.#current;
    if (!info || !current) return;
    const usage = current.usage;
    const model = info.model ?? this.#defaultModel();
    const rows: [string, string][] = [
      ["Thread", `${current.id}${current.title ? ` · ${current.title}` : ""} · ${current.status}`],
      ["Harness", `${this.#harnessLabel(info.harness)}${info.version ? ` ${info.version}` : ""}`],
      ["Session", info.threadId ?? "starts with your first message"],
      ["Folder", info.cwd],
      [
        "Model",
        `${model ?? "the harness's default"}${info.model === null && model ? " (default)" : ""}${info.effort ? ` · ${info.effort}` : ""}`,
      ],
      ["Mode", `${info.runtimeMode}${info.interactionMode === "plan" ? " · plan" : ""}`],
      ["1harness", `v${this.#version}`],
    ];
    if (usage && usage.contextTokens !== null && usage.contextWindow) {
      const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
      rows.push([
        "Context",
        `${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} (${percent}%)`,
      ]);
    }
    const cost = usage?.costUsd ? formatCost(usage.costUsd) : null;
    if (cost) rows.push(["Cost", cost]);
    const limits = usage?.limits ?? [];
    if (limits.length > 0) rows.push(["Limits", limits.map(describeLimit).join("\n")]);
    rows.push(["Server", this.#serverLine()]);
    this.#panel = { kind: "info", title: "Status", rows };
  }

  /** Where the host runs and keeps its threads, for /status. */
  #serverLine(): string {
    const server = this.#server;
    if (server.inProcess)
      return this.#stored
        ? "in this process: threads stop working when 1harness exits"
        : "in this process, keeping nothing: threads end when 1harness exits";
    const pid = server.pid ? ` · pid ${server.pid}` : "";
    if (server.local) return `this machine${pid} · ${server.address}`;
    return `${server.label}${pid} · ${server.address}${server.identity ? ` · as ${server.identity}` : ""}`;
  }

  /**
   * The model a thread uses when none was chosen, for a harness that names it
   * only once a turn has run: the ID its model list gives its default.
   */
  #defaultModel(): string | null {
    const thread = this.#live;
    if (!thread) return null;
    // Each harness has its own default.
    const key = `${thread.id}\0${thread.harness}`;
    const known = this.#defaultModels.get(key);
    if (known !== undefined) return known;
    // Asked once its session is up; a parked thread's is not started just to name its model.
    if (thread.status === "parked" || thread.status === "starting") return null;
    if (!thread.methods.includes("listModels")) return null;
    this.#defaultModels.set(key, null);
    void (this.#callSession(thread.id, "listModels", []) as Promise<ModelOption[] | null>)
      .then((models) => {
        const option = (models ?? []).find((candidate) => candidate.isDefault);
        const id = option ? (option.aliases[0] ?? option.id) : null;
        this.#defaultModels.set(key, id);
        if (id) this.#schedule();
      })
      .catch(() => {});
    return null;
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
    this.#view.say(level, text);
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
    // Nothing spent yet, or a subscription that does not count it, shows no cost.
    if (usage.costUsd) parts.push(formatCost(usage.costUsd));
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
    if (this.#viewer) {
      this.#renderViewer();
      return;
    }
    const { width, margin } = this.#column();
    const height = this.#screen.rows;
    const context = this.#renderContext();
    const shown = this.#view;
    let footer = this.#footer(width, height);
    const room = Math.max(0, height - footer.rows.length);
    let view = shown.transcript.view(context, room, shown.scroll);
    // A new width or detail setting reflows every row, not just the newest.
    const layout = `${width}:${this.#details}`;
    const reflowed = layout !== this.#layout;
    this.#layout = layout;
    if (shown.scroll > 0 && !reflowed) {
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
    if (reflowed && shown.scroll > Math.max(0, view.total - room)) {
      shown.scroll = Math.max(0, view.total - room);
      view = shown.transcript.view(context, room, shown.scroll);
    }
    // What the mouse finds where: each row's target, and what it selected, shown so.
    this.#targets = view.targets;
    this.#top = view.top;
    this.#shownRows = view.rows;
    this.#liveSeen(view.pictures.map((one) => one.picture));
    const transcript = this.#selection
      ? paintSelection(view.rows, this.#selection, view.top, width)
      : view.rows;
    // The composer sits on the screen's last rows from the first frame to the
    // last; the transcript reads down from the top, and the rows between stay blank.
    const above = [
      ...transcript,
      ...Array.from({ length: Math.max(0, room - transcript.length) }, () => ""),
    ];
    this.#listAt = footer.list
      ? { menu: footer.list.menu, row: above.length + footer.list.row }
      : null;
    const cursor = footer.cursor
      ? { row: above.length + footer.cursor.row, column: margin + footer.cursor.column }
      : null;
    const indent = " ".repeat(margin);
    const rows = [...above, ...footer.rows].map((row) => (row === "" ? row : indent + row));
    this.#screen.render(rows, cursor, view.pictures);
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
  #footer(
    width: number,
    height: number,
  ): {
    rows: string[];
    cursor: CursorPosition | null;
    /** The list shown, and the footer row its rows start on. */
    list?: { menu: Menu; row: number };
  } {
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
      rows.push(
        ...wrap(
          style.muted(
            `    your next message runs ${queue.length === 1 ? "it" : "these"} first · /unqueue takes one back`,
          ),
          width,
          "    ",
        ),
      );
    if (queue.length > 0) rows.push("");
    const attention = this.#attention(width);
    if (attention) rows.push(attention, "");

    let cursor: CursorPosition | null = null;
    let list: { menu: Menu; row: number } | undefined;
    if (this.#prompt && !this.#panel) {
      // The rows the footer has left, under the queue and the attention line,
      // less the status line, which keeps the bottom row under a prompt too.
      const rendered = this.#prompt.prompt.render(width, height - rows.length - 2);
      if (rendered.cursor)
        cursor = { row: rows.length + rendered.cursor.row, column: rendered.cursor.column };
      rows.push(...rendered.rows, "", this.#statusLine(width));
    } else {
      const limit = Math.max(1, Math.min(10, Math.floor(height / 3)));
      const layout = this.#editor.layout(`${style.strong("┃")} `, width);
      // An empty composer says what it takes.
      if (this.#editor.empty && !this.#panel) {
        const hint = this.#live?.busy
          ? "Add to the turn, or tab to queue a message"
          : "Ask anything · @ files · / commands";
        layout.rows[0] = truncate(`${style.strong("┃")} ${style.faint(hint)}`, width);
      }
      const start = Math.max(
        0,
        Math.min(layout.cursor.row - limit + 1, layout.rows.length - limit),
      );
      const composer = layout.rows.slice(start, start + limit);
      // Room for a list: the screen less the rows above it, the composer and
      // status line under it, the list's chrome, and a little transcript.
      const listRows = Math.max(3, Math.min(14, height - rows.length - composer.length - 11));
      const listed =
        this.#panel?.kind === "menu"
          ? this.#panel.menu
          : this.#panel
            ? null
            : (this.#slash ?? this.#args?.menu ?? this.#mention?.menu ?? null);
      // Lists and panels open above the composer, which keeps its place at the
      // bottom; the thread list takes the screen above it.
      const panel =
        this.#panel?.kind === "info"
          ? infoPanel(this.#panel.title, this.#panel.rows, width)
          : this.#panel?.kind === "resume"
            ? this.#panel.view.render(
                width,
                Math.max(8, height - rows.length - composer.length - 3),
              )
            : listed
              ? listed.render(width, listRows)
              : [];
      if (listed) list = { menu: listed, row: rows.length };
      if (panel.length > 0) rows.push(...panel, "");
      if (!this.#panel)
        cursor = { row: rows.length + layout.cursor.row - start, column: layout.cursor.column };
      rows.push(...composer, "", this.#statusLine(width));
    }
    if (rows.length > height) {
      const cut = rows.length - height;
      if (cursor) cursor = { ...cursor, row: Math.max(0, cursor.row - cut) };
      return {
        rows: rows.slice(cut),
        cursor,
        ...(list && list.row >= cut ? { list: { ...list, row: list.row - cut } } : {}),
      };
    }
    return { rows, cursor, ...(list ? { list } : {}) };
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
    const left = `${style.attention("◆")} ${style.strong(thread.title || "New thread")}  ${style.attention(what)}${more}`;
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
    if (this.#toast && Date.now() < this.#toast.until)
      return truncate(`${style.added("✓")} ${style.text(this.#toast.text)}`, width);
    const info = this.#info;
    const parts: string[] = [this.#harness];
    if (info) {
      // Until the harness names its model, its default's ID, once its list says it.
      const model = info.model ?? this.#defaultModel();
      if (model) parts.push(model);
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
    else {
      // Threads of your own still open, not the agents they started, which ctrl+t lists
      // under them, nor parked ones, which are earlier threads to resume.
      const open = threads.filter(
        (thread) =>
          thread.id !== this.#currentId &&
          thread.parentId === null &&
          !thread.archived &&
          thread.status !== "parked",
      ).length;
      if (open > 0) parts.push(`${open} other open · ctrl+t`);
    }
    if (!this.#server.local) parts.push(`on ${this.#server.label}`);
    // Subscription limits appear once they need attention.
    for (const limit of this.#current?.usage?.limits ?? []) {
      if (limit.status === "ok") continue;
      parts.push(
        limit.status === "exceeded"
          ? `${limit.label} limit reached`
          : `${limit.label} ${limit.usedPercent === null ? "near limit" : `${Math.round(limit.usedPercent)}%`}`,
      );
    }
    // A closed thread on screen says so first, since it takes no messages.
    const state =
      this.#current?.status === "closed"
        ? `closed · ${info?.runtimeMode ?? this.#settings.runtimeMode}`
        : (info?.runtimeMode ?? this.#settings.runtimeMode);
    let left = `${style.text(state)}${style.muted(` · ${parts.join(" · ")}`)}`;
    if (info?.interactionMode === "plan") left += `${style.muted(" · ")}${style.strong("plan")}`;
    const scroll = this.#view.scroll;
    // The right edge stays whole as the left is cut, so modes the keys toggle go there.
    const right =
      scroll > 0
        ? style.muted(`↓ ${scroll} more lines · pgdn`)
        : this.#details
          ? style.muted("details · ctrl+x")
          : "";
    return spread(left, right, width);
  }
}
