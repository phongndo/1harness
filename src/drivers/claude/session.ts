import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
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
  type ApprovalOption,
  type Capabilities,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessSession,
  type InteractionMode,
  type McpAction,
  type McpActionResult,
  type McpServer,
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
import {
  ClaudeTranslator,
  permissionModeFor,
  runtimeModeFor,
  summarizeInput,
  toMcpServer,
  toolItem,
} from "./translate.ts";

const CAPABILITIES: Capabilities = {
  steer: true,
  planMode: true,
  runtimeModes: [
    {
      id: "supervised",
      description: "ask before edits and commands, as Claude Code does by default",
    },
    { id: "auto-edit", description: "accept edits without asking; ask before commands" },
    {
      id: "auto",
      description: "Claude Code's auto mode: a classifier approves or blocks each action",
    },
    { id: "full-access", description: "never ask; bypass permissions" },
  ],
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
const STDERR_TAIL_BYTES = 16_384;

const MODE_LABELS: Record<RuntimeMode, string> = {
  supervised: "manually approve edits",
  "auto-edit": "auto-accept edits",
  auto: "auto mode",
  "full-access": "full access",
};

export interface ClaudeSessionConfig extends SessionOptions {
  /** A `claude` executable to run instead of the SDK's bundled one. */
  executable: string | null;
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
  readonly capabilities = CAPABILITIES;
  readonly info: SessionInfo;
  #config: ClaudeSessionConfig;
  #query: Query | null = null;
  #input = new AsyncQueue<SDKUserMessage>();
  #events = new AsyncQueue<HarnessEvent>();
  #translator = new ClaudeTranslator();
  #pending = new Map<string, (response: RequestResponse) => void>();
  #turn: Turn | null = null;
  #interruptRequested = false;
  #bypassAllowed: boolean;
  #generation = 0;
  #stderr = "";
  #closed = false;
  /**
   * Commands bound to Claude Code's own terminal, which this client cannot run,
   * and the names that are skills. Claude reports both with its first turn.
   */
  #terminalCommands = new Set(TERMINAL_COMMANDS);
  #skills = new Set<string>();

  constructor(config: ClaudeSessionConfig) {
    this.#config = config;
    this.#bypassAllowed = config.runtimeMode === "full-access";
    this.info = {
      harness: "claude",
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
    if (this.#config.resume) await this.#replayHistory(this.#config.resume);
    this.#open(this.#config.resume);
    this.#emitInfo();
  }

  async startTurn(input: UserInput): Promise<void> {
    if (!this.#query) throw new Error("The Claude session is not running");
    const uuid = randomUUID();
    this.#interruptRequested = false;
    this.#turn = { id: uuid, outstanding: new Set([uuid]), synthetic: false };
    this.#emit({ type: "turn.started", turnId: uuid });
    this.#sendPrompt(uuid, input);
  }

  async steer(input: UserInput): Promise<void> {
    if (!this.#turn) throw new Error("No turn is running");
    const uuid = randomUUID();
    this.#turn.outstanding.add(uuid);
    this.#sendPrompt(uuid, input);
  }

  async interrupt(): Promise<void> {
    if (!this.#query || !this.#turn) return;
    this.#interruptRequested = true;
    await this.#query.interrupt();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    this.#pending.get(requestId)?.(response);
  }

  async setModel(model: string | null): Promise<void> {
    await this.#require().setModel(model ?? undefined);
    this.info.model = model;
    this.#emitInfo();
  }

  async setEffort(effort: string | null): Promise<void> {
    await this.#require().applyFlagSettings({ effortLevel: effort as EffortLevel | null });
    this.info.effort = effort;
    this.#emitInfo();
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
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
        // Until the first turn names the skills, Claude's own entries count as commands.
        kind:
          this.#skills.has(command.name) || (this.#skills.size === 0 && !command.builtin)
            ? "skill"
            : "command",
        startsTurn: true,
      }));
  }

  async runCommand(name: string): Promise<void> {
    throw new Error(`Claude Code runs /${name} as a turn`);
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
              : `Disabled ${server}; Claude Code keeps it off in this folder until you enable it`,
          url: null,
        };
      case "login":
        throw new Error(
          `Claude Code signs in to ${server} only in its own terminal: run claude, then /mcp`,
        );
    }
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
    if (this.#closed) return;
    this.#closed = true;
    for (const resolve of this.#pending.values()) resolve({ kind: "cancel" });
    this.#input.end();
    this.#query?.close();
    this.#finish(null);
  }

  #require(): Query {
    if (!this.#query) throw new Error("The Claude session is not running");
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
      // Running subagents get a one-line summary of what they are doing.
      agentProgressSummaries: true,
      stderr: (data) => {
        this.#stderr = (this.#stderr + data).slice(-STDERR_TAIL_BYTES);
      },
      ...(this.#bypassAllowed ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.info.model ? { model: this.info.model } : {}),
      ...(this.info.effort ? { effort: this.info.effort as EffortLevel } : {}),
      ...(this.#config.executable ? { pathToClaudeCodeExecutable: this.#config.executable } : {}),
      ...(resume ? { resume } : {}),
      // Added to the servers Claude Code reads from its own settings, for this session only.
      ...(this.#config.mcpServers ? { mcpServers: this.#config.mcpServers } : {}),
      // Hooks run before the permission check, so the policy sees calls even in full access.
      ...(this.#config.toolPolicy ? { hooks: { PreToolUse: [{ hooks: [this.#checkTool] }] } } : {}),
    };
    const session = query({ prompt: this.#input, options });
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
      const tail = this.#stderr.trim().split("\n").slice(-5).join("\n");
      if (tail) failure = `${failure}\n${tail}`;
    }
    // A restart replaces the query; only the current one may close the session.
    if (generation === this.#generation && !this.#closed) {
      this.#closed = true;
      this.#finish(failure ?? "Claude Code exited");
    }
  }

  #finish(error: string | null): void {
    if (this.#turn) {
      for (const event of this.#translator.settleOpenTools(true)) this.#emit(event);
      this.#emit({
        type: "turn.ended",
        turnId: this.#turn.id,
        status: error ? "failed" : "interrupted",
        error,
      });
      this.#turn = null;
    }
    this.#emit({ type: "session.closed", error });
    this.#events.end();
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
        this.#emit({ type: "commands.updated" });
      }
      this.info.version = message.claude_code_version;
      if (message.effort !== undefined) this.info.effort = message.effort;
      this.#syncPermissionMode(message.permissionMode);
      this.#emitInfo();
    } else if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.permissionMode
    ) {
      this.#syncPermissionMode(message.permissionMode);
      this.#emitInfo();
    }
    if (message.type === "conversation_reset") {
      // /clear starts a new conversation in the same session.
      this.info.threadId = message.new_conversation_id;
      this.#emitInfo();
      this.#emit(this.#translator.notice("info", "Conversation cleared"));
    }
    if (!this.#turn && (message.type === "assistant" || message.type === "stream_event")) {
      // Claude started work on its own, such as after a background task finished.
      const id = randomUUID();
      this.#turn = { id, outstanding: new Set(), synthetic: true };
      this.#emit({ type: "turn.started", turnId: id });
    }
    for (const event of this.#translator.translate(message)) this.#emit(event);
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
    for (const event of this.#translator.settleOpenTools(status !== "completed")) this.#emit(event);
    // A command such as /cost can answer only in the result.
    const sawText = this.#translator.takeSawText();
    if (
      status === "completed" &&
      !sawText &&
      result.subtype === "success" &&
      result.result.trim()
    ) {
      this.#emit({
        type: "item.completed",
        item: { kind: "assistant_message", id: `${result.uuid}-result`, text: result.result },
      });
    }
    this.#translator.endTurn();
    this.#emit({
      type: "turn.ended",
      turnId: turn.id,
      status,
      error: status === "failed" ? failureText(result) : null,
    });
    this.#turn = null;
    this.#interruptRequested = false;
  }

  #sendPrompt(uuid: string, input: UserInput): void {
    this.#emit({
      type: "item.completed",
      item: { kind: "user_message", id: uuid, text: input.text },
    });
    this.#input.push({
      type: "user",
      message: { role: "user", content: userContent(input) },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage["uuid"] & string,
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
      if (this.#turn)
        throw new Error("Stop the running turn before switching Claude to full access");
      this.#bypassAllowed = true;
      this.info.runtimeMode = runtimeMode;
      this.info.interactionMode = interactionMode;
      const previous = this.#query;
      this.#input.end();
      this.#open(this.info.threadId);
      previous?.close();
    } else {
      await this.#require().setPermissionMode(mode);
      this.info.runtimeMode = runtimeMode;
      this.info.interactionMode = interactionMode;
    }
    this.#emitInfo();
  }

  async #replayHistory(sessionId: string): Promise<void> {
    let messages: Awaited<ReturnType<typeof getSessionMessages>>;
    try {
      messages = await getSessionMessages(sessionId, { dir: this.info.cwd });
    } catch (error) {
      this.#emit(
        this.#translator.notice("warning", `Could not load history: ${errorMessage(error)}`),
      );
      return;
    }
    const replay = new ClaudeTranslator({ replay: true });
    for (const message of messages.slice(-HISTORY_MESSAGES)) {
      // Compaction summaries and other entries Claude Code keeps out of the transcript.
      if (message.type === "system" || (message as { is_meta?: boolean }).is_meta) continue;
      for (const event of replay.translate(message as unknown as SDKMessage)) {
        if (event.type === "item.completed" || event.type === "item.updated") this.#emit(event);
      }
    }
    for (const event of replay.settleOpenTools(false)) this.#emit(event);
  }

  #emit(event: HarnessEvent): void {
    this.#events.push(event);
  }

  #emitInfo(): void {
    this.#emit({ type: "session.updated", info: { ...this.info } });
  }

  #ask(request: HarnessRequest, signal: AbortSignal): Promise<RequestResponse> {
    return new Promise((resolve) => {
      const settle = (response: RequestResponse) => {
        if (!this.#pending.delete(request.id)) return;
        signal.removeEventListener("abort", abort);
        this.#emit({ type: "request.resolved", requestId: request.id });
        resolve(response);
      };
      const abort = () => settle({ kind: "cancel" });
      this.#pending.set(request.id, settle);
      signal.addEventListener("abort", abort);
      this.#emit({ type: "request.opened", request });
    });
  }

  #checkTool: HookCallback = async (hook) => {
    const policy = this.#config.toolPolicy;
    if (!policy || hook.hook_event_name !== "PreToolUse") return {};
    const reason = await policy({
      tool: hook.tool_name,
      input: hook.tool_input,
      action: toolAction(hook.tool_name, hook.tool_input),
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
  };

  #canUseTool: CanUseTool = async (tool, input, context) => {
    const id = `claude-request-${context.toolUseID}`;
    if (tool === "AskUserQuestion") return this.#askQuestions(id, input, context);
    if (tool === "ExitPlanMode") return this.#approvePlan(id, input, context);

    // The options Claude Code itself offers.
    const options: ApprovalOption[] = [{ id: "allow", label: "Yes", effect: "allow" }];
    if (!context.suppressAlwaysAllowRule) {
      options.push({
        id: "allowSession",
        label: alwaysAllowLabel(tool, context.suggestions),
        effect: "allow-always",
      });
    }
    options.push({
      id: "deny",
      label: "No, and tell Claude what to do differently",
      effect: "deny",
    });
    const prompt = approvalPrompt(tool, input);
    const detail = [
      ...prompt.detail,
      context.description ?? "",
      stripVTControlCharacters(context.decisionReason ?? ""),
      context.blockedPath ? `Path: ${context.blockedPath}` : "",
    ];
    const response = await this.#ask(
      {
        kind: "approval",
        id,
        title: context.title ?? prompt.title,
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
    const plan = typeof input["plan"] === "string" ? input["plan"] : "";
    if (plan)
      this.#emit({
        type: "item.completed",
        item: { kind: "plan", id: `plan-${context.toolUseID}`, text: plan },
      });
    const current = this.info.runtimeMode;
    const choices: RuntimeMode[] = ["auto-edit", "supervised"];
    if (!choices.includes(current)) choices.unshift(current);
    const options: ApprovalOption[] = choices.map((mode) => ({
      id: mode,
      label: `Yes, and ${MODE_LABELS[mode]}`,
      effect: "allow",
    }));
    options.push({ id: "keep", label: "No, keep planning", effect: "deny" });
    const response = await this.#ask(
      {
        kind: "approval",
        id,
        title: "Ready to implement this plan?",
        detail: "",
        action: { type: "other" },
        options,
        defaultOptionId: options[0]?.id ?? "keep",
      },
      context.signal,
    );
    const choice = response.kind === "approval" ? response.optionId : "keep";
    const mode = RUNTIME_MODES.find((entry) => entry === choice);
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
    this.#emitInfo();
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

