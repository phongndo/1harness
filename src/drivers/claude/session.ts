import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type McpHttpServerConfig,
  type McpStdioServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../core/async-queue.ts";
import {
  RUNTIME_MODES,
  isRuntimeMode,
  fitRuntimeMode,
  type ApprovalOption,
  type Capabilities,
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
import { errorMessage } from "../../core/errors.ts";
import { text } from "../../core/values.ts";
import { checkToolHook, mcpTool, toolAction } from "../../core/tools.ts";
import { ANSWER, ASK, PLAN_TITLE, fileName, planOptions } from "../../core/wording.ts";
import { StderrTail } from "../child.ts";
import { readImage } from "../images.ts";
import { SessionEvents } from "../session-events.ts";
import { summarizeInput } from "../text.ts";
import {
  ClaudeTranslator,
  SUMMARY_KEYS,
  claudeRuntimeModes,
  permissionModeFor,
  runtimeModeFor,
  toMcpServer,
  toolItem,
} from "./translate.ts";

/** The name Claude gave a session for what it is doing; null until it has named it. */
export async function claudeSessionTitle(cwd: string, sessionId: string): Promise<string | null> {
  try {
    const found = await getSessionInfo(sessionId, { dir: cwd });
    // The name given with /rename, else the one Claude generated; its summary
    // falls back to a prompt, which is no name.
    return found?.customTitle?.trim() || null;
  } catch {
    return null;
  }
}

/** How long after a turn to look again for the name Claude gives a session. */
const TITLE_RETRY_MS = 8000;

const CAPABILITIES: Capabilities = {
  steer: true,
  planMode: true,
  runtimeModes: RUNTIME_MODES,
  images: true,
  toolChecks: true,
  nativeSlashCommands: true,
  // Claude Code signs in to MCP servers only in its own terminal.
  mcpActions: ["reconnect", "enable", "disable"],
};

/** Entries Claude Code lists that are not for people: internal hooks and retired names. */
function isInternalCommand(command: SlashCommand): boolean {
  return (
    command.name.startsWith("__") ||
    command.name === "workflow-launch-exec" ||
    /^(\(removed\)|Renamed to )/.test(command.description)
  );
}

// Claude names its terminal-bound commands only with its first turn; until then
// the ones Claude Code 2.1.314 names stand in.
const TERMINAL_COMMANDS = ["color", "doctor", "focus", "reload-plugins"];

// Resumed sessions show this many recent messages.
const HISTORY_MESSAGES = 200;

export interface ClaudeSessionConfig extends SessionOptions {
  /** The user's own `claude`, never the SDK's bundled copy, so its login and settings apply. */
  executable: string;
  /** Starts the SDK query; tests give a fake. */
  query?: typeof query;
}

interface Turn {
  id: string;
  /** Prompts sent in this turn that Claude has not yet answered with a result. */
  outstanding: Set<string>;
  /** Claude started the turn itself, so its next result ends it. */
  synthetic: boolean;
}

// The rejection Claude Code itself sends, so Claude stops and waits for the user.
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** Drives Claude Code through the Claude Agent SDK in streaming-input mode. */
export class ClaudeSession implements HarnessSession {
  readonly capabilities: Capabilities;
  readonly info: SessionInfo;
  #config: ClaudeSessionConfig;
  #query: Query | null = null;
  #input = new AsyncQueue<SDKUserMessage>();
  #events = new SessionEvents("claude");
  #translator = new ClaudeTranslator();
  #turn: Turn | null = null;
  #interruptRequested = false;
  #bypassAllowed: boolean;
  /** Why the thread starts in a narrower mode than asked, said once it starts. */
  #stepDown: string | null = null;
  /** The modes Claude Code's settings leave on. */
  #allowed: RuntimeMode[];
  #generation = 0;
  #stderr = new StderrTail();
  #closing = false;
  /**
   * Commands bound to Claude Code's own terminal, which this client cannot run,
   * and the names that are skills. Claude reports both with its first turn.
   */
  #terminalCommands = new Set(TERMINAL_COMMANDS);
  #skills = new Set<string>();

  constructor(config: ClaudeSessionConfig) {
    this.#config = config;
    this.#allowed = claudeRuntimeModes(claudeSettings(config.cwd));
    // Claude Code refuses full access as root unless it runs in a sandbox.
    const root = process.getuid?.() === 0 && !process.env["IS_SANDBOX"];
    const modes = root ? this.#allowed.filter((mode) => mode !== "full-access") : this.#allowed;
    this.capabilities = { ...CAPABILITIES, runtimeModes: modes };
    // A mode that is turned off steps down to the broadest one left.
    const runtimeMode = fitRuntimeMode(config.runtimeMode, modes) ?? "supervised";
    if (runtimeMode !== config.runtimeMode)
      this.#stepDown = `${this.#unavailable(config.runtimeMode)}, so this thread runs in ${runtimeMode}`;
    this.#bypassAllowed = runtimeMode === "full-access";
    this.info = {
      harness: "claude",
      threadId: config.resume,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      runtimeMode,
      interactionMode: config.interactionMode,
      version: null,
    };
  }

  /** Why a mode is not offered. */
  #unavailable(mode: RuntimeMode): string {
    return this.#allowed.includes(mode)
      ? "Claude Code does not run full-access as root"
      : `Claude Code's settings turn off ${mode}`;
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.#events.stream;
  }

  async start(): Promise<void> {
    if (this.#config.resume) await this.#replayHistory(this.#config.resume);
    // After any history, where the user is looking.
    if (this.#stepDown) this.#events.notice("warning", this.#stepDown);
    this.#open(this.#config.resume);
    this.#events.info(this.info);
  }

  async startTurn(input: UserInput): Promise<void> {
    if (!this.#query) throw new Error("The session is not running");
    // Read first: an image that cannot be read fails the send, not a turn already begun.
    const content = userContent(input);
    const uuid = randomUUID();
    this.#interruptRequested = false;
    this.#turn = { id: uuid, outstanding: new Set([uuid]), synthetic: false };
    this.#events.emit({ type: "turn.started", turnId: uuid });
    this.#sendPrompt(uuid, input, content);
  }

  async steer(input: UserInput): Promise<void> {
    if (!this.#turn) throw new Error("No turn is running");
    const content = userContent(input);
    const uuid = randomUUID();
    this.#turn.outstanding.add(uuid);
    this.#sendPrompt(uuid, input, content);
  }

  async interrupt(): Promise<void> {
    if (!this.#query || !this.#turn) return;
    this.#interruptRequested = true;
    await this.#query.interrupt();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    await this.#events.answer(requestId, response);
  }

  async setModel(model: string | null): Promise<void> {
    await this.#require().setModel(model ?? undefined);
    this.info.model = model;
    this.#events.info(this.info);
  }

  async setEffort(effort: string | null): Promise<void> {
    await this.#require().applyFlagSettings({ effortLevel: effort as EffortLevel | null });
    this.info.effort = effort;
    this.#events.info(this.info);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    if (!this.capabilities.runtimeModes.includes(mode)) throw new Error(this.#unavailable(mode));
    await this.#applyPermissionMode(mode, this.info.interactionMode);
  }

  async setInteractionMode(mode: InteractionMode): Promise<void> {
    await this.#applyPermissionMode(this.info.runtimeMode, mode);
  }

  async compact(): Promise<void> {
    await this.startTurn({ text: "/compact" });
  }

  async listModels(): Promise<ModelOption[]> {
    const models = await this.#require().supportedModels();
    return models.map((model) => ({
      id: model.value,
      aliases: model.resolvedModel ? [model.resolvedModel] : [],
      label: model.displayName,
      description: model.description,
      efforts: model.supportedEffortLevels ?? [],
      defaultEffort: null,
      isDefault: model.value === "default",
    }));
  }

  /**
   * What Claude Code says works without its terminal: built-in commands,
   * custom commands, and skills. Claude runs each as a turn, local ones included.
   */
  async listCommands(): Promise<NativeCommand[]> {
    const commands = await this.#require().supportedCommands();
    return commands
      .filter((command) => !this.#terminalCommands.has(command.name) && !isInternalCommand(command))
      .map((command) => ({
        name: command.name,
        aliases: command.aliases ?? [],
        description: command.description,
        argumentHint: command.argumentHint,
        // Skills and your own commands are yours; Claude's built-in ones are its own.
        kind: this.#skills.has(command.name) || !command.builtin ? "skill" : "command",
        startsTurn: true,
      }));
  }

  /** Tasks still running between turns, such as background agents and shells. */
  backgroundTasks(): string[] {
    return this.#turn ? [] : this.#translator.backgroundWork;
  }

  async listMcpServers(): Promise<McpServer[]> {
    const statuses = await this.#require().mcpServerStatus();
    const added = this.#config.mcpServers ?? {};
    return statuses.map((status) => {
      const server = toMcpServer(status);
      return status.name in added ? { ...server, source: "1harness" } : server;
    });
  }

  async mcpAction(action: McpAction, server: string): Promise<McpActionResult> {
    const session = this.#require();
    switch (action) {
      case "reconnect":
        await session.reconnectMcpServer(server);
        return { message: `Reconnected ${server}`, url: null };
      case "enable":
      case "disable":
        await session.toggleMcpServer(server, action === "enable");
        // Claude Code saves this per folder in ~/.claude.json, so it outlasts the session.
        return {
          message:
            action === "enable"
              ? `Enabled ${server}`
              : `Disabled ${server}; it stays off in this folder until you enable it`,
          url: null,
        };
      case "login":
        throw new Error(`${this.info.harness} does not let 1harness sign in to a server`);
    }
  }

  mcpCallId(meta: Record<string, unknown>): string | null {
    const id = meta["claudecode/toolUseId"];
    return typeof id === "string" ? id : null;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const sessions = await listSessions({ dir: this.info.cwd, limit: 20 });
    return sessions.map((session) => ({
      id: session.sessionId,
      title: session.customTitle ?? session.summary ?? session.firstPrompt ?? session.sessionId,
      updatedAt: session.lastModified,
    }));
  }

  async close(): Promise<void> {
    if (this.#events.closed) return;
    this.#closing = true;
    this.#events.cancelAll();
    this.#input.end();
    this.#query?.close();
    this.#finish("closed");
  }

  #require(): Query {
    if (!this.#query) throw new Error("The session is not running");
    return this.#query;
  }

  #open(resume: string | null): void {
    const generation = ++this.#generation;
    this.#input = new AsyncQueue<SDKUserMessage>();
    const permissionMode = permissionModeFor(this.info.runtimeMode, this.info.interactionMode);
    const options: Options = {
      cwd: this.info.cwd,
      permissionMode,
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: (tool, input, context) => this.#canUseTool(tool, input, context),
      // Running agents get a one-line summary of what they are doing.
      agentProgressSummaries: true,
      stderr: (data) => this.#stderr.append(data),
      ...(this.#bypassAllowed ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.info.model ? { model: this.info.model } : {}),
      ...(this.info.effort ? { effort: this.info.effort as EffortLevel } : {}),
      pathToClaudeCodeExecutable: this.#config.executable,
      ...(resume ? { resume } : {}),
      // Added to the servers Claude Code reads from its own settings, for this session only.
      ...(this.#config.mcpServers ? { mcpServers: claudeMcpServers(this.#config.mcpServers) } : {}),
      // Hooks run before the permission check, so the policy sees calls even in full access.
      ...(this.#config.toolPolicy ? { hooks: { PreToolUse: [{ hooks: [this.#checkTool] }] } } : {}),
    };
    const session = (this.#config.query ?? query)({ prompt: this.#input, options });
    this.#query = session;
    void this.#pump(session, generation);
  }

  async #pump(session: Query, generation: number): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of session) {
        if (generation !== this.#generation) break;
        this.#handle(message);
      }
    } catch (error) {
      failure = errorMessage(error);
      const tail = this.#stderr.toString();
      if (tail) failure = `${failure}\n${tail}`;
    }
    // A restart replaces the query; only the current one may close the session.
    if (generation === this.#generation) this.#finish(failure ?? "Claude Code exited");
  }

  #finish(reason: string): void {
    this.#events.close(this.#turn?.id ?? null, reason, this.#closing);
    this.#turn = null;
  }

  #handle(message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
      this.info.threadId = message.session_id;
      this.info.model = message.model;
      this.#translator.model = message.model;
      const terminal = new Set(message.terminal_slash_commands ?? []);
      const skills = new Set(message.skills);
      if (!sameSet(terminal, this.#terminalCommands) || !sameSet(skills, this.#skills)) {
        this.#terminalCommands = terminal;
        this.#skills = skills;
        this.#events.emit({ type: "commands.updated" });
      }
      this.info.version = message.claude_code_version;
      if (message.effort !== undefined) this.info.effort = message.effort;
      this.#syncPermissionMode(message.permissionMode);
      this.#events.info(this.info);
    } else if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.permissionMode
    ) {
      this.#syncPermissionMode(message.permissionMode);
      this.#events.info(this.info);
    }
    if (message.type === "conversation_reset") {
      // /clear starts a new conversation in the same session.
      this.info.threadId = message.new_conversation_id;
      this.#events.info(this.info);
      this.#events.notice("info", "Conversation cleared");
    }
    if (!this.#turn && (message.type === "assistant" || message.type === "stream_event")) {
      // Claude started work on its own, such as after a background task finished.
      const id = randomUUID();
      this.#turn = { id, outstanding: new Set(), synthetic: true };
      this.#events.emit({ type: "turn.started", turnId: id });
    }
    this.#events.emit(...this.#translator.translate(message));
    if (message.type === "result") this.#result(message);
  }

  #result(result: SDKResultMessage): void {
    const turn = this.#turn;
    if (!turn) return;
    const answered =
      result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : []);
    const aborted =
      result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools";
    if (this.#interruptRequested || aborted || turn.synthetic) turn.outstanding.clear();
    else if (answered.length > 0) for (const uuid of answered) turn.outstanding.delete(uuid);
    else turn.outstanding.delete(turn.outstanding.values().next().value ?? "");
    if (turn.outstanding.size > 0) return;

    const interrupted = this.#interruptRequested || aborted;
    const failed = result.subtype !== "success" || result.is_error;
    const status = interrupted ? "interrupted" : failed ? "failed" : "completed";
    this.#events.emit(...this.#translator.settleOpenTools(status !== "completed"));
    // A command such as /cost can answer only in the result.
    const sawText = this.#translator.takeSawText();
    if (
      status === "completed" &&
      !sawText &&
      result.subtype === "success" &&
      result.result.trim()
    ) {
      this.#events.emit({
        type: "item.completed",
        item: { kind: "assistant_message", id: `${result.uuid}-result`, text: result.result },
      });
    }
    this.#translator.endTurn();
    this.#events.emit({
      type: "turn.ended",
      turnId: turn.id,
      status,
      error: status === "failed" ? failureText(result) : null,
    });
    this.#turn = null;
    this.#interruptRequested = false;
    void this.#readTitle(true);
  }

  /**
   * Sends a prompt under `uuid`, which is new for each send: Claude skips a
   * prompt whose ID its transcript already has.
   */
  #sendPrompt(uuid: string, input: UserInput, content: SDKUserMessage["message"]["content"]): void {
    this.#events.emit({
      type: "item.completed",
      item: {
        kind: "user_message",
        id: uuid,
        text: input.text,
        ...(input.id ? { inputId: input.id } : {}),
      },
    });
    this.#input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage["uuid"] & string,
      // Claude counts a prompt as the human's only when it is marked so.
      ...(input.fromUser ? { origin: { kind: "human" } } : {}),
    });
  }

  #syncPermissionMode(mode: PermissionMode): void {
    this.info.interactionMode = mode === "plan" ? "plan" : "default";
    this.info.runtimeMode = runtimeModeFor(mode) ?? this.info.runtimeMode;
  }

  async #applyPermissionMode(
    runtimeMode: RuntimeMode,
    interactionMode: InteractionMode,
  ): Promise<void> {
    const mode = permissionModeFor(runtimeMode, interactionMode);
    if (mode === "bypassPermissions" && !this.#bypassAllowed) {
      // Claude only allows full access in a session started with it, so restart and resume.
      if (this.#turn) throw new Error("Stop the running turn before switching to full access");
      this.#bypassAllowed = true;
      this.info.runtimeMode = runtimeMode;
      this.info.interactionMode = interactionMode;
      const previous = this.#query;
      this.#input.end();
      // The old process takes its background tasks with it, without reporting their end.
      this.#translator.clearBackgroundWork();
      this.#open(this.info.threadId);
      previous?.close();
    } else {
      await this.#require().setPermissionMode(mode);
      this.info.runtimeMode = runtimeMode;
      this.info.interactionMode = interactionMode;
    }
    this.#events.info(this.info);
  }

  async #replayHistory(sessionId: string): Promise<void> {
    let messages: Awaited<ReturnType<typeof getSessionMessages>>;
    try {
      messages = await getSessionMessages(sessionId, { dir: this.info.cwd });
    } catch (error) {
      this.#events.notice("warning", `Could not load history: ${errorMessage(error)}`);
      return;
    }
    // An unknown session reads as empty, and Claude would only fail on the first message.
    if (messages.length === 0)
      throw new Error(`Claude Code has no conversation ${sessionId} in ${this.info.cwd}`);
    const replay = new ClaudeTranslator({ replay: true });
    for (const message of messages.slice(-HISTORY_MESSAGES)) {
      // Compaction summaries and other entries Claude Code keeps out of the transcript.
      if (message.type === "system" || (message as { is_meta?: boolean }).is_meta) continue;
      for (const event of replay.translate(message as unknown as SDKMessage)) {
        if (event.type === "item.completed" || event.type === "item.updated")
          this.#events.emit(event);
      }
    }
    this.#events.emit(...replay.settleOpenTools(false));
  }

  /**
   * Claude names a session for what it is doing, a little after its first
   * turns; the name goes out with the session's info. Read after each turn,
   * and once more shortly after, should Claude not have named it yet.
   */
  async #readTitle(again: boolean): Promise<void> {
    const id = this.info.threadId;
    if (!id || this.#events.closed) return;
    const title = await claudeSessionTitle(this.info.cwd, id);
    if (title && title !== this.info.title && !this.#events.closed) {
      this.info.title = title;
      this.#events.info(this.info);
    } else if (!title && again)
      setTimeout(() => void this.#readTitle(false), TITLE_RETRY_MS).unref();
  }

  #ask(request: HarnessRequest, signal: AbortSignal): Promise<RequestResponse> {
    return new Promise((resolve) => {
      const abort = () => void this.#events.answer(request.id, { kind: "cancel" });
      this.#events.ask(request, (response) => {
        signal.removeEventListener("abort", abort);
        resolve(response);
      });
      signal.addEventListener("abort", abort);
    });
  }

  #checkTool: HookCallback = (hook) => checkToolHook(this.#config.toolPolicy, hook);

  #canUseTool: CanUseTool = async (tool, input, context) => {
    const id = `claude-request-${context.toolUseID}`;
    if (tool === "AskUserQuestion") return this.#askQuestions(id, input, context);
    if (tool === "ExitPlanMode") return this.#approvePlan(id, input, context);

    // The choices Claude Code itself offers, in 1harness's words.
    const options: ApprovalOption[] = [{ id: "allow", label: ANSWER.yes, effect: "allow" }];
    if (!context.suppressAlwaysAllowRule) {
      options.push({
        id: "allowSession",
        label: alwaysAllowLabel(tool, context.suggestions),
        effect: "allow-always",
      });
    }
    options.push({ id: "deny", label: ANSWER.noAndExplain, effect: "deny" });
    const prompt = approvalPrompt(tool, input);
    // Claude Code's own sentence for the prompt goes under 1harness's question.
    const detail = [
      context.title ?? "",
      ...prompt.detail,
      context.description ?? "",
      stripVTControlCharacters(context.decisionReason ?? ""),
      context.blockedPath ? `Path: ${context.blockedPath}` : "",
    ];
    const response = await this.#ask(
      {
        kind: "approval",
        id,
        title: prompt.title,
        detail: distinctLines(detail).join("\n"),
        action: toolAction(tool, input),
        options,
        defaultOptionId: context.defaultToNo ? "deny" : "allow",
      },
      context.signal,
    );
    if (response.kind === "decline") {
      // Claude goes on without the tool, knowing why.
      return {
        behavior: "deny",
        message: response.reason,
        interrupt: false,
        toolUseID: context.toolUseID,
      };
    }
    const choice = response.kind === "approval" ? response.optionId : "deny";
    if (choice === "allow" || choice === "allowSession") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: context.toolUseID,
        decisionClassification: choice === "allowSession" ? "user_permanent" : "user_temporary",
        ...(choice === "allowSession"
          ? { updatedPermissions: sessionPermissions(tool, context.suggestions) }
          : {}),
      };
    }
    return {
      behavior: "deny",
      message: REJECTED,
      interrupt: true,
      toolUseID: context.toolUseID,
      decisionClassification: "user_reject",
    };
  };

  async #askQuestions(
    id: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const questions = (Array.isArray(input["questions"]) ? input["questions"] : []) as {
      question: string;
      header: string;
      options: { label: string; description: string }[];
      multiSelect?: boolean;
    }[];
    const response = await this.#ask(
      {
        kind: "question",
        id,
        questions: questions.map((question) => ({
          id: question.question,
          header: question.header,
          question: question.question,
          options: question.options,
          multiSelect: question.multiSelect === true,
          allowOther: true,
          secret: false,
        })),
      },
      context.signal,
    );
    if (response.kind !== "question") {
      return {
        behavior: "deny",
        message: "The user dismissed the question.",
        toolUseID: context.toolUseID,
      };
    }
    const answers = Object.fromEntries(
      Object.entries(response.answers).map(([question, values]) => [question, values.join(", ")]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID: context.toolUseID };
  }

  async #approvePlan(
    id: string,
    input: Record<string, unknown>,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const plan = text(input["plan"]);
    if (plan)
      this.#events.emit({
        type: "item.completed",
        item: { kind: "plan", id: `plan-${context.toolUseID}`, text: plan },
      });
    const options = planOptions(this.info.runtimeMode, this.capabilities.runtimeModes);
    const response = await this.#ask(
      {
        kind: "approval",
        id,
        title: PLAN_TITLE,
        detail: "",
        action: { type: "other" },
        options,
        defaultOptionId: options[0]?.id ?? "keep",
      },
      context.signal,
    );
    const choice = response.kind === "approval" ? response.optionId : "keep";
    const mode = isRuntimeMode(choice) ? choice : undefined;
    if (!mode) {
      return {
        behavior: "deny",
        message: "The user wants to keep planning. Ask what to change, then revise the plan.",
        toolUseID: context.toolUseID,
      };
    }
    const permissionMode =
      mode === "full-access" && !this.#bypassAllowed
        ? "acceptEdits"
        : permissionModeFor(mode, "default");
    this.info.runtimeMode = runtimeModeFor(permissionMode) ?? mode;
    this.info.interactionMode = "default";
    this.#events.info(this.info);
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: permissionMode, destination: "session" }],
      toolUseID: context.toolUseID,
    };
  }
}

