import { homedir } from "node:os";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "../../core/async-queue.ts";
import {
  RUNTIME_MODES,
  isRuntimeMode,
  type ApprovalAction,
  type ApprovalOption,
  type ApprovalRequest,
  type Capabilities,
  type FileChange,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessSession,
  type InteractionMode,
  type McpAction,
  type McpActionResult,
  type McpServer,
  type McpServerConfig,
  type ModelOption,
  type NativeCommand,
  type RequestResponse,
  type RuntimeMode,
  type SessionInfo,
  type SessionOptions,
  type ThreadSummary,
  type UserInput,
} from "../../core/events.ts";
import { errorMessage } from "../../core/thread.ts";
import { toolAction } from "../../core/tools.ts";
import { ANSWER, ASK, PLAN_TITLE, askForChanges, planOptions } from "../../core/wording.ts";
import { HookServer } from "./hook-server.ts";
import { INIT_PROMPT } from "./prompts.ts";
import { JsonRpcProcess, RpcError, type RequestId } from "../jsonrpc.ts";
import {
  CodexTranslator,
  codexRequestId,
  codexRuntimePolicy,
  fileChanges,
  grantedRuntimeMode,
  toItem,
  toMcpServer,
  unwrapShell,
  type CodexMcpConfig,
  type CodexMcpStatus,
  type CodexSandboxPolicy,
  type CodexThreadItem,
  type CodexTurn,
} from "./translate.ts";

interface ThreadResponse {
  thread: { id: string; turns: CodexTurn[] };
  model: string;
  reasoningEffort: string | null;
  sandbox: CodexSandboxPolicy;
  initialTurnsPage?: { data: CodexTurn[] } | null;
}

/** A server request waiting on the user, with what is needed to build the native reply. */
interface PendingRequest {
  method: string;
  params: Record<string, unknown>;
  /** The native decision behind each option ID. */
  decisions: Map<string, unknown>;
  resolve: (result: unknown) => void;
}

// Resumed threads show this many recent turns.
const HISTORY_TURNS = 10;
const START_TIMEOUT_MS = 30_000;
// Starting a thread waits for MCP servers, which may install packages first.
const THREAD_TIMEOUT_MS = 120_000;
// The prompt Codex's own UI sends when the user accepts a proposed plan.
const IMPLEMENT_PLAN = "Implement the plan.";
// Settings Codex's own UI turns on: plan updates feed the task list, and MCP
// servers started through npx or uvx get time to come up before the first turn.
const THREAD_CONFIG = {
  "tools.update_plan.enabled": true,
  mcp_optional_startup_grace_ms: 10_000,
};

const CAPABILITIES: Capabilities = {
  steer: true,
  planMode: true,
  runtimeModes: RUNTIME_MODES,
  images: true,
  toolChecks: true,
  nativeSlashCommands: false,
  // Codex turns servers on and off only in its config files.
  mcpActions: ["login", "reconnect"],
};

/**
 * Codex's own UI runs its commands itself, so the driver carries the ones that
 * act on the session through app-server. Left out are those that only change
 * Codex's terminal (/diff, /theme, /copy), those 1harness has its own of
 * (/model, /permissions, /plan, /new, /resume, /compact, /status), and those
 * that manage the installation (/login, /config, /plugins).
 */
const COMMANDS: NativeCommand[] = [
  nativeCommand("review", "review my current changes and find issues", "[instructions]", true),
  nativeCommand("init", "create an AGENTS.md file with instructions for the agent", "", true),
  nativeCommand("rename", "rename the current thread", "<name>", false),
  nativeCommand("ps", "list background terminals", "", false),
  // Codex's /stop, by its other name, since 1harness's /stop interrupts the turn.
  nativeCommand("clean", "stop all background terminals", "", false),
];

