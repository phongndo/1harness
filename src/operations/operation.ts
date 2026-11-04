// What 1harness can do, defined once and offered everywhere: to agents in the
// threads it runs as tools on their `1harness` MCP server, to agents it does
// not run through `1harness mcp` and the server's `/mcp`, to programs and
// editors through the server's `operations.call`, and to people through
// `1harness op` and `/op`. Each operation says who may call it, and checks
// what each caller may see and do.

import type { RuntimeMode } from "../core/events.ts";
import type { Thread } from "../core/thread.ts";

/** Who calls an operation, which decides what it may see and do. */
export type CallerKind = "user" | "agent" | "external";

export const CALLER_KINDS: readonly CallerKind[] = ["user", "agent", "external"];

export type Caller =
  /** A person: a terminal, the CLI, an editor over ACP, or a program using the server's API. */
  | { kind: "user"; clientId: string }
  /** An agent in a thread 1harness runs, through its session's `1harness` MCP server. */
  | { kind: "agent"; thread: Thread; callId: string | null }
  /**
   * An agent 1harness does not run, through `1harness mcp` or the server's
   * `/mcp`: it sees every thread but acts on none allowed more than `ceiling`.
   */
  | { kind: "external"; clientId: string; ceiling: RuntimeMode };

export interface OperationContext {
  readonly caller: Caller;
}

/**
 * One thing 1harness can do. Its result is JSON, or text; MCP content, such
 * as an image, passes through as `{ content: [...] }`.
 */
export interface Operation {
  /** Letters, digits, `_` and `-`, so it is a tool name as it is. */
  name: string;
  description: string;
  /** JSON Schema for the input, an object schema. */
  inputSchema: Record<string, unknown>;
  /** A read changes nothing, so harnesses may run it with fewer prompts. */
  effect: "read" | "act";
  callers: readonly CallerKind[];
  /** For agents in threads, by name rather than through `tool_search`. */
  direct?: boolean;
  run(input: Record<string, unknown>, context: OperationContext): unknown;
}

/** An operation as a client lists it. */
export type OperationInfo = Omit<Operation, "run">;

export const OPERATION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A refusal a caller can act on: a stable code and a sentence. */
export class OperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function operationInfo({ name, description, inputSchema, effect, callers }: Operation) {
  return { name, description, inputSchema, effect, callers: [...callers] };
}

/** Checks that `caller` may call `operation`, then calls it. */
export async function runOperation(
  operation: Operation | undefined,
  name: string,
  input: unknown,
  caller: Caller,
): Promise<unknown> {
  if (!operation) throw new OperationError("unknown_operation", `no operation ${name}`);
  if (!operation.callers.includes(caller.kind))
    throw new OperationError(
      "not_allowed",
      `${name} is for ${operation.callers.map(describeCaller).join(" and ")} only`,
    );
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input)))
    throw new OperationError("invalid_request", "the input must be a JSON object");
  return operation.run((input ?? {}) as Record<string, unknown>, { caller });
}

function describeCaller(kind: CallerKind): string {
  if (kind === "user") return "people";
  if (kind === "agent") return "agents in 1harness threads";
  return "agents outside 1harness";
}

/** An operation's result as MCP tool content: text as it is, JSON indented. */
export function mcpContent(result: unknown): { content: unknown[]; isError?: boolean } {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (isContent(result)) return result;
  return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
}

/** MCP tool content, such as an image a tool returns. */
export function isContent(result: unknown): result is { content: unknown[]; isError?: boolean } {
  return (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  );
}
