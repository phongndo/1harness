import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserInput } from "../core/events.ts";
import { mentionedImages } from "../core/files.ts";
import type { Message, MessageOrigin, Thread } from "../core/thread.ts";
import type { ImageType } from "../drivers/images.ts";

const PASTED_EXTENSIONS: Record<ImageType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Keeps images a client pasted as files for the harness to read, where the
 * system clears temporary files in time; returns their paths.
 */
export function savePastedImages(images: readonly { type: ImageType; data: string }[]): string[] {
  const folder = join(tmpdir(), "1harness-images");
  mkdirSync(folder, { recursive: true });
  return images.map((image) => {
    const extension = PASTED_EXTENSIONS[image.type];
    if (!extension) throw new Error(`Images of type ${String(image.type)} cannot be sent`);
    const path = join(folder, `${randomUUID()}${extension}`);
    writeFileSync(path, Buffer.from(image.data, "base64"));
    return path;
  });
}

export interface SendOptions {
  origin?: MessageOrigin | undefined;
  /** Join the running turn instead of queueing as the next. */
  steer?: boolean | undefined;
  /** A harness command, which reaches the harness as written. */
  command?: boolean | undefined;
  /** Image files sent besides those the text mentions, ahead of them. */
  images?: string[] | undefined;
  requestId?: string | undefined;
}

/**
 * Sends a thread what was typed, with the images it mentions as `@path` where
 * its harness takes images, the same from a terminal, the CLI, or an agent.
 * Only a steer waits; a send is queued before this returns.
 */
export function sendText(
  thread: Thread,
  text: string,
  options: SendOptions = {},
): Message | Promise<Message> {
  const input: UserInput = { text };
  if (thread.capabilities.images && !options.command) {
    const images = [...(options.images ?? []), ...mentionedImages(text, thread.info.cwd)];
    if (images.length > 0) input.images = images;
  }
  const request = options.requestId ? { requestId: options.requestId } : {};
  if (options.command) return thread.send(input, options.origin, { command: true, ...request });
  return options.steer
    ? thread.steer(input, options.origin, request)
    : thread.send(input, options.origin, request);
}