// The hook Codex runs before each tool call while an extension checks them. Its
// command is the same every session, so the trust the user gives it once holds.
const HOOK_SCRIPT = fileURLToPath(
  new URL(`./tool-hook${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);
const HOOK_COMMAND = [process.execPath, HOOK_SCRIPT].map(shellQuote).join(" ");

interface CodexHook {
  key: string;
  source: string;
  command?: string;
  trustStatus: string;
  currentHash: string;
}

interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: { shortDescription?: string };
  path: string;
  enabled: boolean;
}

export interface CodexSessionConfig extends SessionOptions {
  command: string;
  version: string;
}

/** Drives `codex app-server`: one process and one Codex thread per session. */
export class CodexSession implements HarnessSession {
  readonly capabilities = CAPABILITIES;
  readonly info: SessionInfo;
  #config: CodexSessionConfig;
  #rpc: JsonRpcProcess | null = null;
  #events = new AsyncQueue<HarnessEvent>();
  #translator = new CodexTranslator();
  #pending = new Map<string, PendingRequest>();
  #fileChanges = new Map<string, FileChange[]>();
  /** Shell processes by command item, for stopping them with the turn. */
  #processes = new Map<string, string>();
  #sandbox: CodexSandboxPolicy | null = null;
  #turnId: string | null = null;
  #startedTurns = new Set<string>();
  #endedTurns = new Set<string>();
  #interruptRequested = false;
  #closing = false;
  /** Skill paths by name, from the last listing. */
  #skills = new Map<string, string>();
  /** Answers Codex's tool-call hook, when an extension checks tool calls. */
  #hooks: HookServer | null = null;
  #threadParams: Record<string, unknown> | null = null;
  #turnsStarted = false;

  constructor(config: CodexSessionConfig) {
    this.#config = config;
    this.info = {
      harness: "codex",
      threadId: config.resume,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      runtimeMode: config.runtimeMode,
      interactionMode: config.interactionMode,
      version: null,
    };
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.#events;
  }

  async start(): Promise<void> {
    const hooks = this.#config.toolPolicy
      ? await HookServer.start((input) => this.#checkTool(input))
      : null;
    this.#hooks = hooks;
    const rpc = new JsonRpcProcess(this.#config.command, ["app-server"], {
      cwd: this.#config.cwd,
      name: "Codex",
      // The hook finds this session through its environment, which Codex passes on.
      env: hooks
        ? { ...process.env, ONEHARNESS_HOOK_URL: hooks.url, ONEHARNESS_HOOK_TOKEN: hooks.token }
        : process.env,
    });
    this.#rpc = rpc;
    rpc.onNotification((method, params) => this.#notification(method, params));
    rpc.onRequest((method, params, id) => this.#serverRequest(method, params, id));
    void rpc.exited.then((reason) => this.#closed(reason));

    const initialized = await rpc.request<{ userAgent: string }>(
      "initialize",
      {
        clientInfo: { name: "1harness", title: "1harness", version: this.#config.version },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "turn/diff/updated",
            "rawResponseItem/completed",
            "rawResponse/completed",
          ],
        },
      },
      START_TIMEOUT_MS,
    );
    rpc.notify("initialized");
    this.info.version = /\/(\d+\.\d+\.\d+\S*)/.exec(initialized.userAgent)?.[1] ?? null;

    const policy = codexRuntimePolicy(this.info.runtimeMode);
    const params = {
      cwd: this.info.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandbox: policy.sandbox,
      config: {
        ...THREAD_CONFIG,
        ...codexMcpConfig(this.#config.mcpServers ?? {}),
        ...(hooks
          ? {
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      {
                        type: "command",
                        command: HOOK_COMMAND,
                        timeout: 15,
                        statusMessage: "Checking with 1harness",
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
      },
      ...(this.info.model ? { model: this.info.model } : {}),
    };
    this.#threadParams = params;
    const response = this.#config.resume
      ? await this.#resume(this.#config.resume, params)
      : await rpc.request<ThreadResponse>("thread/start", params, THREAD_TIMEOUT_MS);

    this.#translator.threadId = response.thread.id;
    this.#sandbox = response.sandbox;
    const granted = response.sandbox
      ? grantedRuntimeMode(this.info.runtimeMode, response.sandbox)
      : this.info.runtimeMode;
    if (granted !== this.info.runtimeMode) {
      this.#notice(
        "warning",
        `Codex's settings do not allow ${this.info.runtimeMode}, so this thread runs in ${granted}`,
      );
      this.info.runtimeMode = granted;
    }
    this.info.threadId = response.thread.id;
    this.info.model = response.model;
    this.info.effort = this.info.effort ?? response.reasoningEffort;
    const turns = response.initialTurnsPage
      ? response.initialTurnsPage.data.toReversed()
      : (response.thread.turns ?? []);
    for (const turn of turns.slice(-HISTORY_TURNS)) {
      // A review's findings are stored twice: as the exited-review item and as a message.
      const messages = new Set(
        turn.items.flatMap((native) =>
          native.type === "agentMessage" ? [(native as { text: string }).text.trim()] : [],
        ),
      );
      for (const native of turn.items) {
        const review = native.type === "exitedReviewMode" ? (native as { review: string }) : null;
        if (review && messages.has(review.review.trim())) continue;
        const item = toItem(native);
        if (item) this.#emit({ type: "item.completed", item });
      }
    }
    this.#emitInfo();
    if (hooks) void this.#trustHook(!this.#config.resume);
  }

  async startTurn(input: UserInput): Promise<void> {
    const [, name = "", args = ""] = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.text.trim()) ?? [];
    if (name === "review") return this.#review(args.trim());
    const id = input.id ?? null;
    if (name === "init") return this.#startTurn([textInput({ text: INIT_PROMPT })], id);
    const skill = this.#skills.get(name);
    // Codex selects a skill by path, as its own UI does for a `$name` mention.
    if (skill)
      return this.#startTurn([...inputItems(input), { type: "skill", name, path: skill }], id);
    await this.#startTurn(inputItems(input), id);
  }

  /** Starts a turn; Codex echoes `clientId` on the user message, so the thread can match it. */
  async #startTurn(input: unknown[], clientId: string | null): Promise<void> {
    this.#turnsStarted = true;
    const policy = codexRuntimePolicy(this.info.runtimeMode, this.#sandbox);
    this.#interruptRequested = false;
    const response = await this.#request<{ turn: CodexTurn }>("turn/start", {
      threadId: this.#threadId(),
      input,
      ...(clientId ? { clientUserMessageId: clientId } : {}),
      cwd: this.info.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandboxPolicy: policy.sandboxPolicy,
      summary: "detailed",
      ...(this.info.model ? { model: this.info.model } : {}),
      ...(this.info.effort ? { effort: this.info.effort } : {}),
      ...(this.info.model
        ? {
            // Codex supplies its own plan-mode instructions; sending "default" leaves plan mode.
            collaborationMode: {
              mode: this.info.interactionMode,
              settings: {
                model: this.info.model,
                reasoning_effort: this.info.effort,
                developer_instructions: null,
              },
            },
          }
        : {}),
    });
    this.#acknowledged(response.turn);
  }

  async steer(input: UserInput): Promise<void> {
    if (this.#turnId === null) throw new Error("No turn is running");
    await this.#request("turn/steer", {
      threadId: this.#threadId(),
      input: inputItems(input),
      ...(input.id ? { clientUserMessageId: input.id } : {}),
      expectedTurnId: this.#turnId,
    });
  }

  async interrupt(): Promise<void> {
    // A stop pressed before Codex reports the turn ID is sent once the ID arrives.
    this.#interruptRequested = true;
    if (this.#turnId !== null) await this.#sendInterrupt(this.#turnId);
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    pending.resolve(codexResponse(pending, response));
    this.#emit({ type: "request.resolved", requestId });
  }

  async setModel(model: string | null): Promise<void> {
    this.info.model = model;
    this.#emitInfo();
  }

  async setEffort(effort: string | null): Promise<void> {
    this.info.effort = effort;
    this.#emitInfo();
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    // Applied on the next turn, which carries its own approval and sandbox policy.
    this.info.runtimeMode = mode;
    this.#emitInfo();
  }

  async setInteractionMode(mode: InteractionMode): Promise<void> {
    this.info.interactionMode = mode;
    this.#emitInfo();
  }

  async compact(): Promise<void> {
    await this.#request("thread/compact/start", { threadId: this.#threadId() });
  }

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const response: {
        data: {
          model: string;
          displayName: string;
          description: string;
          hidden: boolean;
          isDefault: boolean;
          supportedReasoningEfforts: { reasoningEffort: string }[];
          defaultReasoningEffort: string;
        }[];
        nextCursor: string | null;
      } = await this.#request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const model of response.data) {
        if (model.hidden) continue;
        models.push({
          id: model.model,
          aliases: [],
          label: model.displayName,
          description: model.description,
          efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort,
          isDefault: model.isDefault,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
    return models;
  }

  async listCommands(): Promise<NativeCommand[]> {
    const response = await this.#request<{ data: { skills: CodexSkill[] }[] }>("skills/list", {
      cwds: [this.info.cwd],
    });
    const commands = new Set(COMMANDS.map((command) => command.name));
    const skills = response.data
      .flatMap((entry) => entry.skills)
      .filter((skill) => skill.enabled && !commands.has(skill.name));
    this.#skills = new Map(skills.map((skill) => [skill.name, skill.path]));
    return [
      ...COMMANDS,
      ...skills.map((skill) => ({
        name: skill.name,
        aliases: [],
        description:
          skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
        argumentHint: "",
        kind: "skill" as const,
        startsTurn: true,
      })),
    ];
  }

  async runCommand(name: string, args: string): Promise<void> {
    const threadId = this.#threadId();
    switch (name) {
      case "rename":
        if (!args) throw new Error("Usage: /rename <name>");
        await this.#request("thread/name/set", { threadId, name: args });
        this.#notice("info", `Thread renamed to ${args}`);
        return;
      case "ps": {
        const response = await this.#request<{ data: { command: string; osPid: number | null }[] }>(
          "thread/backgroundTerminals/list",
          { threadId },
        );
        this.#notice(
          "info",
          response.data.length === 0
            ? "No background terminals"
            : [
                "Background terminals",
                ...response.data.map(
                  (terminal) =>
                    `  $ ${unwrapShell(terminal.command)}${terminal.osPid === null ? "" : ` (pid ${terminal.osPid})`}`,
                ),
              ].join("\n"),
        );
        return;
      }
      case "clean":
        await this.#request("thread/backgroundTerminals/clean", { threadId });
        this.#notice("info", "Stopped all background terminals");
        return;
    }
    throw new Error(`${this.info.harness} cannot run /${name}`);
  }

  async listMcpServers(): Promise<McpServer[]> {
    const threadId = this.#threadId();
    const statuses: CodexMcpStatus[] = [];
    let cursor: string | null = null;
    do {
      const response: { data: CodexMcpStatus[]; nextCursor: string | null } = await this.#request(
        "mcpServerStatus/list",
        { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) },
      );
      statuses.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    // The config adds each server's command or URL and the file that defines it.
    const config = await this.#request<{
      config: { mcp_servers?: Record<string, CodexMcpConfig> };
      origins: Record<string, { name: { file?: string } } | undefined>;
    }>("config/read", { cwd: this.info.cwd, includeLayers: false }).catch(() => null);
    return statuses.map((status) => {
      const origin =
        config?.origins[`mcp_servers.${status.name}.url`] ??
        config?.origins[`mcp_servers.${status.name}.command`];
      // Servers 1harness added are not in Codex's files, so their own config fills in.
      const added = this.#config.mcpServers?.[status.name];
      if (added) {
        const own =
          added.type === "http" ? { url: added.url } : { command: added.command, args: added.args };
        return toMcpServer(status, own, "1harness");
      }
      const file = origin?.name.file ? homePath(origin.name.file) : null;
      return toMcpServer(status, config?.config.mcp_servers?.[status.name], file);
    });
  }

  async mcpAction(action: McpAction, server: string): Promise<McpActionResult> {
    switch (action) {
      case "login": {
        const response = await this.#request<{ authorizationUrl: string }>(
          "mcpServer/oauth/login",
          {
            name: server,
            threadId: this.#threadId(),
          },
        );
        return {
          message: `Open this page to sign in to ${server}; it connects once you finish`,
          url: response.authorizationUrl,
        };
      }
      case "reconnect":
        // Codex reloads every server from its config; it has no reconnect for one.
        await this.#request("config/mcpServer/reload", undefined);
        return { message: "Reconnected every MCP server", url: null };
      default:
        throw new Error(`${this.info.harness} does not let 1harness turn a server on or off`);
    }
  }

  mcpCallId(meta: Record<string, unknown>): string | null {
    // The mcpToolCall item's ID; `itemId` is the model API's ID for the same call.
    const id = meta["callId"];
    return typeof id === "string" ? id : null;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.#request<{
      data: { id: string; name: string | null; preview: string; updatedAt: number }[];
    }>("thread/list", { cwd: this.info.cwd, limit: 20, sortKey: "updated_at" });
    return response.data.map((thread) => ({
      id: thread.id,
      title: thread.name ?? thread.preview,
      updatedAt: thread.updatedAt * 1000,
    }));
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [id, pending] of this.#pending) {
      pending.resolve(codexResponse(pending, { kind: "cancel" }));
      this.#pending.delete(id);
    }
    await this.#rpc?.close();
    await this.#hooks?.close();
  }

  /** Codex's PreToolUse hook input, checked against the session's tool policy. */
  async #checkTool(input: Record<string, unknown>): Promise<unknown> {
    const policy = this.#config.toolPolicy;
    if (!policy || input["hook_event_name"] !== "PreToolUse") return {};
    const tool = String(input["tool_name"] ?? "");
    const reason = await policy({
      tool,
      input: input["tool_input"],
      action: toolAction(tool, input["tool_input"]),
    });
    return reason
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }
      : {};
  }

  /**
   * Codex runs a hook only once the user trusts it, so 1harness asks once and
   * records the trust in Codex's config, as Codex's own /hooks does.
   */
  async #trustHook(fresh: boolean): Promise<void> {
    const listing = await this.#request<{ data: { hooks: CodexHook[] }[] }>("hooks/list", {
      threadId: this.#threadId(),
    }).catch(() => null);
    const hook = listing?.data
      .flatMap((entry) => entry.hooks)
      .find((entry) => entry.source === "sessionFlags" && entry.command === HOOK_COMMAND);
    if (!hook || hook.trustStatus === "trusted" || hook.trustStatus === "managed") return;
    const id = `codex-hook-trust-${Date.now()}`;
    this.#pending.set(id, {
      method: "1harness/trustHook",
      params: {},
      decisions: new Map(),
      resolve: (result) => {
        if (result !== "trust") return;
        void this.#writeHookTrust(hook, fresh).catch((error: unknown) =>
          this.#notice("error", `Could not trust the hook: ${errorMessage(error)}`),
        );
      },
    });
    this.#emit({
      type: "request.opened",
      request: {
        kind: "approval",
        id,
        title: "Let 1harness check tool calls in this thread?",
        detail:
          "An extension checks tool calls before they run. This harness runs such checks only through a hook you trust, so 1harness records that trust in its config, ~/.codex/config.toml. You are asked again if the hook changes.",
        action: { type: "other" },
        options: [
          { id: "trust", label: "Yes, trust 1harness's hook", effect: "allow-always" },
          { id: "skip", label: "Not now", effect: "deny" },
        ],
        defaultOptionId: "trust",
      },
    });
  }

  async #writeHookTrust(hook: CodexHook, fresh: boolean): Promise<void> {
    await this.#request("config/batchWrite", {
      edits: [
        {
          keyPath: "hooks.state",
          value: { [hook.key]: { trusted_hash: hook.currentHash } },
          mergeStrategy: "upsert",
        },
      ],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    });
    // Codex reads hooks when a thread starts. One with no turns yet is swapped
    // for a fresh one that runs the hook; others pick it up from the next thread.
    if (!fresh || this.#turnsStarted || !this.#threadParams) {
      this.#notice("info", "1harness checks tool calls from the next thread (/new)");
      return;
    }
    const response = await this.#request<ThreadResponse>(
      "thread/start",
      this.#threadParams,
      THREAD_TIMEOUT_MS,
    );
    this.#translator.threadId = response.thread.id;
    this.info.threadId = response.thread.id;
    this.#emitInfo();
    this.#notice("info", "1harness now checks tool calls");
  }

  /** Resumes with only the latest turns, unarchiving the thread if Codex archived it. */
  async #resume(threadId: string, params: Record<string, unknown>): Promise<ThreadResponse> {
    const resume = {
      ...params,
      threadId,
      excludeTurns: true,
      initialTurnsPage: { limit: HISTORY_TURNS, sortDirection: "desc", itemsView: "full" },
    };
    try {
      return await this.#request<ThreadResponse>("thread/resume", resume, THREAD_TIMEOUT_MS);
    } catch (error) {
      if (!/archived/i.test(errorMessage(error))) throw error;
      await this.#request("thread/unarchive", { threadId });
      return await this.#request<ThreadResponse>("thread/resume", resume, THREAD_TIMEOUT_MS);
    }
  }

  async #review(instructions: string): Promise<void> {
    this.#turnsStarted = true;
    this.#interruptRequested = false;
    const response = await this.#request<{ turn: CodexTurn }>("review/start", {
      threadId: this.#threadId(),
      target: instructions ? { type: "custom", instructions } : { type: "uncommittedChanges" },
    });
    this.#acknowledged(response.turn);
  }

  #threadId(): string {
    if (!this.info.threadId) throw new Error("The thread has not started");
    return this.info.threadId;
  }

  #request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#rpc) return Promise.reject(new Error("The session has not started"));
    return this.#rpc.request<T>(method, params, timeoutMs);
  }

  #emit(event: HarnessEvent): void {
    this.#events.push(event);
  }

  #notice(level: "info" | "warning" | "error", text: string): void {
    this.#emit(this.#translator.notice(level, text));
  }

  #emitInfo(): void {
    this.#emit({ type: "session.updated", info: { ...this.info } });
  }

  /**
   * Records the turn a start request created. A turn that already finished, or
   * one Codex queued without starting, waits for `turn/started` instead.
   */
  #acknowledged(turn: CodexTurn): void {
    if (this.#endedTurns.has(turn.id) || turn.startedAt === null) return;
    this.#turnStarted(turn.id);
  }

  #turnStarted(turnId: string): void {
    if (this.#turnId === turnId || this.#endedTurns.has(turnId)) return;
    this.#turnId = turnId;
    if (this.#interruptRequested) void this.#sendInterrupt(turnId);
  }

  async #sendInterrupt(turnId: string): Promise<void> {
    try {
      await this.#request("turn/interrupt", { threadId: this.#threadId(), turnId });
    } catch (error) {
      this.#emit(this.#translator.notice("warning", `Interrupt failed: ${errorMessage(error)}`));
    }
    // Commands left running in the background stop with the turn.
    for (const processId of this.#processes.values()) {
      void this.#request("thread/backgroundTerminals/terminate", {
        threadId: this.#threadId(),
        processId,
      }).catch(() => {});
    }
  }

  #notification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>;
    if (method === "item/started" || method === "item/completed") this.#track(method, params);
    for (let event of this.#translator.translate(method, params)) {
      if (event.type === "turn.started") {
        this.#startedTurns.add(event.turnId);
        this.#turnStarted(event.turnId);
      }
      // A review reports a different turn ID when it completes than when it started.
      if (
        event.type === "turn.ended" &&
        this.#turnId !== null &&
        event.turnId !== this.#turnId &&
        !this.#startedTurns.has(event.turnId)
      ) {
        event = { ...event, turnId: this.#turnId };
      }
      if (event.type === "request.resolved") {
        if (!this.#pending.delete(event.requestId)) continue;
      }
      this.#emit(event);
      if (event.type === "turn.ended") this.#turnEnded(event.turnId, event.status);
    }
  }

  /** Keeps what approvals and interrupts need from items: diffs and running processes. */
  #track(method: string, params: Record<string, unknown>): void {
    if (params["threadId"] !== undefined && params["threadId"] !== this.info.threadId) return;
    const item = params["item"] as CodexThreadItem;
    if (item.type === "fileChange" && method === "item/started") {
      const { changes } = item as Extract<CodexThreadItem, { type: "fileChange" }>;
      this.#fileChanges.set(item.id, fileChanges(changes));
    }
    if (item.type === "commandExecution") {
      const command = item as Extract<CodexThreadItem, { type: "commandExecution" }>;
      if (method === "item/started" && command.processId)
        this.#processes.set(item.id, command.processId);
      else if (method === "item/completed") this.#processes.delete(item.id);
    }
  }

  #turnEnded(turnId: string, status: string): void {
    this.#endedTurns.add(turnId);
    if (turnId !== this.#turnId) return;
    this.#turnId = null;
    this.#interruptRequested = false;
    if (
      status === "completed" &&
      this.info.interactionMode === "plan" &&
      this.#translator.takePlan(turnId)
    ) {
      this.#offerImplementation();
    }
  }

  /** Codex's own UI asks to implement a finished plan; accepting leaves plan mode. */
  #offerImplementation(): void {
    const id = `codex-plan-${Date.now()}`;
    const options = planOptions(this.info.runtimeMode, CAPABILITIES.runtimeModes);
    this.#pending.set(id, {
      method: "1harness/implementPlan",
      params: {},
      decisions: new Map(),
      resolve: (result) => {
        const mode = isRuntimeMode(result) ? result : undefined;
        if (!mode) return;
        void this.#implementPlan(mode).catch((error: unknown) =>
          this.#emit(this.#translator.notice("error", errorMessage(error))),
        );
      },
    });
    this.#emit({
      type: "request.opened",
      request: {
        kind: "approval",
        id,
        title: PLAN_TITLE,
        detail: "",
        action: { type: "other" },
        options,
        defaultOptionId: options[0]?.id ?? "",
      },
    });
  }

  /** Leaves plan mode in the chosen runtime mode and starts the implementation turn. */
  async #implementPlan(mode: RuntimeMode): Promise<void> {
    if (mode !== this.info.runtimeMode) await this.setRuntimeMode(mode);
    this.info.interactionMode = "default";
    this.#emitInfo();
    // The turn appears like any other, through Codex's own events.
    await this.startTurn({ text: IMPLEMENT_PLAN });
  }

  #serverRequest(method: string, raw: unknown, rpcId: RequestId): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    const id = codexRequestId(rpcId);
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request": {
        const decisions = new Map<string, unknown>();
        const request = this.#describe(id, method, params, decisions);
        if (!request) {
          return Promise.resolve({ action: "decline", content: null, _meta: null });
        }
        return new Promise((resolve) => {
          this.#pending.set(id, { method, params, decisions, resolve });
          this.#emit({ type: "request.opened", request });
        });
      }
      case "item/tool/call":
        return Promise.resolve({
          contentItems: [{ type: "inputText", text: "1harness has no dynamic tools." }],
          success: false,
        });
      default:
        return Promise.reject(new RpcError(-32601, `1harness does not handle ${method}`));
    }
  }

  /** Builds the request shown to the user; null declines it without asking. */
  #describe(
    id: string,
    method: string,
    params: Record<string, unknown>,
    decisions: Map<string, unknown>,
  ): HarnessRequest | null {
    const reason = typeof params["reason"] === "string" ? params["reason"] : "";
    // Codex's own agents run in their own threads and ask through the parent's connection.
    const agent =
      typeof params["threadId"] === "string" && params["threadId"] !== this.info.threadId;
    const ask = (question: string) => (agent ? ASK.fromAgent(question) : question);
    const option = (label: string, decision: unknown): ApprovalOption => {
      const optionId = `d${decisions.size}`;
      decisions.set(optionId, decision);
      return { id: optionId, label, effect: decisionEffect(decision) };
    };

    switch (method) {
      case "item/tool/requestUserInput":
        return userInputRequest(id, params);
      case "mcpServer/elicitation/request":
        return elicitationRequest(id, params, option);
      case "item/permissions/requestApproval":
        return approval(
          id,
          ask(ASK.permissions),
          { type: "other" },
          [reason, describePermissions(params["permissions"])],
          [
            option(ANSWER.forTurn, "turn"),
            option(ANSWER.forSession, "session"),
            option(ANSWER.no, "deny"),
          ],
        );
      case "item/fileChange/requestApproval": {
        const changes = this.#fileChanges.get(String(params["itemId"])) ?? [];
        const available = (params["availableDecisions"] as unknown[] | undefined) ?? [
          "accept",
          "acceptForSession",
          "decline",
          "cancel",
        ];
        return approval(
          id,
          ask(askForChanges(changes)),
          { type: "file_change", paths: changes.map((change) => change.path) },
          [reason, ...changes.map((change) => `${change.path}\n${change.diff}`)],
          available.map((decision) => option(decisionLabel(decision, "edits"), decision)),
        );
      }
    }

    const command = unwrapShell(typeof params["command"] === "string" ? params["command"] : "");
    const network = params["networkApprovalContext"] as { host: string } | null | undefined;
    const fallback: unknown[] = ["accept", "acceptForSession"];
    if (params["proposedExecpolicyAmendment"]) {
      fallback.push({
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: params["proposedExecpolicyAmendment"],
        },
      });
    }
    fallback.push("decline", "cancel");
    const available = (params["availableDecisions"] as unknown[] | null | undefined) ?? fallback;
    const title = network
      ? ASK.network(network.host)
      : params["kind"] === "writeStdin"
        ? ASK.commandInput
        : ASK.command;
    return approval(
      id,
      ask(title),
      command && !network && params["kind"] !== "writeStdin"
        ? {
            type: "command",
            command,
            cwd: typeof params["cwd"] === "string" ? params["cwd"] : null,
          }
        : { type: "other" },
      [command ? `$ ${command}` : "", reason],
      available.map((decision) => option(decisionLabel(decision, "command"), decision)),
    );
  }

  #closed(reason: string): void {
    for (const [id, pending] of this.#pending) {
      pending.resolve(codexResponse(pending, { kind: "cancel" }));
      this.#pending.delete(id);
    }
    if (this.#turnId !== null) {
      const error = this.#closing ? null : reason;
      this.#emit({
        type: "turn.ended",
        turnId: this.#turnId,
        status: error ? "failed" : "interrupted",
        error,
      });
      this.#turnId = null;
    }
    this.#emit({ type: "session.closed", error: this.#closing ? null : reason });
    this.#events.end();
  }
}

