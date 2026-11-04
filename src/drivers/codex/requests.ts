import type {
  ApprovalAction,
  ApprovalOption,
  ApprovalRequest,
  FileChange,
  HarnessRequest,
  RequestResponse,
} from "../../core/events.ts";
import { GATEWAY_ACT, GATEWAY_READ, gatewayCall, TOOL_SERVER } from "../../core/tools.ts";
import { record, text } from "../../core/values.ts";
import { ANSWER, ASK, askForChanges } from "../../core/wording.ts";
import { unwrapShell } from "./translate.ts";

// Codex's requests of the user in 1harness's shape, and the user's answers in Codex's.

/** A server request waiting on the user, with what is needed to build the native reply. */
export interface NativeRequest {
  method: string;
  params: Record<string, unknown>;
  /** The native decision behind each option ID. */
  decisions: Map<string, unknown>;
}

/**
 * The request shown to the user for one Codex sends, filling in the decision
 * behind each option; null declines it without asking. `threadId` is the
 * session's own thread, and `fileChanges` the diffs of its edits by item.
 */
export function codexRequest(
  id: string,
  native: NativeRequest,
  context: { threadId: string | null; fileChanges: ReadonlyMap<string, FileChange[]> },
): HarnessRequest | null {
  const { method, params, decisions } = native;
  const reason = text(params["reason"]);
  // Codex's own agents run in their own threads and ask through the parent's connection.
  const agent = typeof params["threadId"] === "string" && params["threadId"] !== context.threadId;
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
      const changes = context.fileChanges.get(String(params["itemId"])) ?? [];
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

  const command = unwrapShell(text(params["command"]));
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

/** An approval without its empty detail lines, whose first option is the default. */
export function approval(
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
  const rule = amendment(decision);
  if (rule?.kind === "command") {
    // A prefix such as [shell, "-lc", command] names the command inside the shell.
    const tokens = rule.prefix;
    const prefix =
      tokens.length === 3 && /^-l?c$/.test(tokens[1] ?? "") ? (tokens[2] ?? "") : tokens.join(" ");
    return ANSWER.always(`commands starting with \`${prefix}\``);
  }
  if (rule?.kind === "network")
    return rule.deny ? ANSWER.never(rule.host) : ANSWER.always(rule.host);
  return JSON.stringify(decision);
}

/** The rule a decision adds, which Codex keeps beyond the session. */
function amendment(
  decision: unknown,
): { kind: "command"; prefix: string[] } | { kind: "network"; host: string; deny: boolean } | null {
  const fields = record(decision);
  const command = record(fields["acceptWithExecpolicyAmendment"])["execpolicy_amendment"];
  if (Array.isArray(command)) return { kind: "command", prefix: command.map(String) };
  const network = record(fields["applyNetworkPolicyAmendment"])["network_policy_amendment"];
  if (!network) return null;
  const rule = record(network);
  return { kind: "network", host: text(rule["host"]), deny: rule["action"] === "deny" };
}

function describePermissions(permissions: unknown): string {
  return Object.entries(record(permissions))
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
  const schema = record(params["requestedSchema"]) as {
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

  // Codex names only the gateway, but sends the call with its approval.
  const gateway =
    server === TOOL_SERVER
      ? [GATEWAY_READ, GATEWAY_ACT].find((tool) => message.includes(tool))
      : null;
  const inner = gateway
    ? gatewayCall(server, gateway, record(params["_meta"])["tool_params"])
    : null;
  const once = content(null);
  if (once) {
    const options = [option(ANSWER.yes, { action: "accept", content: once, _meta: null })];
    // Remembering the gateway would allow every tool behind it.
    for (const persist of gateway ? [] : (["session", "always"] as const)) {
      const remembered = content(persist);
      const offered = fields.some(([key, field]) =>
        [key, field.title ?? "", ...fieldChoices(field).map((choice) => choice.value)].some(
          (word) => persistence(word) === persist,
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
    return inner && gateway
      ? approval(
          id,
          `${server}: ${message.replace(gateway, inner.tool)}`,
          { type: "tool", tool: inner.tool, server, input: inner.input },
          [],
          options,
        )
      : approval(id, `${server}: ${message}`, { type: "other" }, [], options);
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

/** What choosing a native decision does, for code that answers approvals. */
export function decisionEffect(decision: unknown): ApprovalOption["effect"] {
  if (decision === "accept" || decision === "turn") return "allow";
  if (decision === "acceptForSession" || decision === "session") return "allow-always";
  if (decision === "decline" || decision === "cancel" || decision === "deny") return "deny";
  const rule = amendment(decision);
  if (rule) return rule.kind === "network" && rule.deny ? "deny" : "allow-always";
  // An MCP elicitation reply.
  const reply = record(decision);
  const action = reply["action"];
  if (action === "accept") return record(reply["_meta"])["persist"] ? "allow-always" : "allow";
  if (action === "decline" || action === "cancel") return "deny";
  return "other";
}

/** Builds the native reply. Option IDs map back to the decisions Codex offered. */
export function codexResponse(request: NativeRequest, response: RequestResponse): unknown {
  const { method, params, decisions } = request;

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
      const schema = record(params["requestedSchema"]) as {
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
      const requested = record(params["permissions"]);
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
