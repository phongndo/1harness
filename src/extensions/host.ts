import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { CommandRegistry, CommandUI, NoticeLevel, ReportSpan } from "../commands/registry.ts";
import type {
  HarnessRequest,
  McpServerConfig,
  RequestResponse,
  ToolPolicy,
  UserInput,
} from "../core/events.ts";
import { loadMcpConfig } from "../core/mcp-config.ts";
import { errorMessage, type Thread, type ThreadEvent } from "../core/thread.ts";
import {
  choose,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionStorage,
  type InputHandler,
  type RequestHandler,
  type ToolCallHandler,
  type ToolDefinition,
} from "./api.ts";
import type { ToolGrant, ToolServer } from "./tool-server.ts";
import { acpDriver, registerDriver } from "../drivers/index.ts";

export type ExtensionScope = "user" | "project" | "flag";

export interface ExtensionSource {
  path: string;
  scope: ExtensionScope;
}

export interface LoadedExtension {
  name: string;
  path: string;
  scope: ExtensionScope;
  /** Why it failed to load, or null. */
  error: string | null;
  commands: string[];
  tools: string[];
}

/** What an extension left behind, undone when it unloads. */
interface Registrations {
  undo: (() => void)[];
  unload: (() => void | Promise<void>)[];
}

// Extensions import the API as `1harness/extension`, wherever they live; it
// resolves to this running copy.
const API_SPECIFIER = "1harness/extension";
const API_URL = new URL(`./api${extname(new URL(import.meta.url).pathname)}`, import.meta.url).href;
let apiMapped = false;

function mapApiImports(): void {
  if (apiMapped) return;
  apiMapped = true;
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === API_SPECIFIER ? { url: API_URL, shortCircuit: true } : next(specifier, context),
  });
}

type AnyEventHandler = (event: ThreadEvent, context: ExtensionContext) => void | Promise<void>;

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Extension modules in a folder: module files, and folders with an `index` module. */
export function findExtensions(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder).toSorted();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(folder, name);
    if (MODULE_EXTENSIONS.has(extname(name)) && !name.endsWith(".d.ts")) {
      found.push(path);
      continue;
    }
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
    const index = [...MODULE_EXTENSIONS]
      .map((extension) => join(path, `index${extension}`))
      .find((candidate) => existsSync(candidate));
    if (index) found.push(index);
  }
  return found;
}

/** The name an extension goes by: its file name, or its folder's for an `index` module. */
export function extensionName(path: string): string {
  const file = basename(path, extname(path));
  return file === "index" ? basename(dirname(path)) : file;
}

/** A JSON file of values, written on every change. */
export class JsonStorage implements ExtensionStorage {
  #file: string;
  #values: Record<string, unknown>;

  /** `legacy` is where the values were kept before, read when `file` has none yet. */
  constructor(file: string, legacy?: string) {
    this.#file = file;
    this.#values = {};
    for (const path of [file, legacy]) {
      if (!path) continue;
      try {
        this.#values = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        break;
      } catch {
        // Not there, or not readable: try the next.
      }
    }
  }

  get<T>(key: string): T | undefined {
    return this.#values[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.#values[key] = value;
    this.#save();
  }

  delete(key: string): void {
    delete this.#values[key];
    this.#save();
  }