function sessionPermissions(
  tool: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  if (suggestions && suggestions.length > 0) {
    return suggestions.map((suggestion) => ({ ...suggestion, destination: "session" }));
  }
  return [
    { type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" },
  ];
}

/** Describes why a turn failed, without CLI-internal diagnostics. */
function failureText(result: SDKResultMessage): string {
  const errors =
    result.subtype === "success"
      ? []
      : result.errors.filter((line) => !line.startsWith("[ede_diagnostic]"));
  if (errors.length > 0) return errors.join("\n");
  if (result.subtype === "success" && result.result.trim()) return result.result.trim();
  const status = result.subtype === "success" ? result.api_error_status : null;
  if (status) return `API error ${status}`;
  return result.subtype.replaceAll("_", " ");
}

/** The question and detail for a tool, with the diff for edits. */
function approvalPrompt(
  tool: string,
  input: Record<string, unknown>,
): { title: string; detail: string[] } {
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return { title: ASK.command, detail: [`$ ${String(input["command"] ?? "")}`] };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const item = toolItem("", tool, input);
      const changes = item?.kind === "file_change" ? item.changes : [];
      const path = input["file_path"] ?? input["notebook_path"];
      const file = typeof path === "string" ? fileName(path) : "the file";
      const title = tool === "Write" ? ASK.create(file) : ASK.edit(file);
      return { title, detail: [String(path ?? ""), ...changes.map((change) => change.diff)] };
    }
    case "WebFetch":
      return { title: ASK.fetch, detail: [String(input["url"] ?? "")] };
    default: {
      const mcp = mcpTool(tool);
      const name = mcp ? `${mcp.server} · ${mcp.tool}` : tool;
      return { title: ASK.tool(name), detail: [summarizeInput(input, SUMMARY_KEYS)] };
    }
  }
}

