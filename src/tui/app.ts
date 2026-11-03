import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { BUILTIN_COMMANDS, harnessEntry } from "../commands/builtins.ts";
import {
  CommandRegistry,
  completion,
  type CommandContext,
  type CommandDefinition,
  type CommandThread,
  type Completions,
  type PickEntry,
  type Report,
  type SessionHandle,
} from "../commands/registry.ts";
import type {
  HarnessId,
  ModelOption,
  NativeCommand,
  SessionInfo,
  SessionOptions,
  NoticeLevel,
} from "../core/events.ts";
import { looksLikeThreadId, shortThreadId } from "../core/thread-id.ts";
import { errorMessage } from "../core/errors.ts";
import { HARNESS_STATES, contextUsed, formatCost, limitDetail, plural } from "../core/wording.ts";
import type { ClientEvent, HostClient } from "../client/client.ts";
import {
  RpcError,
  SESSION_CALLS,
  type CommandInfo,
  type HelloResult,
  type HarnessInfo,
  type ThreadListing,
  type ThreadState,
  type UiRequest,
} from "../protocol.ts";
import { agentRowOf } from "./agents.ts";
import { FetchCache } from "./cache.ts";
import { Suggestions, inMenuOrder } from "./completion.ts";
import { Editor, applyEditingKey } from "./editor.ts";
import { footerRows, statusLine, type Footer } from "./footer.ts";
import { InputDecoder, WHEEL_ROWS, type InputEvent, type Key } from "./input.ts";
import { LivePages } from "./live.ts";
import { codeBlocks } from "./markdown.ts";
import { ThreadLogs } from "./logs.ts";
import { Menu, entry, type MenuConfig, type MenuEntry } from "./menu.ts";
import { listedEntry, ResumeView, type ResumeEntry } from "./resume.ts";
import { ancestry, family, lastActive, threadEntries } from "./threads.ts";
import { PictureViewer } from "./viewer.ts";
import { Pictures } from "./pictures.ts";
import { Requests } from "./requests.ts";
import { goodbye } from "./goodbye.ts";
import { Screen } from "./screen.ts";
import {
  STATUS_QUERY,
  StatusReporter,
  statusRecords,
  threadStatusInput,
  type ThreadStatusInput,
} from "./program-status.ts";
import { setLightTheme, style } from "./theme.ts";
import { IMAGE_INDENT, type Hit, type RenderContext, type Target } from "./transcript.ts";
import { Mouse, paintSelection } from "./pointer.ts";
import { CELL_QUERY, GRAPHICS_QUERY, PLACEHOLDER_LIMIT, fit } from "./images.ts";
import { ThreadView, type ViewContext } from "./view.ts";

export interface AppOptions {
  /** The host the terminal works through, in this process or a server's. */
  client: HostClient;
  /** The harness the first thread starts on; null asks, as on the first run. */
  harness: HarnessId | null;
  /** The harness the user made their default, which harness picks mark. */
  defaultHarness?: HarnessId | null;
  /** Makes a harness the default, as ctrl+s in a harness pick does; returns where it is kept. */
  setDefault?: (harness: HarnessId) => string;
  /** Told the harness in use as it changes, so the next run can start on it. */
  onHarness?: (harness: HarnessId) => void;
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
const BLINK_MS = 500;
const THEME_TIMEOUT_MS = 150;
// Program status reports go out at most this often, coalescing bursts of events.
const STATUS_INTERVAL_MS = 250;
// Input held for the rest of a split escape sequence is released after this.
const SEQUENCE_TIMEOUT_MS = 40;
// The SDK warns that full access skips canUseTool, which 1harness keeps for later mode changes.
const IGNORED_STDERR = [/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, /^\(Use `node --trace-warnings/];

/** The host's errors for a thread it does not have open. */
const NO_THREAD = new Set(["thread_not_found", "thread_closed"]);

/** A command's pick entry as a menu row. */
function pickEntry(item: PickEntry): MenuEntry {
  return entry(item.label, item.detail ?? "", {
    tag: item.tag ?? "",
    ...(item.group ? { group: item.group } : {}),
  });
}

/** The message the composer's text sends, `//` making one that starts with `/`; null for a command. */
function messageText(text: string): string | null {
  if (text.startsWith("//")) return text.slice(1);
  return text.startsWith("/") ? null : text;
}

export class App {
  #in = process.stdin;
  #screen = new Screen(process.stdout);
  #decoder = new InputDecoder();
  #editor = new Editor();
  /** The host, and every thread's state as it last said. */
  #client: HostClient;
  /** The harness and settings the next thread starts with; empty until chosen. */
  #harness: HarnessId;
  /**
   * The harness the next run starts on, without a default: the last one told
   * to `onHarness`. Unset at first, so a harness -H named counts too.
   */
  #lastHarness: HarnessId | null = null;
  #defaultHarness: HarnessId | null;
  #setDefault: AppOptions["setDefault"];
  #onHarness: AppOptions["onHarness"];
  /** Harness states already told of, so each is said once. */
  #toldHarness = new Set<string>();
  #settings: SessionOptions;
  #version: string;
  #views = new Map<string, ThreadView>();
  /** What shows before the first thread starts; the first thread then takes it over. */
  #home = new ThreadView("home");
  #homeTaken = false;
  #currentId: string | null = null;
  /** Threads this terminal has seen created, whose views it built from the start. */
  #known = new Set<string>();
  /** Threads' logs, loaded into views of threads the terminal did not see start. */
  #logs: ThreadLogs;
  /** Threads this terminal opened or showed, which its program status covers. */
  #own = new Set<string>();
  /** The line a thread being opened shows first, such as "New codex thread". */
  #announce: string | null = null;
  /** Lists that commands keep for the thread, such as models, fetched on first use. */
  #lookups = new FetchCache<string, unknown[]>({ arrived: () => this.#suggested() });
  /** 1harness's commands, the host's included. */
  #commands = new CommandRegistry();
  /** The host's commands, such as extensions', as registered here. */
  #hostCommands: (() => void)[] = [];
  /** Completions the host gave for its commands, by command and arguments. */
  #completions = new FetchCache<string, Completions | null>({ arrived: () => this.#suggested() });
  #context: CommandContext;
  #warnings: string[];
  #notes: string[];
  /** Commands the harness runs itself, shown beside 1harness's own. */
  #nativeCommands: NativeCommand[] = [];
  /** The commands version of the thread on screen whose commands were last loaded. */
  #commandsSeen = -1;
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
  /**
   * ONEHARNESS_IMAGES and ONEHARNESS_PROGRAM_STATUS, read once: `1` or `0`
   * says whether the terminal shows pictures or takes status reports, over
   * what it replies.
   */
  #setting = {
    images: process.env["ONEHARNESS_IMAGES"],
    status: process.env["ONEHARNESS_PROGRAM_STATUS"],
  };
  /** Images, pages, and figures, drawn for the transcript where the terminal shows pictures. */
  #pictures: Pictures;
  /** What the last frame's transcript rows do when clicked, by screen row. */
  #targets: (Hit | null)[] = [];
  /** Whether the host runs pages live, scripts and all. */
  #liveHost = false;
  #livePages: LivePages;
  /** The list the last frame showed, and the screen row its rows start on, so a click can choose. */
  #listAt: { menu: Menu; row: number } | null = null;
  /** Text selected with the mouse, and the clicks it makes. */
  #pointer: Mouse;
  /** A word in the status line for a moment, such as what was copied. */
  #toast: { text: string; until: number } | null = null;
  /** A picture on the whole screen, opened by a click on it. */
  #viewer: PictureViewer | null = null;
  /** The default model's ID by thread, for a harness that names it only once a turn runs. */
  #defaultModels = new FetchCache<string, string | null>({
    arrived: (id) => {
      if (id) this.#schedule();
    },
  });

