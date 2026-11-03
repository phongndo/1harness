import type { UserInput } from "../core/events.ts";
import { mentionedImages } from "../core/files.ts";
import type { Message, MessageOrigin, Thread } from "../core/thread.ts";

export interface SendOptions {
  origin?: MessageOrigin | undefined;
  /** Join the running turn instead of queueing as the next. */
  steer?: boolean | undefined;
  /** A harness command, which reaches the harness as written. */
  command?: boolean | undefined;
  requestId?: string | undefined;
}

/**
 * Sends a thread what was typed, with the images it mentions as `@path` where
 * its harness takes images, the same from a terminal, the CLI, or an agent.
 */
export async function sendText(
  thread: Thread,
  text: string,
  options: SendOptions = {},
): Promise<Message> {
  const input: UserInput = { text };
  if (thread.capabilities.images && !options.command) {
    const images = mentionedImages(text, thread.info.cwd);
    if (images.length > 0) input.images = images;
  }
  const request = options.requestId ? { requestId: options.requestId } : {};
  if (options.command) return thread.send(input, options.origin, { command: true, ...request });
  return options.steer
    ? thread.steer(input, options.origin, request)
    : thread.send(input, options.origin, request);
}
