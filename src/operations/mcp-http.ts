import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage } from "../core/errors.ts";
import { mcpReply, rpcError, type JsonRpcMessage, type McpEndpoint } from "./mcp.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A tool call that waits sends a comment this often, so HTTP idle timeouts leave it be.
const KEEPALIVE_MS = 15_000;

/**
 * Answers one MCP request over streamable HTTP. Everything is a reply to a
 * request, so there is no server-to-client stream to open with GET.
 */
export async function serveMcp(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: McpEndpoint,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    send(response, 400, rpcError(null, -32700, errorMessage(error)));
    return;
  }
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
  // A tool call can wait on other work, so it streams where the client takes a stream.
  const single = Array.isArray(body) ? undefined : messages[0];
  if (
    single?.method === "tools/call" &&
    single.id !== undefined &&
    single.id !== null &&
    request.headers.accept?.includes("text/event-stream")
  ) {
    await stream(response, mcpReply(single, endpoint));
    return;
  }
  const replies = (
    await Promise.all(messages.map((message) => mcpReply(message, endpoint)))
  ).filter((reply) => reply !== null);
  if (replies.length === 0) {
    response.writeHead(202).end();
    return;
  }
  send(response, 200, Array.isArray(body) ? replies : replies[0]);
}

/**
 * Answers over an event stream: headers at once, a comment every so often while
 * the reply is pending, then the reply as the stream's one message.
 */
async function stream(response: ServerResponse, reply: Promise<unknown>): Promise<void> {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.flushHeaders();
  const timer = setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS);
  try {
    const message = await reply;
    response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  } finally {
    clearInterval(timer);
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