  keys(): string[] {
    return Object.keys(this.#values);
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(this.#values, null, 2)}\n`);
  }
}

/** Folders whose `.1harness/extensions` the user has agreed to run. */
export class TrustList {
  #storage: JsonStorage;

  constructor(stateDir: string) {
    this.#storage = new JsonStorage(join(stateDir, "trusted.json"));
  }

  has(folder: string): boolean {
    return (this.#storage.get<string[]>("folders") ?? []).includes(resolve(folder));
  }

  add(folder: string): void {
    const folders = this.#storage.get<string[]>("folders") ?? [];
    if (!folders.includes(resolve(folder)))
      this.#storage.set("folders", [...folders, resolve(folder)]);
  }
}

export interface ExtensionHostOptions {
  /** The folder sessions run in, whose own extensions need trust. */
  cwd: string;
  configDir: string;
  stateDir: string;
  /** Where commands go; null without a client, as with `--print`. */
  commands: CommandRegistry | null;
  /**
   * The UI of the client that shows `thread`, or null when none does, as with
   * `--print`; with a null thread, the UI for notices about extensions.
   */
  ui: CommandUI | null | ((thread: Thread | null) => CommandUI | null);
}

/**
 * Loads extensions and connects what they register: commands to the client's
 * registry, handlers to every thread, and tools to the shared tool server.
 */
export class ExtensionHost {
  readonly extensions: LoadedExtension[] = [];
  /** Tools by name, with the extension that registered each. */
  readonly tools = new Map<string, { extension: string; tool: ToolDefinition }>();
  #options: ExtensionHostOptions;
  #trust: TrustList;
  #events: { extension: string; type: ThreadEvent["type"]; handler: AnyEventHandler }[] = [];
  #inputs: { extension: string; handler: InputHandler }[] = [];
  #requests: { extension: string; handler: RequestHandler }[] = [];
  #toolChecks: { extension: string; handler: ToolCallHandler }[] = [];
  #registrations = new Map<LoadedExtension, Registrations>();
  /** Modules named on the command line, loaded again on reload. */
  #extra: readonly string[] = [];
  /** Bumped on reload so the import cache yields fresh modules. */
  #generation = 0;

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
    this.#trust = new TrustList(options.stateDir);
    options.commands?.register({
      name: "extensions",
      usage: "[trust | reload]",
      description: "list extensions, trust this folder's own, or reload them",
      group: "Tools",
      complete: () => ({
        start: 0,
        items: [
          { value: "trust", detail: "load this folder's .1harness/extensions", more: false },
          { value: "reload", detail: "load every extension again from disk", more: false },
        ],
      }),
      run: async (context, args) => {
        if (args === "trust") await this.trustProject();
        else if (args === "reload") await this.reload();
        else context.ui.report(this.report());
      },
    });
  }

  get #projectFolder(): string {
    return join(this.#options.cwd, ".1harness", "extensions");
  }

  /** Whether the user trusts the folder's own extensions and MCP servers. */
  get trusted(): boolean {
    return this.#trust.has(this.#options.cwd);
  }

  /**
   * The MCP servers 1harness adds to a new session: the shared ones from
   * `mcp.json`, and the tool server when extensions have tools. The grant ties
   * the tool server to the session's thread.
   */
  async sessionServers(tools: ToolServer): Promise<{
    servers: Record<string, McpServerConfig>;
    grant: ToolGrant | null;
    warnings: string[];
  }> {
    const config = loadMcpConfig(this.#options.configDir, this.trusted ? this.#options.cwd : null);
    const grant = await tools.grant(() => this.tools);
    const servers = { ...config.servers, ...(grant ? { "1harness": grant.config } : {}) };
    return { servers, grant, warnings: config.warnings };
  }

  /**
   * The tool policy for a new session, or undefined when no extension checks
   * tool calls, so harnesses that need setup for it are spared. `thread`
   * gives the session's thread once it exists.
   */
  toolPolicy(thread: () => Thread | null): ToolPolicy | undefined {
    if (this.#toolChecks.length === 0) return undefined;
    return async (call) => {
      const current = thread();
      if (!current) return undefined;
      const context = this.#context(current);
      for (const entry of this.#toolChecks) {
        const reason = await this.#guard(entry.extension, () => entry.handler(call, context));
        if (reason) return reason;
      }
      return undefined;
    };
  }

  /** Project extensions waiting for the user to trust the folder. */
  get untrusted(): string[] {
    return this.#trust.has(this.#options.cwd) ? [] : findExtensions(this.#projectFolder);
  }

  /** Loads the user's extensions, the trusted project's, and any named on the command line. */
  async loadAll(extra: readonly string[] = this.#extra): Promise<void> {
    this.#extra = extra;
    const sources: ExtensionSource[] = [
      ...findExtensions(join(this.#options.configDir, "extensions")).map((path) => ({
        path,
        scope: "user" as const,
      })),
      ...(this.#trust.has(this.#options.cwd) ? findExtensions(this.#projectFolder) : []).map(
        (path) => ({ path, scope: "project" as const }),
      ),
      ...extra.map((path) => ({ path: resolve(path), scope: "flag" as const })),
    ];
    for (const source of sources) await this.load(source);
  }

  async trustProject(): Promise<void> {
    this.#trust.add(this.#options.cwd);
    const loaded = new Set(this.extensions.map((extension) => extension.path));
    const paths = findExtensions(this.#projectFolder).filter((path) => !loaded.has(path));
    for (const path of paths) await this.load({ path, scope: "project" });
    this.#notify("info", `Trusted ${this.#options.cwd}; loaded ${paths.length} project extensions`);
  }

  /**
   * Unloads every extension and loads them again from disk, picking up edits
   * and new files. Modules an extension imports itself stay cached. Harnesses
   * see changed tools once they reconnect, as with `/mcp reconnect 1harness`.
   */
  async reload(): Promise<void> {
    await this.close();
    this.#generation++;
    await this.loadAll();
    const failed = this.extensions.filter((extension) => extension.error).length;
    this.#notify(
      failed > 0 ? "warning" : "info",
      `Reloaded ${this.extensions.length} extensions${failed > 0 ? `; ${failed} failed` : ""}`,
    );
  }

  /** Lets every extension clean up, then removes what each registered. */
  async close(): Promise<void> {
    // Newest first, the reverse of loading; each unload removes its record.
    for (const record of this.extensions.toReversed()) await this.#unload(record);
  }

  async load(source: ExtensionSource): Promise<LoadedExtension> {
    const name = extensionName(source.path);
    const record: LoadedExtension = { ...source, name, error: null, commands: [], tools: [] };
    this.extensions.push(record);
    this.#registrations.set(record, { undo: [], unload: [] });
    if (this.extensions.some((other) => other !== record && other.name === name && !other.error)) {
      record.error = `another extension is named ${name}`;
    } else {
      try {
        mapApiImports();
        const url = pathToFileURL(source.path);
        if (this.#generation > 0) url.searchParams.set("reload", String(this.#generation));
        const module = (await import(url.href)) as { default?: unknown };
        if (typeof module.default !== "function") throw new Error("no default export function");
        await (module.default as (api: ExtensionAPI) => unknown)(this.#api(record));
      } catch (error) {
        record.error = errorMessage(error);
      }
    }
    if (record.error) this.#notify("warning", `Extension ${name} did not load: ${record.error}`);
    return record;
  }

  /** Connects the extensions' handlers to a thread; returns a function that disconnects them. */
  attach(thread: Thread): () => void {
    const context = this.#context(thread);
    const unsubscribe = thread.subscribe((event) => {
      for (const entry of this.#events) {
        if (entry.type !== event.type) continue;
        void this.#guard(entry.extension, () => entry.handler(event, context));
      }
    });
    const removeInput = thread.addInputHandler((input) => this.#filterInput(input, context));
    const removeRequest = thread.addRequestHandler((request) => this.#answer(request, context));
    return () => {
      unsubscribe();
      removeInput();
      removeRequest();
    };
  }

  async #unload(record: LoadedExtension): Promise<void> {
    const registrations = this.#registrations.get(record);
    for (const unload of registrations?.unload ?? []) await this.#guard(record.name, unload);
    for (const undo of registrations?.undo ?? []) undo();
    this.#registrations.delete(record);
    const others = <T extends { extension: string }>(entries: T[]) =>
      entries.filter((entry) => entry.extension !== record.name);
    this.#events = others(this.#events);
    this.#inputs = others(this.#inputs);
    this.#requests = others(this.#requests);
    this.#toolChecks = others(this.#toolChecks);
    this.extensions.splice(this.extensions.indexOf(record), 1);
  }

  /** What `/extensions` shows. */
  report(): { title: string; lines: ReportSpan[][] } {
    const lines: ReportSpan[][] = [];
    if (this.extensions.length === 0) lines.push([{ text: "No extensions loaded", tone: "muted" }]);
    const width = Math.max(0, ...this.extensions.map((extension) => extension.name.length));
    for (const extension of this.extensions) {
      const parts = [
        ...extension.commands.map((name) => `/${name}`),
        ...extension.tools.map((name) => `tool ${name}`),
      ];
      lines.push([
        { text: `${extension.name.padEnd(width)}  `, tone: "strong" },
        { text: `${extension.scope.padEnd(7)}  `, tone: "muted" },
        extension.error
          ? { text: extension.error, tone: "bad" }
          : { text: parts.join(", ") || "handlers only", tone: "soft" },
      ]);
    }
    const waiting = this.untrusted.length;
    if (waiting > 0) {
      lines.push(
        [],
        [
          {
            text: `${waiting} project ${waiting === 1 ? "extension is" : "extensions are"} not loaded until you trust this folder: /extensions trust`,
            tone: "muted",
          },
        ],
      );
    }
    return { title: "Extensions", lines };
  }

  /**
   * Where an extension keeps its values: the user's and named ones by name, a
   * project's under its folder, so two projects' extensions of one name keep
   * their own.
   */
  #storageFile(record: LoadedExtension): string {
    const folder = join(this.#options.stateDir, "extensions");
    if (record.scope !== "project") return join(folder, `${record.name}.json`);
    const project = createHash("sha256").update(this.#options.cwd).digest("hex").slice(0, 16);
    return join(folder, "projects", project, `${record.name}.json`);
  }

  #api(record: LoadedExtension): ExtensionAPI {
    const extension = record.name;
    return {
      name: extension,
      storage: new JsonStorage(
        this.#storageFile(record),
        // A project's extensions kept their values by name alone before.
        record.scope === "project"
          ? join(this.#options.stateDir, "extensions", `${record.name}.json`)
          : undefined,
      ),
      registerCommand: (command) => {
        if (!this.#options.commands) return;
        this.#registrations.get(record)?.undo.push(this.#options.commands.register(command));
        record.commands.push(command.name);
      },
      registerTool: (tool) => {
        if (!TOOL_NAME.test(tool.name)) throw new Error(`tool name ${tool.name} is not valid`);
        const owner = this.tools.get(tool.name);
        if (owner) throw new Error(`tool ${tool.name} is already registered by ${owner.extension}`);
        const entry = { extension, tool };
        this.tools.set(tool.name, entry);
        this.#registrations.get(record)?.undo.push(() => {
          if (this.tools.get(tool.name) === entry) this.tools.delete(tool.name);
        });
        record.tools.push(tool.name);
      },
      onUnload: (handler) => {
        this.#registrations.get(record)?.unload.push(handler);
      },
      registerDriver: (driver) => {
        this.#registrations.get(record)?.undo.push(registerDriver(driver));
      },
      acpAgent: acpDriver,
      on: (type, handler) => {
        // Only events of `type` reach it, so the narrower parameter is safe.
        this.#events.push({ extension, type, handler: handler as unknown as AnyEventHandler });
      },
      onInput: (handler) => {
        this.#inputs.push({ extension, handler });
      },
      onRequest: (handler) => {
        this.#requests.push({ extension, handler });
      },
      onToolCall: (handler) => {
        this.#toolChecks.push({ extension, handler });
      },
      choose,
    };
  }

  async #filterInput(input: UserInput, context: ExtensionContext): Promise<UserInput | null> {
    let current = input;
    for (const entry of this.#inputs) {
      try {
        const result = await entry.handler(current, context);
        if (result === null) return null;
        if (result) current = result;
      } catch (error) {
        this.#notify("warning", `Extension ${entry.extension} failed: ${errorMessage(error)}`);
      }
    }
    return current;
  }

  async #answer(
    request: HarnessRequest,
    context: ExtensionContext,
  ): Promise<RequestResponse | undefined> {
    for (const entry of this.#requests) {
      const response = await this.#guard(entry.extension, () => entry.handler(request, context));
      if (response) return response;
    }
    return undefined;
  }

  /** Runs extension code, reporting a failure instead of passing it on. */
  async #guard<T>(extension: string, run: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      this.#notify("warning", `Extension ${extension} failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** A handler's context, whose UI is whichever client shows the thread when it asks. */
  #context(thread: Thread): ExtensionContext {
    const ui = () => this.#ui(thread);
    return {
      thread,
      get ui() {
        return ui();
      },
    };
  }

  #ui(thread: Thread | null): CommandUI | null {
    const ui = this.#options.ui;
    return typeof ui === "function" ? ui(thread) : ui;
  }

  #notify(level: NoticeLevel, text: string): void {
    const ui = this.#ui(null);
    if (ui) ui.notify(level, text);
    else if (level !== "info") process.stderr.write(`1harness: ${text}\n`);
  }
}