function approval(
  id: string,
  title: string,
  action: ApprovalAction,
  detail: string[],
  options: ApprovalOption[],
): ApprovalRequest {
  return {
    kind: "approval",
    id,
    title,
    detail: detail.filter((line) => line !== "").join("\n"),
    action,
    options,
    defaultOptionId: options[0]?.id ?? "",
  };
}

/** Labels a native approval decision in 1harness's words. */
function decisionLabel(decision: unknown, subject: "command" | "edits"): string {
  if (decision === "accept") return ANSWER.yes;
  if (decision === "acceptForSession")
    return ANSWER.again(subject === "command" ? "this command" : "these files");
  if (decision === "decline") return ANSWER.noAndContinue;
  if (decision === "cancel") return ANSWER.noAndExplain;
  const record = (decision ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const amendment = record["acceptWithExecpolicyAmendment"]?.["execpolicy_amendment"];
  if (Array.isArray(amendment)) {
    // A prefix such as [shell, "-lc", command] names the command inside the shell.
    const tokens = amendment.map(String);
    const prefix =
      tokens.length === 3 && /^-l?c$/.test(tokens[1] ?? "") ? (tokens[2] ?? "") : tokens.join(" ");
    // Codex keeps these rules beyond the session.
    return ANSWER.always(`commands starting with \`${prefix}\``);
  }
  const network = record["applyNetworkPolicyAmendment"]?.["network_policy_amendment"] as
    | { host: string; action: string }
    | undefined;
  if (network) {
    return network.action === "deny" ? ANSWER.never(network.host) : ANSWER.always(network.host);
  }
  return JSON.stringify(decision);
}

function describePermissions(permissions: unknown): string {
  const record = (permissions ?? {}) as Record<string, unknown>;
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function userInputRequest(id: string, params: Record<string, unknown>): HarnessRequest {
  const questions = params["questions"] as {
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: { label: string; description: string }[] | null;
  }[];
  return {
    kind: "question",
    id,
    questions: questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options ?? [],
      multiSelect: false,
      allowOther: question.isOther || !question.options?.length,
      secret: question.isSecret,
    })),
  };
}

