import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { AsyncQueue } from "../../core/async-queue.ts";
import type {
  ApprovalOption,
  Capabilities,
  HarnessEvent,
  HarnessSession,
  InteractionMode,
  McpServerConfig,
  ModeOption,
  ModelOption,
  NativeCommand,
  RequestResponse,
  RuntimeMode,
  SessionInfo,
  SessionOptions,
  ThreadSummary,
  UserInput,
} from "../../core/events.ts";
import { errorMessage } from "../../core/thread.ts";
import { JsonRpcProcess, RpcError } from "../jsonrpc.ts";
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

interface Pending {
  options: { optionId: string; kind: string }[];
  resolve: (result: unknown) => void;
}

const PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 30_000;
// Agents name their modes freely; these are the names that mean 1harness's modes.
const MODE_NAMES: Record<RuntimeMode, string[]> = {
  supervised: ["ask", "default", "read-only", "readonly", "manual", "supervised"],
  "auto-edit": ["accept-edits", "acceptedits", "auto-edit", "edit", "code"],
  auto: ["auto"],
  "full-access": ["full-access", "yolo", "bypasspermissions", "bypass", "full"],
};
const PLAN_NAMES = ["plan", "architect"];
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function modeFor(modes: readonly AcpMode[], names: readonly string[]): AcpMode | undefined {
  return modes.find((mode) => names.includes(mode.id.toLowerCase()));
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
  #events = new AsyncQueue<HarnessEvent>();
  #translator = new AcpTranslator();
  #pending = new Map<string, Pending>();
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
      model: options.model,
      effort: null,
      runtimeMode: options.runtimeMode,
      interactionMode: "default",
      version: null,
    };
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.#events;
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
      session = await rpc.request("session/load", {
        sessionId: resume,
        cwd: this.info.cwd,
        mcpServers,
      });
      session.sessionId ??= resume;
      this.#emitAll(this.#translator.flush());
    } else {
      if (resume)
        this.#notice("warning", `${this.#spec.label} cannot resume sessions; starting a new one`);
      session = await rpc.request("session/new", { cwd: this.info.cwd, mcpServers });
    }
    this.info.threadId = session.sessionId ?? null;
    this.#applyModes(session.modes ?? null);
    this.#config = session.configOptions ?? [];
    this.info.model =
      this.#config.find((option) => option.id === "model")?.currentValue ?? this.info.model;
    if (this.#options.model) await this.setModel(this.#options.model).catch(() => {});
    if (this.#modes.length > 0 && this.#options.runtimeMode !== this.info.runtimeMode) {
      await this.setRuntimeMode(this.#options.runtimeMode).catch(() => {});
    }
    this.#emitInfo();
  }

  async startTurn(input: UserInput): Promise<void> {
    const sessionId = this.#sessionId();
    const turnId = randomUUID();
    this.#turnId = turnId;
    this.#emit({ type: "turn.started", turnId });
    this.#emit({
      type: "item.completed",
      item: { kind: "user_message", id: `acp-user-${turnId}`, text: input.text },
    });
    const prompt: unknown[] = [{ type: "text", text: input.text }];
    for (const path of input.images ?? []) {
      prompt.push({
        type: "image",
        mimeType: IMAGE_TYPES[extname(path).toLowerCase()] ?? "image/png",
        data: readFileSync(path).toString("base64"),
      });
    }
    // The request answers only when the turn is over.
    void this.#request<{
      stopReason: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>("session/prompt", { sessionId, prompt }).then(
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
    for (const [id, pending] of this.#pending) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.#pending.delete(id);
      this.#emit({ type: "request.resolved", requestId: id });
    }
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    let optionId: string | undefined;
    if (response.kind === "approval") optionId = response.optionId;
    // Declining picks the agent's own one-time rejection, which lets it go on.
    if (response.kind === "decline")
      optionId = pending.options.find((option) => option.kind === "reject_once")?.optionId;
    pending.resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.#emit({ type: "request.resolved", requestId });
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    const target = modeFor(this.#modes, MODE_NAMES[mode]);
    if (!target) throw new Error(`${this.#spec.label} has no ${mode} mode`);
    await this.#request("session/set_mode", { sessionId: this.#sessionId(), modeId: target.id });
    this.info.runtimeMode = mode;
    this.info.interactionMode = "default";
    this.#emitInfo();
  }

  async setInteractionMode(mode: InteractionMode): Promise<void> {
    const target =
      mode === "plan"
        ? modeFor(this.#modes, PLAN_NAMES)
        : modeFor(this.#modes, MODE_NAMES[this.info.runtimeMode]);
    if (!target) throw new Error(`${this.#spec.label} has no plan mode`);
    await this.#request("session/set_mode", { sessionId: this.#sessionId(), modeId: target.id });
    this.info.interactionMode = mode;
    this.#emitInfo();
  }

  async setModel(model: string | null): Promise<void> {
    const option = this.#config.find((entry) => entry.id === "model");
    if (!option || !model) return;
    await this.#request("session/set_config_option", {
      sessionId: this.#sessionId(),
      configId: "model",
      value: model,
    });
    this.info.model = model;
    this.#emitInfo();
  }

  async listModels(): Promise<ModelOption[]> {
    const option = this.#config.find((entry) => entry.id === "model");
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
    for (const pending of this.#pending.values())
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.#pending.clear();
    await this.#rpc?.close();
  }

  #applyModes(modes: SessionResponse["modes"]): void {
    this.#modes = modes?.availableModes ?? [];
    const runtimeModes: ModeOption[] = [];
    for (const [mode, names] of Object.entries(MODE_NAMES) as [RuntimeMode, string[]][]) {
      const match = modeFor(this.#modes, names);
      if (match) runtimeModes.push({ id: mode, description: match.description ?? match.name });
    }
    this.capabilities.runtimeModes = runtimeModes;
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
    if (runtime) this.info.runtimeMode = runtime[0];
  }

  #endTurn(turnId: string, stopReason: string, error: string | null): void {
    if (this.#turnId !== turnId) return;
    this.#turnId = null;
    this.#emitAll(this.#translator.flush());
    const status =
      stopReason === "cancelled"
        ? "interrupted"
        : error || stopReason === "refusal"
          ? "failed"
          : "completed";
    this.#emit({
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
      this.#currentMode(String((update as { currentModeId: string }).currentModeId));
      this.#emitInfo();
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      const usage = update as { used: number; size: number };
      this.#emit({
        type: "usage.updated",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: usage.used,
          contextWindow: usage.size,
          costUsd: null,
          limits: [],
        },
      });
      return;
    }
    this.#emitAll(this.#translator.translate(update));
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
    const options: ApprovalOption[] = params.options.map((option) => ({
      id: option.optionId,
      label: option.name,
      effect:
        option.kind === "allow_once"
          ? "allow"
          : option.kind === "allow_always"
            ? "allow-always"
            : option.kind.startsWith("reject")
              ? "deny"
              : "other",
    }));
    return new Promise((resolve) => {
      this.#pending.set(id, { options: params.options, resolve });
      this.#emit({
        type: "request.opened",
        request: {
          kind: "approval",
          id,
          title: params.toolCall.title ?? `Allow ${this.#spec.label} to continue?`,
          detail: detail.trim(),
          action: approvalAction(params.toolCall),
          options,
          defaultOptionId: options[0]?.id ?? "",
        },
      });
    });
  }

  #closed(reason: string): void {
    if (this.#turnId !== null) {
      this.#emit({
        type: "turn.ended",
        turnId: this.#turnId,
        status: this.#closing ? "interrupted" : "failed",
        error: this.#closing ? null : reason,
      });
      this.#turnId = null;
    }
    this.#emit({ type: "session.closed", error: this.#closing ? null : reason });
    this.#events.end();
  }

  #sessionId(): string {
    if (!this.info.threadId) throw new Error(`The ${this.#spec.label} session has not started`);
    return this.info.threadId;
  }

  #request<T>(method: string, params: unknown): Promise<T> {
    if (!this.#rpc) return Promise.reject(new Error(`${this.#spec.label} has not started`));
    return this.#rpc.request<T>(method, params);
  }

  #notice(level: "info" | "warning" | "error", text: string): void {
    this.#emit({
      type: "item.completed",
      item: { kind: "notice", id: `acp-notice-${randomUUID()}`, level, text },
    });
  }

  #emit(event: HarnessEvent): void {
    this.#events.push(event);
  }

  #emitAll(events: HarnessEvent[]): void {
    for (const event of events) this.#emit(event);
  }

  #emitInfo(): void {
    this.#emit({ type: "session.updated", info: { ...this.info } });
  }
}