  /** What the harnesses ask, from every thread, and the prompt for the thread on screen's. */
  #requests: Requests;
  #panel:
    | {
        kind: "menu";
        menu: Menu;
        /** `save` when ctrl+s chose it. */
        onDone: (index: number | null, save?: boolean) => void;
        /** The host's pick request it answers. */
        pick?: string;
        /** Called instead of `onDone` when another list takes the panel. */
        onReplaced?: () => void;
      }
    | { kind: "info"; title: string; rows: [string, string][] }
    | { kind: "resume"; view: ResumeView; onDone: (id: string | null) => void }
    | { kind: "lineage"; view: ResumeView }
    | null = null;
  /** The host's progress lines, by request. */
  #progress = new Map<string, (level: NoticeLevel, text: string) => void>();
  /** The lists that open under the composer: commands, their words, and files. */
  #suggestions: Suggestions;

  #exitArmed = false;
  #exitTimer: NodeJS.Timeout | null = null;
  #exiting = false;
  /** Undoes what the App hooked into the process, once it exits. */
  #unlisten: (() => void)[] = [];
  /** When the terminal last took a key, of any kind. */
  #typedAt = 0;
  /** The state of the thread last shown, as whatever showed it had it. */
  #shownState: ThreadState | null = null;
  /** Whether the composer's text came from history, so ↑↓ keep walking it. */
  #recalled = false;
  /** The thread shown when its first state arrived, while an open or resume waited on its reply. */
  #openedId: string | null = null;
  /** Opens and resumes waiting on their replies. */
  #opening = 0;
  /** Until the first open or resume settles, which the composer takes input before. */
  #starting = true;
  /** Messages sent while a thread was still opening, for it once it opens. */
  #held: string[] = [];
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
    this.#harness = options.harness ?? "";
    this.#defaultHarness = options.defaultHarness ?? null;
    this.#setDefault = options.setDefault;
    this.#onHarness = options.onHarness;
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
    this.#livePages = new LivePages({
      client: this.#client,
      redraw: () => this.#redrawViews(),
      schedule: () => this.#schedule(),
      warn: (text) => this.#notice("warning", text),
      focused: () => this.#focused,
    });
    this.#pictures = new Pictures({
      client: this.#client,
      live: this.#livePages,
      liveHost: () => this.#liveHost,
      columnWidth: () => this.#screen.columns,
      screenRows: () => this.#screen.rows,
      redraw: () => this.#redrawViews(),
    });
    this.#logs = new ThreadLogs({
      client: this.#client,
      views: this.#views,
      newView: (id) => this.#newView(id, id === this.#currentId),
      replaced: (old, view) => {
        // The startup view keeps being the startup view.
        if (old === this.#home) this.#home = view;
      },
      renderContext: () => this.#renderContext(),
      notice: (level, text) => this.#notice(level, text),
      schedule: () => this.#schedule(),
    });
    this.#suggestions = new Suggestions({
      client: this.#client,
      editor: this.#editor,
      commands: this.#commands,
      context: this.#context,
      available: () => this.#available(),
      isAvailable: (command) => this.#isAvailable(command),
      skills: () => this.#nativeCommands,
      cwd: () => this.#cwd(),
      submit: (text) => this.#submit(text),
      notice: (level, text) => this.#notice(level, text),
      schedule: () => this.#schedule(),
    });
    this.#pointer = new Mouse({
      width: () => this.#screen.columns,
      scrollBy: (rows) => this.#scrollBy(rows),
      scrolled: () => this.#view.scroll,
      rows: (from, to) =>
        this.#view.transcript.view(
          this.#renderContext(),
          to - from + 1,
          Math.max(0, this.#view.total - to - 1),
        ).rows,
      click: (row, column) => this.#click(row, column),
      copy: (text, said) => this.#copy(text, said),
      schedule: () => this.#schedule(),
    });
    this.#requests = new Requests({
      client: this.#client,
      currentId: () => this.#currentId,
      typedAt: () => this.#typedAt,
      prompted: () => {
        this.#view.scroll = 0;
      },
      notice: (level, text) => this.#notice(level, text),
      schedule: () => this.#schedule(),
    });
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
          this.#pick(title, entries.map(pickEntry), {
            initial: options?.initial ?? 0,
            filter: options?.filter ?? false,
            tabs: options?.tabs ?? false,
            ...(options?.save ? { save: options.save.hint, onSave: options.save.run } : {}),
          }),
        progress: (text) => {
          const view = this.#view;
          const line = view.say("info", text);
          this.#schedule();
          return (level, outcome) => {
            line.level = level;
            line.text = outcome;
            // Loading earlier turns may have built the view again around the same line.
            for (const shown of new Set([view, ...this.#allViews()])) shown.transcript.touch(line);
            this.#schedule();
          };
        },
        setInput: (text) => this.#editor.set(text),
        threads: (query) => this.#switchThread(query),
        lineage: () => this.#lineage(),
      },
      session: () => {
        const live = this.#live;
        if (!live) throw new Error("No session is running. Use /new to start one.");
        return this.#sessionHandle(live);
      },
      harnesses: () => this.#client.harnesses,
      checkHarnesses: () => this.#client.call("harnesses.list", {}),
      ...(this.#setDefault
        ? { setDefaultHarness: (harness: HarnessId) => this.#setDefaultHarness(harness) }
        : {}),
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
          ...(options.model !== undefined
            ? { model: options.model, effort: options.effort ?? null }
            : {}),
        });
      },
      switchHarness: (harness, options) => this.#switchHarness(harness, options?.fresh === true),
      exit: () => this.#exit(),
      operations: () => this.#client.call("operations.list", { threadId: this.#currentId }),
      runOperation: async (name, input) =>
        (await this.#client.call("operations.call", { name, input, threadId: this.#currentId }))
          .result,
    } satisfies Omit<CommandContext, "harness" | "defaultHarness" | "thread" | "info">;
    // Read live, since the thread changes under a command that outlives it.
    return Object.defineProperties(context, {
      harness: { get: () => this.#harness },
      defaultHarness: { get: () => this.#defaultHarness },
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
          this.#notice("info", `Renamed ${shortThreadId(current.id)}: ${args}`);
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
            const last = codeBlocks(text).at(-1);
            if (!last) throw new Error("The last reply has no code block");
            text = last.code;
          }
          const lines = plural(text.split("\n").length, "line");
          this.#copy(text, `Copied ${args === "code" ? "the code block" : "the reply"}, ${lines}`);
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
          this.#notice("info", `Closed ${shortThreadId(thread.id)} ${thread.title}`.trim());
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
    if (!this.#harness) {
      const chosen = await this.#chooseHarness();
      if (!chosen) {
        await this.#exit();
        return undefined;
      }
      this.#harness = chosen;
    }
    const resume = this.#settings.resume;
    if (resume) await this.#resume(resume, this.#harness);
    else await this.#open(this.#harness, this.#settings, false);
    this.#starting = false;
    // The prompt given on start goes first; it was there before anything typed.
    if (initial.trim() !== "") this.#submit(initial);
    this.#releaseHeld();
    await this.#done;
    return this.#next;
  }

  /**
   * Asks the terminal for its background and whether it takes program status
   * reports, and whether it shows pictures and its cells' size in pixels; the
   * device attributes reply, which every terminal sends, bounds the wait.
   * ONEHARNESS_THEME, ONEHARNESS_PROGRAM_STATUS, and ONEHARNESS_IMAGES set
   * them instead.
   */
  async #detectTerminal(): Promise<void> {
    const theme = process.env["ONEHARNESS_THEME"];
    const themeSet = theme === "light" || theme === "dark";
    if (themeSet) setLightTheme(theme === "light");
    const { status, images } = this.#setting;
    if (status === "1") this.#enableStatus();
    // Images: whether the terminal speaks the Kitty graphics protocol, and its cell size.
    if (images === "1") this.#pictures.graphics = true;
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
    if (this.#pictures.graphics && this.#setting.images !== "0" && !this.#exiting)
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
    const threads = this.#client.threads;
    const parent = (thread: ThreadState) =>
      thread.parentId ? threads.get(thread.parentId) : undefined;
    return [...threads.values()].filter((thread) =>
      ancestry(thread, parent).some((one) => this.#own.has(one.id)),
    );
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

  /** Gives the terminal back as it was: no status records, its own screen, and cooked input. */
  #restoreTerminal(): void {
    this.#programStatus?.clear();
    this.#screen.leave();
    if (this.#in.isTTY) this.#in.setRawMode(false);
  }

  /** Restores the terminal however the process ends. */
  #guard(): void {
    const restore = () => {
      this.#restoreTerminal();
      if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
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
    const before = { harness: this.#harness, settings: this.#settings };
    const opened = await this.#opened({
      announce: settings.resume
        ? `Resuming ${harness} thread ${settings.resume}`
        : announce
          ? `New ${harness} thread`
          : null,
      // The host announces the thread as it starts, which shows it.
      call: () => this.#client.call("thread.open", { harness, settings }),
      again: false,
      failed: () => {
        this.#harness = before.harness;
        this.#settings = before.settings;
        return `Could not start ${harness}`;
      },
      // A thread on the harness that was in use; the same harness again would only fail again.
      fallback:
        fallback && before.harness !== harness
          ? () => this.#open(before.harness, { ...before.settings, resume: null }, false, false)
          : null,
    });
    // As asked for, since the harness may not report them all yet.
    if (opened) this.#settings = { ...settings, resume: null };
  }

  /** Opens an earlier thread: 1harness's own, by its ID or the start of it, or a harness's by its ID. */
  async #resume(id: string, harness: HarnessId): Promise<void> {
    await this.#opened({
      announce: `Resuming ${id}`,
      call: () =>
        this.#client.call("thread.resume", {
          id,
          harness,
          settings: { ...this.#settings, resume: null },
        }),
      again: true,
      failed: () => `Could not resume ${id}`,
      fallback: () => this.#open(harness, { ...this.#settings, resume: null }, false),
    });
  }

  /**
   * Shows the thread `call` opens, unless the user went elsewhere meanwhile;
   * `again` shows it even where its first state already did. If it cannot
   * open, the user is back where they were, or, with nothing to go back to,
   * on what `fallback` opens to type in, and `failed` says what went wrong.
   * Returns whether it opened.
   */
  async #opened(how: {
    announce: string | null;
    call: () => Promise<ThreadState>;
    again: boolean;
    failed: () => string;
    fallback: (() => Promise<void>) | null;
  }): Promise<boolean> {
    const previous = this.#current;
    const startedOn = this.#currentId;
    this.#openedId = null;
    this.#announce = how.announce;
    this.#opening++;
    try {
      const state = await how.call().finally(() => {
        this.#opening--;
      });
      if (this.#stayed(startedOn) && (how.again || this.#currentId !== state.id)) this.#show(state);
      return true;
    } catch (error) {
      const failure = how.failed();
      const stayed = this.#stayed(startedOn);
      const back = stayed && previous !== undefined && this.#showIfOpen(previous.id);
      if (stayed && !back && !this.#live && how.fallback) await how.fallback();
      this.#notice("error", `${failure}: ${errorMessage(error)}`);
      return false;
    } finally {
      this.#announce = null;
      this.#releaseHeld();
    }
  }

  /** Sends what was held for the thread being opened, or hands it back if none opened. */
  #releaseHeld(): void {
    if (this.#starting || this.#opening > 0 || this.#held.length === 0) return;
    const held = this.#held.splice(0);
    if (this.#live) {
      // Queued rather than steered, so each is its own turn, as typed.
      for (const text of held) this.#send(text, false);
    } else
      this.#editor.set([...held, this.#editor.text].filter((text) => text.trim()).join("\n\n"));
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
      // A server sends every error as an RpcError, so the code tells which.
      if (error instanceof RpcError && NO_THREAD.has(error.code))
        this.#notice("error", errorMessage(error));
    }
  }

  /**
   * Shows a thread by its ID, or picks one from the thread list, or, given
   * words, from the threads whose titles or transcripts mention them.
   */
  async #switchThread(args: string): Promise<void> {
    const words = args.trim();
    const named = looksLikeThreadId(words) ? words : null;
    if (named) {
      await this.#goTo(named);
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
   * The thread list: each of your threads by what it is doing, newest first.
   * With `words`, the threads that mention them. The agents threads started
   * show only in /lineage.
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
        if (thread.parentId === null && !seen.has(thread.id)) seen.set(thread.id, thread);
      entries = [...seen.values()].map(listedEntry);
      if (entries.length === 0 && !loading.dismissed()) {
        this.#notice("info", `No thread mentions ${words}.`);
        return;
      }
    } else entries = await this.#threadEntries();
    if (loading.dismissed()) return;
    if (entries.length === 0) {
      this.#notice("info", "No threads yet.");
      return;
    }
    loading.clear();
    await this.#openFrom(
      new ResumeView(words ? `Threads mentioning ${words}` : "Resume", entries, {
        initial: this.#currentId,
        cwd: this.#cwd(),
        home: homedir(),
        // What mentions the words, from every folder.
        ...(words ? { all: true } : {}),
      }),
    );
  }

  /**
   * /lineage: the agents under the thread of yours the one on screen came
   * from, in the thread list's layout, kept up to date, to go in and out of.
   */
  async #lineage(): Promise<void> {
    if (this.#panel?.kind === "menu") {
      this.#notice("info", "Answer the open list first; then /lineage shows the agents.");
      return;
    }
    // Agents that finished are closed, so only the store still lists them.
    const stored = await this.#client.call("threads.list", { scope: "recent", limit: 200 });
    const agents = () => family(stored, this.#client.threads.values(), this.#currentId);
    const view = new ResumeView(agents().title || "Agents", () => agents().agents, {
      // On the thread they came from, the first agent; on an agent, that one.
      initial: this.#currentId,
      cwd: this.#cwd(),
      home: homedir(),
      lineage: true,
    });
    this.#panel = { kind: "lineage", view };
    this.#schedule();
  }

  /** Shows a thread if it is open; returns whether it was. */
  #showIfOpen(id: string): boolean {
    const thread = this.#client.threads.get(id);
    if (!thread || thread.status === "closed") return false;
    this.#show(thread);
    return true;
  }

  /** Puts a thread on screen, opening it again if it has closed. */
  async #goTo(id: string): Promise<void> {
    if (id === this.#currentId) return;
    if (!this.#showIfOpen(id)) await this.#resume(id, this.#harness);
  }

  /** Shows a thread list and opens the thread chosen from it. */
  async #openFrom(view: ResumeView): Promise<void> {
    const chosen = await new Promise<string | null>((resolve) => {
      this.#panel = { kind: "resume", view, onDone: resolve };
      this.#schedule();
    });
    if (chosen) await this.#goTo(chosen);
  }

  /**
   * Your threads, newest first, each followed by the agents it started, at
   * their depths, oldest first; then your archived threads.
   */
  async #threadEntries(): Promise<ResumeEntry[]> {
    // Listed first: the host names threads for their harness's titles as it lists them,
    // and the open threads are read once those names have come.
    const [recent, archived] = await Promise.all([
      this.#client.call("threads.list", { scope: "recent", limit: 100 }),
      this.#client.call("threads.list", { scope: "archived", limit: 100 }),
    ]);
    return threadEntries(recent, archived, this.#client.threads.values(), this.#currentId);
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
    if (!this.#views.has(thread.id)) void this.#logs.load(thread.id);
    // Opening a thread shows what it finished.
    this.#statusChanged();
    this.#requests.shown(thread.id);
    // /new and /harness start from the thread on screen.
    const info = thread.info;
    this.#harness = thread.harness;
    this.#tellHarness();
    // Agents a thread started run where it chose, not where the user works.
    if (thread.parentId === null && thread.harness !== this.#lastHarness) {
      this.#lastHarness = thread.harness;
      try {
        this.#onHarness?.(thread.harness);
      } catch (error) {
        this.#notice(
          "warning",
          `Could not keep ${thread.harness} for next time: ${errorMessage(error)}`,
        );
      }
    }
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

  /** What the transcript renders with: the screen's width, and what is on. */
  #renderContext(): RenderContext {
    return {
      width: this.#screen.columns,
      cwd: this.#cwd(),
      blink: this.#blinkOn,
      now: Date.now(),
      details: this.#details,
      media: this.#pictures.media(),
      figure: (figure, columns) => this.#pictures.figure(figure, columns),
      image: (path) => this.#pictures.image(path),
      html: (html, columns) => this.#pictures.page(html, columns),
      threadTitle: (threadId: string) => this.#client.threads.get(threadId)?.title || null,
    };
  }

  /** Every view, the startup one among them. */
  #allViews(): Set<ThreadView> {
    return new Set([this.#home, ...this.#views.values()]);
  }

  /** Draws every view again, as when a picture they wait for comes. */
  #redrawViews(): void {
    for (const view of this.#allViews()) view.transcript.invalidate();
    this.#schedule();
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
      this.#suggestions.sync();
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
      this.#suggestions.sync();
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
    const threadId = this.#currentId;
    return (
      this.#completions.get(`${name}\0${args}`, () =>
        this.#client.call("commands.complete", { threadId, name, args }).catch(() => null),
      ) ?? null
    );
  }

  /** Opens the lists under the composer again, for what they show that has come. */
  #suggested(): void {
    this.#suggestions.sync();
    this.#schedule();
  }

  async #exit(): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    const current = this.#current;
    this.#requests.clear();
    // What was still working, before a host in this process stops it on the way out.
    const working = this.#ownThreads().filter(
      (thread) => thread.busy && thread.status !== "closed",
    );
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
    this.#livePages.stop();
    this.#restoreTerminal();
    if (this.#stderrWrite) process.stderr.write = this.#stderrWrite;
    this.#in.pause();
    for (const undo of this.#unlisten.splice(0)) undo();
    const said = goodbye({
      next: this.#next,
      server: this.#server,
      stored: this.#stored,
      current,
      working,
    });
    for (const line of said) process.stdout.write(style.muted(`${line}\n`));
    this.#exited();
  }

  #suspend(): void {
    // A suspended 1harness reports nothing; its records come back when it resumes.
    this.#restoreTerminal();
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
        this.#logs.forget(event.threadId);
        this.#requests.drop(event.threadId);
        this.#own.delete(event.threadId);
        if (this.#shownState?.id === event.threadId) this.#shownState = null;
        if (this.#currentId === event.threadId) {
          // Gone from under the terminal, as when another forgets it: on to another open one.
          this.#currentId = null;
          const next = [...this.#client.threads.values()]
            .filter(
              (thread) =>
                thread.status !== "closed" && thread.parentId === null && !thread.archived,
            )
            .toSorted((a, b) => lastActive(b) - lastActive(a))[0];
          // An open or resume under way goes back on its own if it fails.
          if (next && this.#opening === 0) this.#show(next);
        }
        this.#statusChanged();
        break;
      }
      case "entry": {
        if (!this.#logs.live(event.threadId, { seq: event.seq, entry: event.entry })) break;
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
      case "harnesses":
        this.#tellHarness();
        break;
      case "ui":
        this.#ui(event.request);
        break;
      case "ui.done":
        if (this.#panel?.kind === "menu" && this.#panel.pick === event.id) this.#panel = null;
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

  /** The host caught the terminal up after it missed events; every view is built again. */
  #resynced(hello: HelloResult): void {
    const current = this.#currentId;
    // Loads begun before this catch-up read the old feed; their results are dropped.
    this.#logs.resync();
    const restarted = this.#instance !== null && hello.instance !== this.#instance;
    this.#instance = hello.instance;
    this.#stored = hello.store !== null;
    this.#registerHostCommands(hello.commands);
    this.#views.clear();
    this.#unloaded.clear();
    this.#homeTaken = true;
    this.#requests.clear();
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
    if (shown) void this.#logs.load(shown.id).then(say);
    else {
      this.#currentId = null;
      say();
    }
    // The host it caught up with may be a new one, which has to be told what is on screen.
    void this.#client.call("client.show", { threadId: this.#currentId }).catch(() => {});
    for (const request of hello.pending) this.#ui(request);
    this.#requests.next();
  }

  /** Keeps the open requests in step with a thread's. */
  #syncRequests(thread: ThreadState): void {
    this.#requests.sync(thread);
    // Calls waiting for an answer say so, rather than seem to run.
    this.#views.get(thread.id)?.awaiting(thread.requests);
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
        void this.#pick(request.title, request.entries.map(pickEntry), {
          initial: request.initial,
          filter: request.filter,
          tabs: request.tabs,
          pick: request.id,
        }).then((index) =>
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

  /** Shows a list to choose from; `pick` is the host's request it answers, when the host asked. */
  #pick(
    title: string,
    entries: MenuEntry[],
    config: Partial<MenuConfig> & { pick?: string; onSave?: (index: number) => void } = {},
  ): Promise<number | null> {
    const { pick, onSave, ...menu } = config;
    return new Promise((resolve) => {
      if (entries.length === 0) {
        resolve(null);
        return;
      }
      // The menu this one replaces is dismissed, which answers a host waiting on it;
      // the same pick shown again, after a resync, is still waited on.
      const replaced = this.#panel;
      if (replaced?.kind === "menu" && !(pick && replaced.pick === pick)) {
        this.#panel = null;
        if (replaced.onReplaced) replaced.onReplaced();
        else replaced.onDone(null);
      }
      this.#panel = {
        kind: "menu",
        menu: new Menu({ ...menu, title, entries }),
        onDone: (index, save) => {
          if (save && index !== null) onSave?.(index);
          resolve(index);
        },
        ...(pick ? { pick } : {}),
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
        if (this.#setting.status !== "0") this.#enableStatus();
        return;
      case "focus":
        this.#focused = event.focused;
        if (event.focused) this.#measureCells();
        this.#statusChanged();
        return;
      case "graphics":
        if (this.#setting.images !== "0") this.#pictures.graphics = event.ok;
        return;
      case "cellSize":
        const { cell } = this.#pictures;
        if (event.width === cell.width && event.height === cell.height) return;
        // Pictures are drawn for the cells they fill: each is drawn again for the new ones.
        this.#pictures.cell = { width: event.width, height: event.height };
        this.#redrawViews();
        return;
      case "background":
        setLightTheme(event.light);
        this.#redrawViews();
        return;
      case "wheel":
        if (this.#viewer) this.#viewer.wheel(event.delta);
        else this.#scrollBy(-event.delta * WHEEL_ROWS);
        return;
      case "mouse":
        this.#mouse(event);
        return;
      case "paste":
        if (this.#viewer?.paste(event.text)) return;
        if (this.#panel?.kind === "resume" || this.#panel?.kind === "lineage") {
          this.#panel.view.paste(event.text);
        } else if (this.#requests.prompt) {
          if (this.#requests.prompt.typing) this.#requests.prompt.paste(event.text);
        } else if (this.#panel?.kind === "menu") {
          this.#panel.menu.paste(event.text);
        } else {
          this.#panel = null;
          this.#editor.insert(event.text);
          this.#suggestions.sync();
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
      this.#viewer.key(key);
      return;
    }
    // A key ends what the mouse selected.
    this.#pointer.clear();
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
      const [asking] = this.#requests.elsewhere();
      const thread = asking ? this.#client.threads.get(asking.threadId) : undefined;
      if (thread) this.#show(thread);
      return;
    }
    // A prompt shows its own request whole; elsewhere, tool calls show whole.
    const prompt = this.#requests.prompt;
    if (key.ctrl && key.name === "x" && !prompt && !this.#panel) {
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
    if ((key.name === "pageup" || key.name === "pagedown") && prompt?.scrolls) {
      prompt.key(key);
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
    if (prompt && this.#panel && this.#panelKey(key)) return;
    if (prompt) {
      this.#requests.key(key, sinceLast);
      return;
    }
    if (this.#panel && this.#panelKey(key)) return;
    // ↑↓ and ctrl+p/n through history go on through entries that open a menu, such as /status.
    const historyKey =
      (!key.ctrl && !key.meta && (key.name === "up" || key.name === "down")) ||
      (key.ctrl && (key.name === "p" || key.name === "n"));
    const walking = this.#recalled && historyKey;
    this.#recalled = walking;
    if (!walking && this.#suggestions.key(key)) return;
    const before = this.#editor.text;
    this.#composerKey(key);
    // A text that history put there; the next ↑↓ walks on.
    if (historyKey && this.#editor.text !== before) this.#recalled = true;
    this.#suggestions.sync();
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
    if (panel.kind === "lineage") {
      const result = panel.view.key(key, Math.max(1, this.#screen.rows - 12));
      if (result?.kind === "close") this.#panel = null;
      // The list stays open over the agent gone into, or the thread come back out to.
      else if (result?.kind === "choose") void this.#goTo(result.id);
      else if (result?.kind === "exit") {
        const parent = this.#current?.parentId;
        if (parent) {
          // Out to an agent, it is selected; out to the thread they came from, the one left stays.
          if (this.#client.threads.get(parent)?.parentId) panel.view.select(parent);
          void this.#goTo(parent);
        } else this.#notice("info", "This is the thread the agents came from.");
      }
      this.#schedule();
      return true;
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
    if (result.kind === "choose") panel.onDone(result.index, result.save === true);
    else panel.onDone(null);
    return true;
  }

  /**
   * A list kept for the thread. The first call starts the fetch and returns
   * nothing; completion menus fill in when it arrives.
   */
  #lookup<T>(key: string, load: () => Promise<T[]>): T[] {
    return (this.#lookups.get(key, load) ?? []) as T[];
  }

  #fetch<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
    return this.#lookups.load(key, load) as Promise<T[]>;
  }

  /** Commands the current session can run: 1harness's in a set order, then the rest, then /quit. */
  #available(): CommandDefinition[] {
    return inMenuOrder(this.#commands.list().filter((command) => this.#isAvailable(command)));
  }

  #isAvailable(command: CommandDefinition): boolean {
    try {
      return command.available?.(this.#context) ?? true;
    } catch {
      return false;
    }
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
          const message = messageText(text);
          // A command runs now, as enter would.
          if (message === null) {
            this.#submit(text);
            return;
          }
          this.#view.scroll = 0;
          this.#editor.take();
          this.#send(message, false);
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

  /** The mouse: the viewer's while it is open, else what it selects in the transcript, or clicks. */
  #mouse(event: Extract<InputEvent, { type: "mouse" }>): void {
    if (this.#viewer) this.#viewer.mouse(event);
    else this.#pointer.event(event);
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
    const live = target.kind === "picture" ? this.#livePages.showing(target.picture) : undefined;
    if (live && target.kind === "picture") {
      const columns = this.#screen.columns - IMAGE_INDENT * 2;
      const size = fit(target.picture, columns, {
        ...this.#pictures.media(),
        maxRows: PLACEHOLDER_LIMIT,
      });
      const across = column - IMAGE_INDENT;
      if (hit.row < size.rows && across >= 0 && across < size.columns) {
        this.#livePages.input(live, {
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
      const lines = plural(target.code.split("\n").length, "line");
      this.#copy(target.code, `Copied the ${target.lang ? `${target.lang} ` : ""}code, ${lines}`);
    } else this.#openViewer(target);
  }

  /** Puts text on the clipboard where the user sits, through the terminal, and says so for a moment. */
  #copy(text: string, said: string): void {
    // OSC 52: the terminal sets the clipboard, the one where you sit, over SSH or Rex too.
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    this.#toast = { text: said, until: Date.now() + TOAST_MS };
    setTimeout(() => this.#schedule(), TOAST_MS + 50);
    this.#schedule();
  }

  /** Opens a picture on the whole screen, drawn again for that size where it can be. */
  #openViewer(target: Extract<Target, { kind: "picture" }>): void {
    this.#pointer.clear();
    this.#viewer = new PictureViewer(target, {
      client: this.#client,
      live: this.#livePages,
      figures: this.#pictures.figures,
      screen: () => ({ columns: this.#screen.columns, rows: this.#screen.rows }),
      media: () => this.#pictures.media(),
      pageSize: () => this.#pictures.pageSize(this.#screen.columns - IMAGE_INDENT * 2),
      copy: (text, said) => this.#copy(text, said),
      schedule: () => this.#schedule(),
      closed: () => {
        this.#viewer = null;
      },
    });
    this.#schedule();
  }

  /** The word in the status line for a moment, while it shows. */
  #toastText(): string | null {
    return this.#toast && Date.now() < this.#toast.until ? this.#toast.text : null;
  }

  /** The viewer's frame: the picture as large as the screen takes, under its name. */
  #renderViewer(viewer: PictureViewer): void {
    const frame = viewer.render(this.#toastText());
    this.#targets = [];
    this.#pointer.drawn([], 0);
    this.#listAt = null;
    this.#screen.render(frame.rows, null, [frame.shown]);
  }

  #scrollBy(rows: number): void {
    const view = this.#view;
    view.scroll = Math.max(0, view.scroll + rows);
    // At the top of what is loaded, the page before it loads.
    if (rows > 0 && this.#currentId && view.scroll >= view.total - this.#screen.rows)
      void this.#logs.loadEarlier(this.#currentId);
  }

  #submit(raw: string): void {
    const text = raw.trim();
    if (text === "") return;
    const message = messageText(text);
    // Behind ones already held too, which a thread shown while it starts must not overtake.
    if (
      message !== null &&
      (this.#held.length > 0 || (!this.#live && (this.#starting || this.#opening > 0)))
    ) {
      this.#editor.take();
      if (this.#held.length === 0) this.#notice("info", "Sent once the thread opens.");
      this.#held.push(message);
      return;
    }
    if (message !== null && !this.#live) {
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
    this.#suggestions.clear();
    this.#view.scroll = 0;
    if (message === null) {
      void this.#command(text);
      return;
    }
    this.#send(message);
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
        this.#suggestions.dismissCommands();
        this.#suggestions.sync();
      },
    };
  }

  /**
   * Asks which harness to start, with where each stands, as on the first run,
   * and keeps the answer for the next. Null when none was chosen.
   */
  async #chooseHarness(): Promise<HarnessId | null> {
    const line = this.#view.say("info", "Checking which harnesses are installed and signed in…");
    this.#renderNow();
    let harnesses: HarnessInfo[];
    try {
      harnesses = await this.#client.call("harnesses.list", {});
      const ready = harnesses.filter((harness) => harness.state === "ready").length;
      line.text = `${ready} of ${harnesses.length} harnesses are ready.`;
    } catch (error) {
      harnesses = this.#client.harnesses;
      line.level = "warning";
      line.text = `Could not check the harnesses: ${errorMessage(error)}`;
    }
    this.#view.transcript.touch(line);
    let saved = false;
    const index = await this.#pick(
      "Which harness should 1harness start?",
      harnesses.map((harness) => pickEntry(harnessEntry(harness, null, this.#defaultHarness))),
      {
        initial: Math.max(
          0,
          harnesses.findIndex((harness) => harness.state === "ready"),
        ),
        filter: true,
        ...(this.#setDefault ? { save: "use and make default", onSave: () => (saved = true) } : {}),
      },
    );
    const chosen = index === null ? undefined : harnesses[index];
    if (!chosen) return null;
    if (saved) this.#setDefaultHarness(chosen.id);
    else
      this.#notice(
        "info",
        `1harness starts ${chosen.label} next time too, as the harness used last; ctrl+s in /harness makes one the default.`,
      );
    return chosen.id;
  }

  /** Makes a harness the one 1harness starts, as ctrl+s in a harness pick does. */
  #setDefaultHarness(harness: HarnessId): void {
    try {
      const where = this.#setDefault?.(harness);
      this.#defaultHarness = harness;
      this.#notice(
        "info",
        `${this.#harnessLabel(harness)} is your default harness${where ? `, in ${where}` : ""}; -H names another for one run.`,
      );
    } catch (error) {
      this.#notice("warning", `Could not make ${harness} the default: ${errorMessage(error)}`);
    }
  }

  /**
   * Says once what stands in the way of the harness in use: that it must sign
   * in, or what is not known of it. One not installed fails to start, which says so.
   */
  #tellHarness(): void {
    const harness = this.#client.harnesses.find((candidate) => candidate.id === this.#harness);
    if (!harness?.detail || (harness.state !== "signed-out" && harness.state !== "unchecked"))
      return;
    const key = `${harness.id}\0${harness.state}\0${harness.detail}`;
    if (this.#toldHarness.has(key)) return;
    this.#toldHarness.add(key);
    const said = (harness.unavailable ?? `${harness.label}: ${harness.detail}`).replace(/\.$/, "");
    if (harness.state === "signed-out")
      this.#notice("warning", `${said}. Once it is, send your message again.`);
    else this.#notice("info", `${said}.`);
  }

  /** A harness, its version, and where it stands, such as that it needs signing in. */
  #harnessStatus(id: HarnessId, version: string | null): string {
    const harness = this.#client.harnesses.find((candidate) => candidate.id === id);
    const state = harness && harness.state !== "unchecked" ? HARNESS_STATES[harness.state] : "";
    const detail = harness?.state === "signed-out" ? harness.detail : null;
    return [`${this.#harnessLabel(id)}${version ? ` ${version}` : ""}`, state, detail]
      .filter(Boolean)
      .join(" · ");
  }

  #status(): void {
    const info = this.#info;
    const current = this.#current;
    if (!info || !current) return;
    const usage = current.usage;
    const model = info.model ?? this.#defaultModel();
    const rows: [string, string][] = [
      ["Thread", `${current.id}${current.title ? ` · ${current.title}` : ""} · ${current.status}`],
      ["Harness", this.#harnessStatus(info.harness, info.version)],
      ["Session", info.threadId ?? "starts with your first message"],
      ["Folder", info.cwd],
      [
        "Model",
        `${model ?? "the harness's default"}${info.model === null && model ? " (default)" : ""}${info.effort ? ` · ${info.effort}` : ""}`,
      ],
      ["Mode", `${info.runtimeMode}${info.interactionMode === "plan" ? " · plan" : ""}`],
      ["1harness", `v${this.#version}`],
    ];
    const context = usage ? contextUsed(usage) : null;
    if (context)
      rows.push(["Context", `${context.used} of ${context.window} (${context.percent}%)`]);
    if (usage?.costUsd) rows.push(["Cost", formatCost(usage.costUsd)]);
    const limits = usage?.limits ?? [];
    if (limits.length > 0) rows.push(["Limits", limits.map(limitDetail).join("\n")]);
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
    // Asked once its session is up; a parked thread's is not started just to name its model.
    const unasked = thread.status === "parked" || thread.status === "starting";
    if (!this.#defaultModels.has(key) && (unasked || !thread.methods.includes("listModels")))
      return null;
    return (
      this.#defaultModels.get(key, () =>
        (this.#callSession(thread.id, "listModels", []) as Promise<ModelOption[] | null>).then(
          (models) => {
            const option = (models ?? []).find((candidate) => candidate.isDefault);
            return option ? (option.aliases[0] ?? option.id) : null;
          },
          () => null,
        ),
      ) ?? null
    );
  }

  #report(report: Report): void {
    this.#view.report(report);
    this.#schedule();
  }

  // Output

  #cwd(): string {
    return this.#info?.cwd ?? this.#settings.cwd;
  }

  #notice(level: NoticeLevel, text: string): void {
    this.#view.say(level, text);
    this.#schedule();
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
      this.#renderViewer(this.#viewer);
      return;
    }
    const width = this.#screen.columns;
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
    this.#pointer.drawn(view.rows, view.top);
    this.#livePages.seen(view.pictures.map((one) => one.picture));
    const selection = this.#pointer.selection;
    const transcript = selection
      ? paintSelection(view.rows, selection, view.top, width)
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
      ? { row: above.length + footer.cursor.row, column: footer.cursor.column }
      : null;
    this.#screen.render([...above, ...footer.rows], cursor, view.pictures);
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

  /** The rows below the transcript, as the footer lays them out for what is on screen. */
  #footer(width: number, height: number): Footer {
    const current = this.#current;
    return footerRows(
      {
        turn: this.#view.turn,
        running: this.#view.transcript.running,
        blink: this.#blinkOn,
        steer: current?.capabilities.steer === true,
        queue: current?.queue ?? [],
        held: current?.held === true,
        waiting: this.#requests.elsewhere(),
        threads: this.#client.threads,
        prompt: this.#requests.prompt,
        panel: this.#panel,
        editor: this.#editor,
        busy: this.#live?.busy === true,
        suggestions: this.#suggestions.menu,
        status: this.#statusLine(width),
      },
      width,
      height,
    );
  }

  #statusLine(width: number): string {
    const current = this.#current;
    return statusLine(
      {
        exitArmed: this.#exitArmed,
        toast: this.#toastText(),
        harness: this.#harness,
        currentId: this.#currentId,
        current,
        // Until the harness names its model, its default's ID, once its list says it.
        model: current ? (current.info.model ?? this.#defaultModel()) : null,
        runtimeMode: this.#settings.runtimeMode,
        threads: this.#client.threads.values(),
        server: this.#server.local ? null : this.#server.label,
        scroll: this.#view.scroll,
        details: this.#details,
      },
      width,
    );
  }
}
