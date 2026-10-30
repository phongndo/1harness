import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InputDecoder, type InputEvent } from "./input.ts";

function keys(events: InputEvent[]): string[] {
  return events.map((event) => {
    if (event.type !== "key") return event.type;
    const { key } = event;
    return [key.ctrl && "ctrl", key.meta && "meta", key.shift && "shift", key.name]
      .filter(Boolean)
      .join("+");
  });
}

describe("InputDecoder", () => {
  it("decodes text, control keys, and a lone escape", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(keys(decoder.feed("aB \r\t\x7f\x01\x1b")), [
      "a",
      "shift+b",
      "space",
      "return",
      "tab",
      "backspace",
      "ctrl+a",
      "escape",
    ]);
  });

  it("decodes cursor keys with modifiers, SS3, and tilde keys", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(keys(decoder.feed("\x1b[A\x1b[1;5D\x1bOB\x1b[5~\x1b[3~\x1b[Z")), [
      "up",
      "ctrl+left",
      "down",
      "pageup",
      "delete",
      "shift+tab",
    ]);
  });

  it("decodes alt chords and CSI u keys", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(keys(decoder.feed("\x1b\r\x1bb\x1b[13;2u\x1b[27;5;106~")), [
      "meta+return",
      "meta+b",
      "shift+return",
      "ctrl+j",
    ]);
  });

  it("keeps a paste whole across reads, newlines included", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.feed("\x1b[200~line one\r\nline"), []);
    assert.deepEqual(decoder.feed(" two\x1b[20"), []);
    assert.deepEqual(decoder.feed("1~x"), [
      { type: "paste", text: "line one\r\nline two" },
      {
        type: "key",
        key: { name: "x", text: "x", ctrl: false, meta: false, shift: false },
      },
    ]);
  });

  it("reports wheel scrolling and ignores clicks", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.feed("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;1;1M\x1b[<0;1;1m"), [
      { type: "wheel", delta: -1 },
      { type: "wheel", delta: 1 },
    ]);
  });

  it("reads the background color and device attributes replies", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.feed("\x1b]11;rgb:ffff/ffff/f0f0\x1b\\\x1b[?62;22c"), [
      { type: "background", light: true },
      { type: "attributes" },
    ]);
    assert.deepEqual(decoder.feed("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"), [
      { type: "background", light: false },
    ]);
  });

  it("holds a split sequence until the rest arrives or it is flushed", () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.feed("\x1b[1;"), []);
    assert.equal(decoder.pending, true);
    assert.deepEqual(keys(decoder.feed("2A")), ["shift+up"]);
    decoder.feed("\x1b[");
    assert.deepEqual(keys(decoder.flush()), ["escape", "["]);
  });
});