function fileName(path: unknown): string {
  return typeof path === "string" ? (path.split("/").at(-1) ?? path) : "the file";
}

/** The question and detail Claude Code shows for a tool, with the diff for edits. */
function approvalPrompt(
  tool: string,
  input: Record<string, unknown>,
): { title: string; detail: string[] } {
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return { title: "Do you want to proceed?", detail: [`$ ${String(input["command"] ?? "")}`] };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const item = toolItem("", tool, input);
      const changes = item?.kind === "file_change" ? item.changes : [];
      const path = input["file_path"] ?? input["notebook_path"];
      const title =
        tool === "Write"
          ? `Do you want to create ${fileName(path)}?`
          : `Do you want to make this edit to ${fileName(path)}?`;
      return { title, detail: [String(path ?? ""), ...changes.map((change) => change.diff)] };
    }
    case "WebFetch":
      return {
        title: "Do you want to allow Claude to fetch this content?",
        detail: [String(input["url"] ?? "")],
      };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      const name = mcp ? `${mcp[1]} · ${mcp[2]}` : tool;
      return { title: `Do you want to allow ${name}?`, detail: [summarizeInput(input)] };
    }
  }
}

/** Names what "don't ask again" will allow, from Claude's own suggested rules. */
function alwaysAllowLabel(tool: string, suggestions: PermissionUpdate[] | undefined): string {
  for (const suggestion of suggestions ?? []) {
    if (suggestion.type === "setMode" && suggestion.mode === "acceptEdits") {
      return "Yes, allow all edits during this session";
    }
    if (suggestion.type === "addDirectories") {
      return `Yes, and allow access to ${suggestion.directories.join(", ")} this session`;
    }
    if (suggestion.type === "addRules") {
      const rule = suggestion.rules[0];
      if (rule?.ruleContent) {
        return `Yes, and don't ask again for \`${rule.ruleContent}\` ${tool === "Bash" ? "commands" : "this session"}`;
      }
    }
  }
  return `Yes, and don't ask again for ${tool} this session`;
}

/** Drops empty lines and ones an earlier line already says, such as a path's file name. */
function distinctLines(lines: string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text !== "" && !kept.some((earlier) => earlier.endsWith(text))) kept.push(line);
  }
  return kept;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The message content: plain text, or text with images ahead of it as Claude Code sends them. */
function userContent(input: UserInput): SDKUserMessage["message"]["content"] {
  if (!input.images?.length) return input.text;
  return [
    ...input.images.map((path) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: IMAGE_TYPES[extname(path).toLowerCase()] ?? ("image/png" as const),
        data: readFileSync(path).toString("base64"),
      },
    })),
    { type: "text" as const, text: input.text },
  ];
}
