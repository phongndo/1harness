import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  fitRuntimeMode,
  type Capabilities,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessSession,
  type InteractionMode,
  type McpServer,
  type McpServerState,
  type ModelOption,
  type NativeCommand,
  type RequestResponse,
  type RuntimeMode,
  type SessionInfo,
  type SessionOptions,
  type ThreadSummary,
  type TurnStatus,
  type UserInput,
} from "../../core/events.ts";
import { errorMessage } from "../../core/errors.ts";
import { steppedDown } from "../../core/wording.ts";
import { readImage } from "../images.ts";
import { SessionEvents, started } from "../session-events.ts";
import { slashCommand } from "../text.ts";
import { OpenCodeServer } from "./server.ts";
import {
  OpenCodeTranslator,
  RUNTIME_MODES,
  findModel,
  formAnswer,
  formRequest,
  mergeRules,
  modelName,
  modelOptions,
  permissionRequest,
  sessionRules,
  type OcAgent,
  type OcEvent,
  type OcMessage,
  type OcModel,
  type OcModelRef,
  type OcRule,
} from "./translate.ts";

export interface OpenCodeSessionConfig extends SessionOptions {
  command: string;
}

interface OcSession {
  id: string;
  title?: string;
  agent?: string;
  model?: OcModelRef;
  permissions?: OcRule[];
  time: { updated: number };
}

/** A message sent and not yet delivered, until its inbox entry is known. */
interface Sent {
  input: UserInput;
  /** What its inbox entry holds; a command's entry holds the command's expansion. */
  text: string | null;
  inboxId: string | null;
}

const PLAN_AGENT = "plan";
const LABEL = "OpenCode";
const MCP_STATES: Record<string, McpServerState> = {
  connected: "connected",
  pending: "starting",
  disabled: "disabled",
  failed: "failed",
  needs_auth: "needs-login",
};

/**
 * Drives OpenCode 2 through its server API: a private `opencode serve` per
 * session, one OpenCode session in it, and the server's event stream.
 */
export class OpenCodeSession implements HarnessSession {
  readonly capabilities: Capabilities = {
    steer: true,
    planMode: false,
    runtimeModes: RUNTIME_MODES,
    images: false,
    toolChecks: false,
    nativeSlashCommands: true,
    mcpActions: [],
  };
  readonly info: SessionInfo;
  #config: OpenCodeSessionConfig;
  #server: OpenCodeServer | null = null;
  #events = new SessionEvents("opencode");
  #translator: OpenCodeTranslator;
  #models: OcModel[] = [];
  #defaultModel: string | null = null;
  #agents: OcAgent[] = [];
  /** The agent the session runs outside plan mode. */
  #mainAgent = "build";
  #agent = "build";
  #commands: (NativeCommand & { skill?: string })[] = [];
  /** The session and the sessions its subagents run in. */
  #family = new Set<string>();
  #sent: Sent[] = [];
  /** What each inbox entry holds, until it is delivered. */
  #inbox = new Map<string, string>();
  /** Requests the session itself opened, which its turn's end withdraws. */
  #ownRequests = new Set<string>();
  #turnId: string | null = null;
  /** Esc came before the turn's execution started, so it stops once it does. */
  #interruptRequested = false;
  #closing = false;

  constructor(config: OpenCodeSessionConfig) {
    this.#config = config;
    this.#translator = new OpenCodeTranslator(config.cwd);
    this.info = {
      harness: "opencode",
      threadId: config.resume,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      runtimeMode: config.runtimeMode,
      interactionMode: "default",
      version: null,
    };
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.#events.stream;
  }