interface ElicitationField {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title: string }[];
}

/** Whether an elicitation choice or field asks to remember the approval, and for how long. */
function persistence(value: string): "always" | "session" | null {
  return /always|permanent/i.test(value) ? "always" : /session/i.test(value) ? "session" : null;
}

function fieldChoices(field: ElicitationField): { value: string; label: string }[] {
  if (field.oneOf)
    return field.oneOf.map((choice) => ({ value: choice.const, label: choice.title }));
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index] ?? value,
  }));
}

/**
 * MCP servers ask for approval or input through elicitations. A form whose
 * fields are all choices or have defaults becomes an approval, with "always"
 * choices offered when the server supports remembering them; anything else is
 * asked field by field. URL elicitations show the link to visit.
 */
function elicitationRequest(
  id: string,
  params: Record<string, unknown>,
  option: (label: string, decision: unknown) => ApprovalOption,
): HarnessRequest | null {
  const server = String(params["serverName"] ?? "MCP server");
  const message = String(params["message"] ?? params["title"] ?? "");
  const mode = params["mode"];
  if (mode === "url") {
    return approval(
      id,
      ASK.visit(server),
      { type: "other" },
      [message, String(params["url"])],
      [
        option(ANSWER.done, { action: "accept" }),
        option(ANSWER.no, { action: "decline" }),
        option(ANSWER.cancel, { action: "cancel" }),
      ],
    );
  }
  if (mode !== "form" && mode !== "openai/form" && mode !== "openaiForm") return null;
  const schema = (params["requestedSchema"] ?? {}) as {
    properties?: Record<string, ElicitationField>;
    required?: string[];
  };
  const fields = Object.entries(schema.properties ?? {});

  // Content for an approval: the matching choice, a default, or nothing.
  const content = (persist: "session" | "always" | null): Record<string, unknown> | null => {
    const result: Record<string, unknown> = {};
    for (const [key, field] of fields) {
      const choice = fieldChoices(field).find((entry) =>
        persist
          ? persistence(entry.value) === persist
          : /once|accept|approve|allow|yes/i.test(entry.value) && !persistence(entry.value),
      );
      if (choice) result[key] = choice.value;
      else if (field.type === "boolean" && persistence(`${key} ${field.title ?? ""}`))
        result[key] = persist === "always";
      else if (field.default !== undefined && field.default !== null) result[key] = field.default;
    }
    return (schema.required ?? []).every((key) => key in result) ? result : null;
  };

  const once = content(null);
  if (once) {
    const options = [option(ANSWER.yes, { action: "accept", content: once, _meta: null })];
    for (const persist of ["session", "always"] as const) {
      const remembered = content(persist);
      const offered = fields.some(([key, field]) =>
        [key, field.title ?? "", ...fieldChoices(field).map((choice) => choice.value)].some(
          (text) => persistence(text) === persist,
        ),
      );
      if (remembered && offered) {
        options.push(
          option(persist === "session" ? ANSWER.again() : ANSWER.always(), {
            action: "accept",
            content: remembered,
            _meta: { persist },
          }),
        );
      }
    }
    options.push(
      option(ANSWER.no, { action: "decline" }),
      option(ANSWER.cancel, { action: "cancel" }),
    );
    return approval(id, `${server}: ${message}`, { type: "other" }, [], options);
  }
  return {
    kind: "question",
    id,
    questions: fields.map(([key, field]) => ({
      id: key,
      header: server,
      question: field.title ?? field.description ?? key,
      options: fieldChoices(field).map((choice) => ({ label: choice.label, description: "" })),
      multiSelect: false,
      allowOther: fieldChoices(field).length === 0,
      secret: false,
    })),
  };
}