/** Names what "don't ask again" will allow, from Claude's own suggested rules. */
function alwaysAllowLabel(tool: string, suggestions: PermissionUpdate[] | undefined): string {
  for (const suggestion of suggestions ?? []) {
    if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") {
      return ANSWER.again("edits");
    }
    if (suggestion.type === "addDirectories") {
      return ANSWER.again(`access to ${suggestion.directories.join(", ")}`);
    }
    if (suggestion.type === "addRules") {
      const rule = suggestion.rules[0];
      if (rule?.ruleContent) {
        return ANSWER.again(`\`${rule.ruleContent}\`${tool === "Bash" ? " commands" : ""}`);
      }
    }
  }
  return ANSWER.again(tool);
}

/** Drops empty lines and ones an earlier line already says, such as a path's file name. */
function distinctLines(lines: string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== "" && !kept.some((earlier) => earlier.endsWith(trimmed))) kept.push(line);
  }
  return kept;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** The message content: plain text, or text with images ahead of it as Claude Code sends them. */
function userContent(input: UserInput): SDKUserMessage["message"]["content"] {
  if (!input.images?.length) return input.text;
  return [
    ...input.images.map(readImage).map(({ type, data }) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: type, data },
    })),
    { type: "text" as const, text: input.text },
  ];
}

/** 1harness's servers in the SDK's shape, with call timeouts in milliseconds. */
function claudeMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === "http"
        ? {
            type: "http",
            url: server.url,
            headers: server.headers,
            ...(server.timeoutSec ? { timeout: server.timeoutSec * 1000 } : {}),
          }
        : { type: "stdio", command: server.command, args: server.args, env: server.env },
    ]),
  );
}

/**
 * Claude Code's settings files, managed ones included, which can turn modes
 * off. Policy that arrives another way, such as a macOS profile or from the
 * server, is not read here; the mode Claude Code reports once it starts is.
 */
function claudeSettings(cwd: string): unknown[] {
  const home = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");

  const managed =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  const dropIns = join(managed, "managed-settings.d");
  let extra: string[] = [];
  try {
    extra = readdirSync(dropIns)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => join(dropIns, name));
  } catch {
    // No drop-in folder.
  }
  const files = [
    join(home, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(managed, "managed-settings.json"),
    ...extra,
  ];
  return files.flatMap((file) => {
    try {
      return [JSON.parse(readFileSync(file, "utf8")) as unknown];
    } catch {
      return [];
    }
  });
}