  async start(): Promise<void> {
    const server = new OpenCodeServer(this.#config.command, this.info.cwd, process.env);
    this.#server = server;
    void server.exited.then((reason) => this.#finish(reason));
    await server.ready();
    try {
      this.info.version = (await server.request<{ version: string }>("GET", "/api/info")).version;
    } catch (error) {
      throw new Error(
        `1harness needs OpenCode 2, whose server this is not: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    // Events are not kept for late subscribers, so the stream opens before any work.
    const { done } = await server.subscribe((event) => {
      try {
        this.#receive(event);
      } catch (error) {
        // An event read wrong should not end the session, so it is reported instead.
        this.#events.notice(
          "warning",
          `Could not follow OpenCode's ${event.type}: ${errorMessage(error)}`,
        );
      }
    });
    done.then(
      () => this.#finish("OpenCode's event stream ended"),
      (error: unknown) => this.#finish(errorMessage(error)),
    );
    const [agents, models, fallback] = await Promise.all([
      this.#data<OcAgent[]>("/api/agent"),
      this.#data<OcModel[]>("/api/model"),
      this.#data<OcModel | null>("/api/model/default"),
      this.#loadCommands(),
    ]);
    this.#agents = agents;
    this.#models = models;
    this.#defaultModel = fallback ? modelName(fallback) : null;
    const main = agents.find((agent) => agent.id === "build" && agent.mode !== "subagent");
    this.#mainAgent =
      main?.id ?? agents.find((agent) => agent.mode === "primary" && !agent.hidden)?.id ?? "build";
    this.capabilities.planMode = agents.some(
      (agent) => agent.id === PLAN_AGENT && agent.mode !== "subagent",
    );
    await this.#addMcpServers();

    const requested = this.#config.runtimeMode;
    const mode = fitRuntimeMode(requested, RUNTIME_MODES) ?? "supervised";
    if (mode !== requested)
      this.#events.notice("warning", steppedDown(`${LABEL} has no ${requested} mode`, mode));
    const plan = this.#config.interactionMode === "plan" && this.capabilities.planMode;
    this.#agent = plan ? PLAN_AGENT : this.#mainAgent;
    const { model: name, effort } = this.#config;
    const model = name ? findModel(models, name) : undefined;
    if (name && !model) this.#events.notice("warning", `${this.#noModel(name)}; using its default`);

    let session: OcSession;
    const resume = this.#config.resume;
    if (resume) {
      session = await this.#data<OcSession>(`/api/session/${resume}`);
      this.info.threadId = session.id;
      await this.#applyRules(mode, plan);
      if ((session.agent ?? this.#mainAgent) !== this.#agent)
        await this.#post(`/api/session/${session.id}/agent`, { agent: this.#agent });
      const ref = this.#requestedModel(
        model ?? (session.model && findModel(models, modelName(session.model))),
        effort,
      );
      if (ref) {
        await this.#post(`/api/session/${session.id}/model`, { model: ref });
        session.model = ref;
      }
      this.#events.emit(...this.#translator.history(await this.#history(session.id)));
    } else {
      const ref = this.#requestedModel(model, effort);
      session = await this.#data<OcSession>("/api/session", "POST", {
        location: { directory: this.info.cwd },
        ...(plan ? { agent: PLAN_AGENT } : {}),
        ...(ref ? { model: ref } : {}),
        permissions: sessionRules(mode, this.#agentInfo(), plan),
      });
    }
    this.#family.add(session.id);
    this.info.threadId = session.id;
    this.info.runtimeMode = mode;
    this.info.interactionMode = plan ? "plan" : "default";
    this.#applyModel(session.model ?? this.#fallbackRef());
    this.#events.info(this.info);
  }

  async startTurn(input: UserInput): Promise<void> {
    await this.#send(input, "queue");
  }

