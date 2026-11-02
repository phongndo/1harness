import { randomUUID } from "node:crypto";

/** How many of a thread ID's characters are shown and enough to type. */
export const SHORT_ID = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A UUID's first characters, at least as many as are shown. */
const PREFIX = new RegExp(`^[0-9a-f]{${SHORT_ID}}[0-9a-f-]{0,28}$`, "i");
/** IDs given out before threads were named by UUIDs, such as `t42`. */
const COUNTED = /^t\d+$/;

/** A new thread ID: a random UUIDv4. */
export function newThreadId(): string {
  return randomUUID();
}

/** A thread ID as shown: a UUID's first characters, or an older ID such as `t42` whole. */
export function shortThreadId(id: string): string {
  return UUID.test(id) ? id.slice(0, SHORT_ID).toLowerCase() : id;
}

/** Whether typed text names a 1harness thread: a UUID, its first characters, or an ID such as `t42`. */
export function looksLikeThreadId(text: string): boolean {
  return COUNTED.test(text) || PREFIX.test(text);
}

/** Whether `text` could be the start of a UUID thread ID, and so worth looking up as one. */
export function isThreadIdPrefix(text: string): boolean {
  return PREFIX.test(text) && !UUID.test(text);
}