function textInput(input: UserInput) {
  return { type: "text", text: input.text, text_elements: [] };
}

/** The text, then each image as Codex's own UI attaches a local file. */
function inputItems(input: UserInput): unknown[] {
  return [textInput(input), ...(input.images ?? []).map((path) => ({ type: "localImage", path }))];
}

/** What choosing a native decision does, for code that answers approvals. */
export function decisionEffect(decision: unknown): ApprovalOption["effect"] {
  if (decision === "accept" || decision === "turn") return "allow";
  if (decision === "acceptForSession" || decision === "session") return "allow-always";
  if (decision === "decline" || decision === "cancel" || decision === "deny") return "deny";
  const record = (decision ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (record["acceptWithExecpolicyAmendment"]) return "allow-always";
  const network = record["applyNetworkPolicyAmendment"]?.["network_policy_amendment"] as
    | { action: string }
    | undefined;
  if (network) return network.action === "deny" ? "deny" : "allow-always";
  // An MCP elicitation reply.
  const reply = (decision ?? {}) as Record<string, unknown>;
  const action = reply["action"];
  if (action === "accept") {
    const meta = reply["_meta"] as { persist?: string } | null | undefined;
    return meta?.persist ? "allow-always" : "allow";
  }
  if (action === "decline" || action === "cancel") return "deny";
  return "other";
}

/**
 * 1harness's servers as thread config. A nested `mcp_servers` table merges with
 * the servers in Codex's config files, and unlike dotted keys it takes names
 * with dots, which Codex's key parser would split.
 */
export function codexMcpConfig(servers: Record<string, McpServerConfig>): Record<string, unknown> {
  if (Object.keys(servers).length === 0) return {};
  return {
    mcp_servers: Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        server.type === "http"
          ? {
              url: server.url,
              http_headers: server.headers,
              ...(server.timeoutSec ? { tool_timeout_sec: server.timeoutSec } : {}),
            }
          : { command: server.command, args: server.args, env: server.env },
      ]),
    ),
  };
}