  async steer(input: UserInput): Promise<void> {
    if (this.#turnId === null) throw new Error("No turn is running");
    await this.#send(input, "steer");
  }

  async interrupt(): Promise<void> {
    if (!this.info.threadId) return;
    if (this.#turnId === null) this.#interruptRequested = this.#sent.length > 0;
    await this.#post(`/api/session/${this.info.threadId}/interrupt`);
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    await this.#events.answer(requestId, response);
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    if (!RUNTIME_MODES.includes(mode)) throw new Error(`${LABEL} has no ${mode} mode`);
    await this.#applyRules(mode, this.info.interactionMode === "plan");
    this.info.runtimeMode = mode;
    this.#events.info(this.info);
  }

  async setInteractionMode(mode: InteractionMode): Promise<void> {
    if (mode === "plan" && !this.capabilities.planMode)
      throw new Error(`${LABEL} has no plan mode`);
    const sessionId = started(this.info);
    const previous = this.#agent;
    // Set first, so OpenCode's word of the switch is known as this one.
    this.#agent = mode === "plan" ? PLAN_AGENT : this.#mainAgent;
    try {
      await this.#post(`/api/session/${sessionId}/agent`, { agent: this.#agent });
    } catch (error) {
      this.#agent = previous;
      throw error;
    }
    await this.#applyRules(this.info.runtimeMode, mode === "plan");
    this.info.interactionMode = mode;
    this.#events.info(this.info);
  }

  async setModel(model: string | null): Promise<void> {
    const target = model ? findModel(this.#models, model) : undefined;
    if (model && !target) throw new Error(this.#noModel(model));
    const ref = target ? this.#modelRef(target, this.info.effort) : this.#fallbackRef();
    if (!ref) return;
    await this.#post(`/api/session/${started(this.info)}/model`, { model: ref });
    this.#applyModel(ref);
    this.#events.info(this.info);
  }

  async setEffort(effort: string | null): Promise<void> {
    const current = this.info.model ? findModel(this.#models, this.info.model) : undefined;
    if (!current) return;
    const ref = this.#modelRef(current, effort);
    if (effort && ref.variant !== effort)
      throw new Error(`${modelName(current)} has no effort ${effort}`);
    await this.#post(`/api/session/${started(this.info)}/model`, { model: ref });
    this.#applyModel(ref);
    this.#events.info(this.info);
  }

  async compact(): Promise<void> {
    await this.#post(`/api/session/${started(this.info)}/compact`, {});
  }

  async listModels(): Promise<ModelOption[]> {
    return modelOptions(this.#models, this.#defaultModel);
  }

  async listCommands(): Promise<NativeCommand[]> {
    await this.#loadCommands();
    return this.#commands.map(({ skill: _skill, ...command }) => command);
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const query = new URLSearchParams({
      directory: this.info.cwd,
      parentID: "null",
      order: "desc",
      limit: "50",
    });
    const sessions = await this.#data<OcSession[]>(`/api/session?${query}`);
    // The session this thread runs is not one to resume.
    return sessions
      .filter((session) => session.id !== this.info.threadId)
      .map((session) => ({
        id: session.id,
        title: session.title ?? session.id,
        updatedAt: session.time.updated,
      }));
  }

  async listMcpServers(): Promise<McpServer[]> {
    const servers =
      await this.#data<{ name: string; status: { status: string; error?: string } }[]>("/api/mcp");
    return servers.map((server) => ({
      name: server.name,
      state: MCP_STATES[server.status.status] ?? "failed",
      source: null,
      transport: null,
      target: null,
      auth: null,
      error: server.status.error ?? null,
      tools: [],
    }));
  }

  mcpCallId(meta: Record<string, unknown>, tool: string): string | null {
    // OpenCode says only which session calls, so the call is the one of that tool running in it.
    if (meta["ai.opencode/sessionID"] !== this.info.threadId) return null;
    const [only, ...others] = this.#translator.running(tool);
    return only && others.length === 0 ? only : null;
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#server?.close();
    this.#finish("closed");
  }

  /** Sends a message, or the command or skill it names, and notes it to match its echo. */
  async #send(input: UserInput, delivery: "queue" | "steer"): Promise<void> {
    const sessionId = started(this.info);
    const named = slashCommand(input.text);
    const command = named ? this.#commands.find((entry) => entry.name === named.name) : undefined;
    const args = named?.args ?? "";
    const prompt = command?.skill ? args : input.text;
    const sent: Sent = { input, text: command && !command.skill ? null : prompt, inboxId: null };
    this.#sent.push(sent);
    try {
      if (command && !command.skill) {
        await this.#post(`/api/session/${sessionId}/command`, {
          name: command.name,
          text: args,
          delivery,
        });
        return;
      }
      const response = await this.#data<{ id: string }>(
        `/api/session/${sessionId}/prompt`,
        "POST",
        {
          text: prompt,
          ...(command?.skill ? { skills: [{ id: command.skill }] } : {}),
          ...(input.images?.length ? { files: input.images.map(imageFile) } : {}),
          delivery,
        },
      );
      // Its inbox entry may have arrived first, matched by its text.
      if (!this.#sent.some((entry) => entry.inboxId === response.id)) sent.inboxId = response.id;
    } catch (error) {
      this.#sent = this.#sent.filter((entry) => entry !== sent);
      if (this.#sent.length === 0) this.#interruptRequested = false;
      throw error;
    }
  }

  #receive(event: OcEvent): void {
    if (event.type === "form.created") {
      const form = event.data.form;
      if (!this.#family.has(form.sessionID)) return;
      const path = `/api/session/${form.sessionID}/form/${form.id}`;
      this.#ask(form.sessionID, formRequest(form), (response) => {
        if (response.kind === "question")
          return this.#post(`${path}/reply`, { answer: formAnswer(form, response.answers) });
        const reason =
          response.kind === "decline" ? `?message=${encodeURIComponent(response.reason)}` : "";
        return this.#request("DELETE", `${path}${reason}`);
      });
      return;
    }
    const sessionId = event.data.sessionID ?? "";
    if (event.type === "session.created" && this.#family.has(String(event.data.parentID))) {
      this.#family.add(sessionId);
      return;
    }
    if (!this.#family.has(sessionId)) return;
    const own = sessionId === this.info.threadId;
    switch (event.type) {
      case "permission.asked": {
        const permission = event.data;
        if (own) this.#events.emit(...this.#translator.translate(event));
        const call =
          own && permission.source ? this.#translator.tool(permission.source.id) : undefined;
        const path = `/api/session/${sessionId}/permission/${permission.id}/reply`;
        this.#ask(sessionId, permissionRequest(permission, call, this.info.cwd), (response) =>
          // Rejecting stops the turn; a reason lets the agent carry on without the action.
          this.#post(
            path,
            response.kind === "approval"
              ? { decision: response.optionId }
              : response.kind === "decline"
                ? { decision: "reject", message: response.reason }
                : { decision: "reject" },
          ),
        );
        return;
      }
      case "permission.replied":
        this.#events.withdraw(event.data.requestID);
        return;
      case "form.replied":
      case "form.cancelled":
        this.#events.withdraw(event.data.id);
        return;
    }
    // A subagent's own work shows in the call that started it.
    if (!own) return;
    switch (event.type) {
      case "session.execution.started":
        if (this.#turnId !== null) return;
        this.#turnId = randomUUID();
        this.#events.emit({ type: "turn.started", turnId: this.#turnId });
        if (this.#interruptRequested) {
          this.#interruptRequested = false;
          void this.interrupt().catch((error: unknown) =>
            this.#events.notice("warning", `Interrupt failed: ${errorMessage(error)}`),
          );
        }
        return;
      case "session.execution.succeeded":
        this.#endTurn("completed", null);
        return;
      case "session.execution.failed":
        this.#endTurn("failed", event.data.error?.message ?? "OpenCode failed");
        return;
      case "session.execution.interrupted":
        if (event.data.reason === "inactivity")
          this.#endTurn("failed", `${LABEL} stopped a turn that went quiet`);
        else this.#endTurn("interrupted", null);
        return;
      case "session.inbox.enqueued": {
        const { item, inboxID: id } = event.data;
        if (item.type !== "user") return;
        const text = item.payload?.text ?? "";
        this.#inbox.set(id, text);
        if (this.#sent.some((entry) => entry.inboxId === id)) return;
        const sent =
          this.#sent.find((entry) => entry.inboxId === null && entry.text === text) ??
          this.#sent.find((entry) => entry.inboxId === null && entry.text === null);
        if (sent) sent.inboxId = id;
        return;
      }
      case "session.inbox.delivered":
        this.#delivered(event.data.inboxID);
        return;
      case "session.inbox.cancelled": {
        const id = event.data.inboxID;
        this.#inbox.delete(id);
        this.#sent = this.#sent.filter((entry) => entry.inboxId !== id);
        return;
      }
      case "session.model.selected":
        this.#applyModel(event.data.model);
        this.#events.info(this.info);
        return;
      case "session.agent.selected": {
        const agent = event.data.agent;
        if (agent === this.#agent) return;
        // OpenCode switched by itself, as for a command that names an agent; the rules follow.
        this.#agent = agent;
        const plan = agent === PLAN_AGENT;
        this.info.interactionMode = plan ? "plan" : "default";
        this.#events.info(this.info);
        this.#applyRules(this.info.runtimeMode, plan).catch((error: unknown) =>
          this.#events.notice(
            "warning",
            `Could not apply ${this.info.runtimeMode} to agent ${agent}: ${errorMessage(error)}`,
          ),
        );
        return;
      }
      default:
        this.#events.emit(...this.#translator.translate(event));
    }
  }

  /** Shows a message as it reaches the agent, with the input it came from where known. */
  #delivered(inboxId: string): void {
    const sent = this.#sent.find((entry) => entry.inboxId === inboxId);
    const text = sent?.input.text ?? this.#inbox.get(inboxId) ?? "";
    this.#inbox.delete(inboxId);
    if (sent) this.#sent = this.#sent.filter((entry) => entry !== sent);
    if (!text) return;
    this.#events.emit({
      type: "item.completed",
      item: {
        kind: "user_message",
        id: inboxId,
        text,
        ...(sent?.input.id ? { inputId: sent.input.id } : {}),
      },
    });
  }

  #endTurn(status: TurnStatus, error: string | null): void {
    const turnId = this.#turnId;
    if (turnId === null) return;
    this.#turnId = null;
    this.#interruptRequested = false;
    this.#events.emit(...this.#translator.flush());
    // A request of the session's own still open will not be answered; a
    // subagent's may be, since subagents can work on in the background.
    for (const id of this.#ownRequests) this.#events.withdraw(id);
    this.#ownRequests.clear();
    // A command whose entry never came adds nothing to the inbox, so it waits for nothing.
    this.#sent = this.#sent.filter((entry) => entry.text !== null || entry.inboxId !== null);
    this.#events.emit({ type: "turn.ended", turnId, status, error });
  }

  /** Opens a request; one of the session's own ends with its turn. */
  #ask(
    sessionId: string,
    request: HarnessRequest,
    answer: (response: RequestResponse) => Promise<unknown>,
  ): void {
    if (sessionId === this.info.threadId) this.#ownRequests.add(request.id);
    this.#events.ask(request, answer);
  }

  #finish(reason: string): void {
    if (this.#events.closed) return;
    this.#events.close(this.#turnId, reason, this.#closing);
    this.#turnId = null;
    void this.#server?.close();
  }

  async #addMcpServers(): Promise<void> {
    // Each connects as it is added, so they are added together.
    const added = Object.entries(this.#config.mcpServers ?? {}).map(async ([name, server]) => {
      // Its tools are called directly, not from code, so they show as calls of their own.
      const config =
        server.type === "http"
          ? {
              type: "remote",
              url: server.url,
              headers: server.headers,
              oauth: false,
              codemode: false,
              ...(server.timeoutSec ? { timeout: { execution: server.timeoutSec * 1000 } } : {}),
            }
          : {
              type: "local",
              command: [server.command, ...server.args],
              environment: server.env,
              codemode: false,
            };
      await this.#request("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, {
        config,
      }).catch((error: unknown) =>
        this.#events.notice("warning", `Could not add MCP server ${name}: ${errorMessage(error)}`),
      );
    });
    await Promise.all(added);
    // Unlisted servers leave their tools under the names OpenCode joins them by.
    const servers = await this.#list<{ name: string }>("/api/mcp", "MCP servers");
    this.#translator.mcpServers = servers.map((server) => server.name);
  }

  async #loadCommands(): Promise<void> {
    const [commands, skills] = await Promise.all([
      this.#list<{ name: string; description?: string }>("/api/command", "commands"),
      this.#list<{ id: string; name: string; description?: string }>("/api/skill", "skills"),
    ]);
    this.#commands = [
      ...commands.map((command) => ({
        name: command.name,
        aliases: [],
        description: command.description ?? "",
        argumentHint: "",
        kind: "command" as const,
        startsTurn: true,
      })),
      ...skills.map((skill) => ({
        name: skill.id,
        aliases: [],
        description: skill.description ?? skill.name,
        argumentHint: "",
        kind: "skill" as const,
        startsTurn: true,
        skill: skill.id,
      })),
    ];
  }

  async #history(sessionId: string): Promise<OcMessage[]> {
    const messages: OcMessage[] = [];
    let cursor: string | null | undefined;
    do {
      const query = new URLSearchParams(
        cursor ? { cursor, limit: "200" } : { order: "asc", limit: "200" },
      );
      const page = await this.#request<{ data: OcMessage[]; cursor: { next?: string | null } }>(
        "GET",
        `/api/session/${sessionId}/message?${query}`,
      );
      messages.push(...page.data);
      cursor = page.data.length > 0 ? page.cursor.next : null;
    } while (cursor);
    return messages;
  }

  #modelRef(model: OcModel, effort: string | null): OcModelRef {
    const variant =
      effort && model.variants.some((entry) => entry.id === effort) ? effort : undefined;
    return { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) };
  }

  /**
   * The model a thread asks for, with its effort: the named model or the one it
   * runs, or nothing when it asks for neither, so OpenCode keeps its own choice.
   */
  #requestedModel(model: OcModel | undefined, effort: string | null): OcModelRef | undefined {
    if (!model && !effort) return undefined;
    const base =
      model ?? (this.#defaultModel ? findModel(this.#models, this.#defaultModel) : undefined);
    if (!base) return undefined;
    const ref = this.#modelRef(base, effort);
    if (effort && ref.variant !== effort)
      this.#events.notice("warning", `${modelName(base)} has no effort ${effort}`);
    return model || ref.variant ? ref : undefined;
  }

  /** Why a model name finds nothing: no such model, or several providers with it. */
  #noModel(name: string): string {
    const providers = this.#models.filter((model) => model.enabled && model.id === name);
    return providers.length > 1
      ? `Several providers offer ${name}; name one as provider/model`
      : `${LABEL} has no model ${name}`;
  }

  /** Puts the rules for a mode on the session, keeping the ones OpenCode added. */
  async #applyRules(mode: RuntimeMode, plan: boolean): Promise<void> {
    const sessionId = started(this.info);
    const current = (await this.#data<OcSession>(`/api/session/${sessionId}`)).permissions ?? [];
    const permissions = mergeRules(
      current,
      sessionRules(mode, this.#agentInfo(), plan),
      this.#agents,
    );
    await this.#request("PATCH", `/api/session/${sessionId}`, { permissions });
  }

  #fallbackRef(): OcModelRef | undefined {
    const model = this.#defaultModel ? findModel(this.#models, this.#defaultModel) : undefined;
    return model ? this.#modelRef(model, null) : undefined;
  }

  #applyModel(ref: OcModelRef | undefined): void {
    if (!ref) return;
    this.info.model = modelName(ref);
    this.info.effort = ref.variant && ref.variant !== "default" ? ref.variant : null;
    const model = findModel(this.#models, this.info.model);
    this.#translator.contextWindow = model?.limit.context ?? null;
    this.capabilities.images = model?.capabilities.input.includes("image") ?? false;
  }

  #agentInfo(): OcAgent | undefined {
    return this.#agents.find((agent) => agent.id === this.#agent);
  }

  /** A listing the session goes on without, saying so if it fails. */
  async #list<T>(path: string, what: string): Promise<T[]> {
    try {
      return await this.#data<T[]>(path);
    } catch (error) {
      this.#events.notice("warning", `Could not list ${LABEL}'s ${what}: ${errorMessage(error)}`);
      return [];
    }
  }

  /** A request's `data`, which every read answers with. */
  async #data<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    return (await this.#request<{ data: T }>(method, path, body)).data;
  }

  #post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.#server) return Promise.reject(new Error("The session has not started"));
    return this.#server.request<T>(method, path, body);
  }
}

/** An image as a prompt attachment, inline. */
function imageFile(path: string): { uri: string; name: string } {
  const { type, data } = readImage(path);
  return { uri: `data:${type};base64,${data}`, name: basename(path) };
}
