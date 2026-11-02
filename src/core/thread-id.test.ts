import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isThreadIdPrefix, looksLikeThreadId, newThreadId, shortThreadId } from "./thread-id.ts";

describe("thread IDs", () => {
  it("are random UUIDv4s", () => {
    const id = newThreadId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(newThreadId(), id);
  });

  it("show a UUID's first characters, and an older ID whole", () => {
    assert.equal(shortThreadId("3F9C2A1B-7d4e-4a10-9b2c-0123456789ab"), "3f9c2a1b");
    assert.equal(shortThreadId("t42"), "t42");
  });

  it("are told from words by their shape", () => {
    assert.ok(looksLikeThreadId("t42"));
    assert.ok(looksLikeThreadId("3f9c2a1b"));
    assert.ok(looksLikeThreadId("3f9c2a1b-7d4e-4a10-9b2c-0123456789ab"));
    assert.ok(!looksLikeThreadId("3f9c2a"));
    assert.ok(!looksLikeThreadId("parser"));
    assert.ok(!looksLikeThreadId("t42 parser"));
  });

  it("are looked up by their start only when not whole", () => {
    assert.ok(isThreadIdPrefix("3f9c2a1b"));
    assert.ok(!isThreadIdPrefix("3f9c2a1b-7d4e-4a10-9b2c-0123456789ab"));
    assert.ok(!isThreadIdPrefix("t42"));
  });
});