/** Quotes a word for the shell Codex runs hook commands with, when it needs quoting. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** Shows a path under the home folder as `~/…`. */
function homePath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function nativeCommand(
  name: string,
  description: string,
  argumentHint: string,
  startsTurn: boolean,
): NativeCommand {
  return { name, aliases: [], description, argumentHint, kind: "command", startsTurn };
}

/** Builds the native reply. Option IDs map back to the decisions Codex offered. */
export function codexResponse(pending: PendingRequest, response: RequestResponse): unknown {
  const { method, params, decisions } = pending;
  if (method === "1harness/trustHook") {
    return response.kind === "approval" ? response.optionId : "skip";
  }
  if (method === "1harness/implementPlan") {
    return response.kind === "approval" ? response.optionId : "keep";
  }
  if (method === "item/tool/requestUserInput") {
    const answers = response.kind === "question" ? response.answers : {};
    return {
      answers: Object.fromEntries(
        Object.entries(answers).map(([question, values]) => [question, { answers: values }]),
      ),
    };
  }
  if (method === "mcpServer/elicitation/request") {
    if (response.kind === "question") {
      const schema = (params["requestedSchema"] ?? {}) as {
        properties?: Record<string, ElicitationField>;
      };
      const content = Object.fromEntries(
        Object.entries(response.answers).map(([key, [value = ""]]) => {
          const field = schema.properties?.[key];
          const choice = field ? fieldChoices(field).find((entry) => entry.label === value) : null;
          const answer = choice?.value ?? value;
          if (field?.type === "number" || field?.type === "integer") return [key, Number(answer)];
          if (field?.type === "boolean") return [key, /^(true|yes|y)$/i.test(answer)];
          return [key, answer];
        }),
      );
      return { action: "accept", content, _meta: null };
    }
    const decision =
      response.kind === "approval"
        ? decisions.get(response.optionId)
        : response.kind === "decline"
          ? { action: "decline" }
          : null;
    return {
      content: null,
      _meta: null,
      ...((decision as object | null) ?? { action: "cancel" }),
    };
  }
  if (method === "item/permissions/requestApproval") {
    const scope = response.kind === "approval" ? decisions.get(response.optionId) : "deny";
    if (scope === "turn" || scope === "session") {
      const requested = (params["permissions"] ?? {}) as Record<string, unknown>;
      const granted = Object.fromEntries(
        Object.entries(requested).filter(([, value]) => value !== null),
      );
      return { permissions: granted, scope };
    }
    return { permissions: {}, scope: "turn" };
  }
  // Codex takes "decline" (go on without it) even where it offers only "cancel".
  if (response.kind === "decline") return { decision: "decline" };
  if (response.kind !== "approval") return { decision: "cancel" };
  return { decision: decisions.get(response.optionId) ?? "cancel" };
}
