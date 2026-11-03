import { randomUUID } from "node:crypto";
import {
  fitRuntimeMode,
  type ApprovalOption,
  type Capabilities,
  type HarnessEvent,
  type HarnessSession,
  type InteractionMode,
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
import { ANSWER, ASK, askFor, askForChanges, fileName } from "../../core/wording.ts";
import { readImage } from "../images.ts";
import { JsonRpcProcess, RpcError } from "../jsonrpc.ts";
import { SessionEvents, started } from "../session-events.ts";
import {
  AcpTranslator,
  approvalAction,
  toolItem,
  type AcpToolCall,
  type AcpUpdate,
} from "./translate.ts";

/** An agent that speaks the Agent Client Protocol over stdio. */
export interface AcpAgentSpec {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface AcpMode {
  id: string;
  name: string;
  description?: string | null;
}

interface AcpConfigOption {
  id: string;
  category?: string | null;
  currentValue?: string;
  options?: { value: string; name: string; description?: string | null }[];
}

interface SessionResponse {
  sessionId?: string;
  modes?: { currentModeId: string; availableModes: AcpMode[] } | null;
  configOptions?: AcpConfigOption[] | null;
}

const PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 30_000;
// Loading a session replays it and starts its MCP servers, so it gets longer than a reply.
const CONTROL_TIMEOUT_MS = 120_000;
// Agents name their modes freely; these are the names that mean 1harness's modes.
const MODE_NAMES: Record<RuntimeMode, string[]> = {
  supervised: ["ask", "default", "read-only", "readonly", "manual", "supervised"],
  "auto-edit": ["accept-edits", "acceptedits", "auto-edit", "edit", "code"],
  auto: ["auto"],
  "full-access": ["full-access", "yolo", "bypasspermissions", "bypass", "full"],
};
const PLAN_NAMES = ["plan", "architect"];

/**
 * ACP's one-time choices, in the words every harness's choices use. An agent's
 * "always" choices keep its own names, which say what is allowed and for how long.
 */
const KIND_LABELS: Record<string, string> = {
  allow_once: ANSWER.yes,
  reject_once: ANSWER.no,
};

function modeFor(modes: readonly AcpMode[], names: readonly string[]): AcpMode | undefined {
  return modes.find((mode) => names.includes(mode.id.toLowerCase()));
}

/** The reply to a permission request: the option chosen, or cancelled. */
function permissionOutcome(
  response: RequestResponse,
  options: readonly { optionId: string; kind: string }[],
): unknown {
  let optionId: string | undefined;
  if (response.kind === "approval") optionId = response.optionId;
  // Declining picks the agent's own one-time rejection, which lets it go on.
  if (response.kind === "decline")
    optionId = options.find((option) => option.kind === "reject_once")?.optionId;
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** 1harness's servers in ACP's shape; HTTP ones only where the agent takes them. */
function acpMcpServers(servers: Record<string, McpServerConfig>, http: boolean): unknown[] {
  return Object.entries(servers).flatMap(([name, server]): unknown[] => {
    if (server.type === "http") {
      if (!http) return [];
      const headers = Object.entries(server.headers).map(([key, value]) => ({ name: key, value }));
      return [{ type: "http", name, url: server.url, headers }];
    }
    const env = Object.entries(server.env).map(([key, value]) => ({ name: key, value }));
    return [{ name, command: server.command, args: server.args, env }];
  });
}

/** Drives an ACP agent: one process and one ACP session per 1harness session. */
export class AcpSession implements HarnessSession {
  readonly capabilities: Capabilities = {
    steer: false,
    planMode: false,
    runtimeModes: [],
    images: false,
    toolChecks: false,
    nativeSlashCommands: true,
    mcpActions: [],
  };
  readonly info: SessionInfo;
  #spec: AcpAgentSpec;
  #options: SessionOptions;
  #version: string;
  #rpc: JsonRpcProcess | null = null;
  #events = new SessionEvents("acp");
  #translator = new AcpTranslator();
  #modes: AcpMode[] = [];
  #config: AcpConfigOption[] = [];
  #canList = false;
  #turnId: string | null = null;
  #closing = false;

  constructor(spec: AcpAgentSpec, options: SessionOptions, version: string) {
    this.#spec = spec;
    this.#options = options;
    this.#version = version;
    this.info = {
      harness: spec.id,
      threadId: options.resume,
      cwd: options.cwd,
      // What the agent reports once it starts; one without a model option reports none.
      model: null,
      effort: null,
      runtimeMode: options.runtimeMode,
      interactionMode: "default",
      version: null,
    };
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.#events.stream;
  }

  async start(): Promise<void> {
    const rpc = new JsonRpcProcess(this.#spec.command, this.#spec.args, {
      cwd: this.info.cwd,
      env: { ...process.env, ...this.#spec.env },
      name: this.#spec.label,
      jsonrpc: true,
    });
    this.#rpc = rpc;
    rpc.onNotification((method, params) => this.#notification(method, params));
    rpc.onRequest((method, params) => this.#serverRequest(method, params));
    rpc.onError((error) =>
      this.#events.notice(
        "error",
        `1harness could not read a message from ${this.#spec.label}: ${errorMessage(error)}`,
      ),
    );
    void rpc.exited.then((reason) => this.#closed(reason));

    const init = await rpc.request<{
      agentInfo?: { version?: string } | null;
      agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean } | null;
        mcpCapabilities?: { http?: boolean } | null;
        sessionCapabilities?: { list?: object | null } | null;
      } | null;
    }>(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        // The agent reads and writes files and runs commands itself.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "1harness", title: "1harness", version: this.#version },
      },
      START_TIMEOUT_MS,
    );
    const capabilities = init.agentCapabilities ?? {};
    this.info.version = init.agentInfo?.version ?? null;
    this.capabilities.images = capabilities.promptCapabilities?.image === true;
    this.#canList = Boolean(capabilities.sessionCapabilities?.list);
    const mcpServers = acpMcpServers(
      this.#options.mcpServers ?? {},
      capabilities.mcpCapabilities?.http === true,
    );

    const resume = this.#options.resume;
    let session: SessionResponse;
    if (resume && capabilities.loadSession) {
      // The agent replays the conversation as updates before it answers.
      session = await rpc.request(
        "session/load",
        { sessionId: resume, cwd: this.info.cwd, mcpServers },
        CONTROL_TIMEOUT_MS,
      );
      session.sessionId ??= resume;
      this.#events.emit(...this.#translator.flush());
    } else {
      if (resume)
        this.#events.notice(
          "warning",
          `${this.#spec.label} cannot resume sessions; starting a new one`,
        );
      session = await rpc.request(
        "session/new",
        { cwd: this.info.cwd, mcpServers },
        CONTROL_TIMEOUT_MS,
      );
    }
    this.info.threadId = session.sessionId ?? null;
    this.#applyModes(session.modes ?? null);
    this.#config = session.configOptions ?? [];
    this.info.model = this.#modelOption()?.currentValue ?? null;
    const model = this.#options.model;
    if (model)
      await this.setModel(model).catch((error: unknown) =>
        this.#events.notice("warning", `Could not use ${model}: ${errorMessage(error)}`),
      );
    // A mode the agent lacks steps down to the broadest one it has below it. The
    // thread manager refuses the thread if the agent still runs broader than asked.
    const requested = this.#options.runtimeMode;
    const mode = fitRuntimeMode(requested, this.capabilities.runtimeModes);
    if (mode && mode !== this.info.runtimeMode)
      await this.setRuntimeMode(mode).catch((error: unknown) =>
        this.#events.notice("warning", `Could not use ${mode}: ${errorMessage(error)}`),
      );
    if (mode && mode !== requested && this.info.runtimeMode === mode)
      this.#events.notice(
        "warning",
        `${this.#spec.label} has no ${requested} mode, so this thread runs in ${mode}`,
      );
    // Plan is one of the agent's modes, so it goes on after the runtime mode.
    if (this.#options.interactionMode === "plan" && this.capabilities.planMode) {
      await this.setInteractionMode("plan").catch((error: unknown) =>
        this.#events.notice("warning", `Could not start in plan mode: ${errorMessage(error)}`),
      );
    }
    this.#events.info(this.info);
  }

  async startTurn(input: UserInput): Promise<void> {
    const sessionId = started(this.info);
    const prompt: unknown[] = [
      { type: "text", text: input.text },
      ...(input.images ?? []).map(readImage).map(({ type, data }) => ({
        type: "image",
        mimeType: type,
        data,
      })),
    ];
    const turnId = randomUUID();
    this.#turnId = turnId;
    this.#events.emit({ type: "turn.started", turnId });
    this.#events.emit({
      type: "item.completed",
      item: {
        kind: "user_message",
        id: `acp-user-${turnId}`,
        text: input.text,
        ...(input.id ? { inputId: input.id } : {}),
      },
    });
    // The request answers only when the turn is over.
    void this.#request<{
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>("session/prompt", { sessionId, prompt }, null).then(
      (result) => this.#endTurn(turnId, result.stopReason, null),
      (error: unknown) => this.#endTurn(turnId, "error", errorMessage(error)),
    );
  }

  async steer(): Promise<void> {
    throw new Error(`${this.#spec.label} does not take messages mid-turn`);
  }

  async interrupt(): Promise<void> {
    if (!this.info.threadId) return;
    this.#rpc?.notify("session/cancel", { sessionId: this.info.threadId });
    // ACP has pending permission requests answered as cancelled when a turn is cancelled.
    this.#events.cancelAll();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    await this.#events.answer(requestId, response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    const target = modeFor(this.#modes, MODE_NAMES[mode]);
    if (!target) throw new Error(`${this.#spec.label} has no ${mode} mode`);
    await this.#request("session/set_mode", { sessionId: started(this.info), modeId: target.id });
    this.info.runtimeMode = mode;
    this.info.interactionMode = "default";
    this.#events.info(this.info);
  }

  async setInteractionMode(mode: InteractionMode): Promise<void> {
    const target =
      mode === "plan"
        ? modeFor(this.#modes, PLAN_NAMES)
        : modeFor(this.#modes, MODE_NAMES[this.info.runtimeMode]);
    if (!target) throw new Error(`${this.#spec.label} has no plan mode`);
    await this.#request("session/set_mode", { sessionId: started(this.info), modeId: target.id });
    this.info.interactionMode = mode;
    this.#events.info(this.info);
  }

  async setModel(model: string | null): Promise<void> {
    if (!this.#modelOption())
      throw new Error(`${this.#spec.label} does not let 1harness choose its model`);
    if (!model) throw new Error(`${this.#spec.label} has no default model to go back to`);
    await this.#request("session/set_config_option", {
      sessionId: started(this.info),
      configId: "model",
      value: model,
    });
    this.info.model = model;
    this.#events.info(this.info);
  }

  async listModels(): Promise<ModelOption[]> {
    const option = this.#modelOption();
    return (option?.options ?? []).map((choice) => ({
      id: choice.value,
      aliases: [],
      label: choice.name,
      description: choice.description ?? "",
      efforts: [],
      defaultEffort: null,
      isDefault: choice.value === option?.currentValue,
    }));
  }

  async listCommands(): Promise<NativeCommand[]> {
    return this.#translator.commands;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    if (!this.#canList) return [];
    const response = await this.#request<{
      sessions: { sessionId: string; title?: string | null; updatedAt?: string | null }[];
    }>("session/list", { cwd: this.info.cwd });
    return response.sessions.map((session) => ({
      id: session.sessionId,
      title: session.title ?? session.sessionId,
      updatedAt: session.updatedAt ? Date.parse(session.updatedAt) : 0,
    }));
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#events.cancelAll();
    await this.#rpc?.close();
    // A session whose start failed before the agent ran has no process to report the end.
    this.#events.close(this.#turnId, "closed", true);
  }

  #modelOption(): AcpConfigOption | undefined {
    return this.#config.find((option) => option.id === "model");
  }

  #applyModes(modes: SessionResponse["modes"]): void {
    this.#modes = modes?.availableModes ?? [];
    this.capabilities.runtimeModes = (
      Object.entries(MODE_NAMES) as [RuntimeMode, string[]][]
    ).flatMap(([mode, names]) => (modeFor(this.#modes, names) ? [mode] : []));
    this.capabilities.planMode = modeFor(this.#modes, PLAN_NAMES) !== undefined;
    if (modes) this.#currentMode(modes.currentModeId);
  }

  #currentMode(modeId: string): void {
    const id = modeId.toLowerCase();
    if (PLAN_NAMES.includes(id)) {
      this.info.interactionMode = "plan";
      return;
    }
    this.info.interactionMode = "default";
    const runtime = (Object.entries(MODE_NAMES) as [RuntimeMode, string[]][]).find(([, names]) =>
      names.includes(id),
    );
    // A mode 1harness cannot name may allow anything, so it counts as full access
    // until the thread is moved to one it can.
    this.info.runtimeMode = runtime ? runtime[0] : "full-access";
  }

  #endTurn(turnId: string, stopReason: string, error: string | null): void {
    if (this.#turnId !== turnId) return;
    this.#turnId = null;
    this.#events.emit(...this.#translator.flush());
    const status =
      stopReason === "cancelled"
        ? "interrupted"
        : error || stopReason === "refusal"
          ? "failed"
          : "completed";
    this.#events.emit({
      type: "turn.ended",
      turnId,
      status,
      error: error ?? (stopReason === "refusal" ? `${this.#spec.label} refused the request` : null),
    });
  }

  #notification(method: string, raw: unknown): void {
    if (method !== "session/update") return;
    const params = (raw ?? {}) as { sessionId?: string; update?: AcpUpdate };
    if (
      !params.update ||
      (params.sessionId && params.sessionId !== this.info.threadId && this.info.threadId)
    ) {
      return;
    }
    const update = params.update;
    if (update.sessionUpdate === "current_mode_update") {
      this.#currentMode(update.currentModeId);
      this.#events.info(this.info);
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      this.#events.emit({
        type: "usage.updated",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: update.used,
          contextWindow: update.size,
          costUsd: null,
          limits: [],
        },
      });
      return;
    }
    // The turn already shows its prompt, so an agent that echoes it would show it twice.
    if (update.sessionUpdate === "user_message_chunk" && this.#turnId !== null) return;
    this.#events.emit(...this.#translator.translate(update));
  }

  async #serverRequest(method: string, raw: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      // 1harness offers agents no file system or terminal of its own.
      throw new RpcError(-32601, `1harness does not handle ${method}`);
    }
    const params = (raw ?? {}) as {
      toolCall: AcpToolCall;
      options: { optionId: string; name: string; kind: string }[];
    };
    const id = `acp-request-${randomUUID()}`;
    const item = toolItem(params.toolCall);
    const detail =
      item.kind === "command"
        ? `$ ${item.command}`
        : item.kind === "file_change"
          ? item.changes.map((change) => `${change.path}\n${change.diff}`).join("\n")
          : "";
    // Choices read as on every harness, unless the agent offers two of a kind.
    const kinds = params.options.map((option) => option.kind);
    const options: ApprovalOption[] = params.options.map((option) => ({
      id: option.optionId,
      label:
        kinds.indexOf(option.kind) === kinds.lastIndexOf(option.kind)
          ? (KIND_LABELS[option.kind] ?? option.name)
          : option.name,
      effect:
        option.kind === "allow_once"
          ? "allow"
          : option.kind === "allow_always"
            ? "allow-always"
            : option.kind.startsWith("reject")
              ? "deny"
              : "other",
    }));
    const action = approvalAction(params.toolCall);
    return new Promise((resolve) => {
      this.#events.ask(
        {
          kind: "approval",
          id,
          title:
            params.toolCall.kind === "move" && item.kind === "file_change" && item.changes[0]
              ? ASK.move(fileName(item.changes[0].path))
              : item.kind === "file_change"
                ? askForChanges(item.changes)
                : askFor(action),
          // The agent's own name for the call says what it is about.
          detail: [params.toolCall.title ?? "", detail]
            .filter((line) => line.trim() !== "")
            .join("\n")
            .trim(),
          action,
          options,
          defaultOptionId: options[0]?.id ?? "",
        },
        (response) => resolve(permissionOutcome(response, params.options)),
      );
    });
  }

  #closed(reason: string): void {
    this.#events.close(this.#turnId, reason, this.#closing);
    this.#turnId = null;
  }

  /** A request the agent answers right away; a prompt, answered when its turn ends, passes null. */
  #request<T>(
    method: string,
    params: unknown,
    timeoutMs: number | null = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.#rpc) return Promise.reject(new Error("The session has not started"));
    return this.#rpc.request<T>(method, params, timeoutMs ?? undefined);
  }
}
