import { isLightBackground } from "./theme.ts";

export interface Key {
  /** `return`, `tab`, `up`, `pageup`, `space`, … or the lowercase character. */
  name: string;
  /** What the key types, empty for control keys and chords. */
  text: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export type InputEvent =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string }
  /** Mouse wheel: negative scrolls up. */
  | { type: "wheel"; delta: number }
  /**
   * A mouse button pressed, moved while held, or let go, at a cell counted
   * from 0 at the top left; `button` is 0 for the left one, 1 middle, 2 right.
   */
  | {
      type: "mouse";
      action: "press" | "drag" | "release";
      button: number;
      row: number;
      column: number;
    }
  /** The terminal's reply to a background color query. */
  | { type: "background"; light: boolean }
  /** The terminal's reply to a device attributes query, which every terminal answers. */
  | { type: "attributes" }
  /** The terminal supports the Program Status Protocol (OSC 7501). */
  | { type: "programStatus" }
  /** The terminal gained or lost focus, reported once focus reporting is on. */
  | { type: "focus"; focused: boolean }
  /** The terminal's reply to a Kitty graphics query: whether it shows images. */
  | { type: "graphics"; ok: boolean }
  /** The size of a character cell in pixels, which images are sized by. */
  | { type: "cellSize"; width: number; height: number };

/** The most time between clicks that make a double or triple one. */
export const CLICK_MS = 400;
/** Rows a notch of the wheel scrolls. */
export const WHEEL_ROWS = 3;

const PASTE_END = "\x1b[201~";

const CSI_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const TILDE_KEYS: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

function key(name: string, options: Partial<Key> = {}): InputEvent {
  return {
    type: "key",
    key: { name, text: "", ctrl: false, meta: false, shift: false, ...options },
  };
}

/** Applies an xterm modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4). */
function modified(name: string, modifier: number, text = ""): InputEvent {
  const bits = Math.max(0, modifier - 1);
  const ctrl = (bits & 4) !== 0;
  const meta = (bits & 2) !== 0;
  return key(name, {
    shift: (bits & 1) !== 0,
    meta,
    ctrl,
    text: ctrl || meta ? "" : text,
  });
}

/** Decodes one character typed without an escape prefix. */
function plain(char: string, meta: boolean): InputEvent {
  const code = char.codePointAt(0) ?? 0;
  if (char === "\r") return key("return", { meta });
  if (char === "\n") return key("j", { ctrl: true, meta });
  if (char === "\t") return key("tab", { meta });
  if (char === "\x7f" || char === "\b") return key("backspace", { meta });
  if (code === 0) return key("space", { ctrl: true, meta });
  if (code < 27) return key(String.fromCharCode(code + 96), { ctrl: true, meta });
  if (code < 32) return key(String.fromCharCode(code + 64).toLowerCase(), { ctrl: true, meta });
  if (char === " ") return key("space", { meta, text: meta ? "" : " " });
  const lower = char.toLowerCase();
  return key(lower, { meta, shift: lower !== char, text: meta ? "" : char });
}

/** Decodes a key reported by its code point, as in CSI u and modifyOtherKeys. */
function codepoint(code: number, modifier: number): InputEvent {
  const names: Record<number, string> = {
    9: "tab",
    13: "return",
    27: "escape",
    32: "space",
    127: "backspace",
  };
  const name = names[code];
  if (name) return modified(name, modifier, code === 32 ? " " : "");
  const char = String.fromCodePoint(code);
  return modified(char.toLowerCase(), modifier, char);
}

/**
 * Turns raw terminal input into keys, pastes, and wheel events. Terminals send
 * each sequence in one read, so an Esc at the end of a read is the Esc key.
 * Only a partial paste or sequence split by a large read is held for the next.
 */
export class InputDecoder {
  #pending = "";
  #paste: string | null = null;

  /** Whether input is held waiting for the rest of a sequence. */
  get pending(): boolean {
    return this.#pending !== "" && this.#paste === null;
  }

  feed(chunk: string): InputEvent[] {
    const data = this.#pending + chunk;
    this.#pending = "";
    const events: InputEvent[] = [];
    let index = 0;
    while (index < data.length) {
      if (this.#paste !== null) {
        const end = data.indexOf(PASTE_END, index);
        if (end === -1) {
          const keep = partialSuffix(data, PASTE_END);
          this.#paste += data.slice(index, data.length - keep);
          this.#pending = data.slice(data.length - keep);
          return events;
        }
        events.push({ type: "paste", text: this.#paste + data.slice(index, end) });
        this.#paste = null;
        index = end + PASTE_END.length;
        continue;
      }
      if (data[index] !== "\x1b") {
        const char = String.fromCodePoint(data.codePointAt(index) ?? 0);
        events.push(plain(char, false));
        index += char.length;
        continue;
      }
      const length = this.#escape(data, index, events);
      if (length === 0) {
        this.#pending = data.slice(index);
        break;
      }
      index += length;
    }
    return events;
  }

  /** Releases held input as keys, for when the rest of a sequence never arrives. */
  flush(): InputEvent[] {
    const data = this.#pending;
    this.#pending = "";
    if (data === "") return [];
    return [key("escape"), ...this.feed(data.slice(1))];
  }

  /** Decodes the sequence at `index`; returns its length, or 0 when it is incomplete. */
  #escape(data: string, index: number, events: InputEvent[]): number {
    const next = data[index + 1];
    if (next === undefined) {
      events.push(key("escape"));
      return 1;
    }
    if (next === "[") return this.#csi(data, index, events);
    if (next === "]") {
      const bell = data.indexOf("\x07", index);
      const st = data.indexOf("\x1b\\", index);
      const end = bell !== -1 && (st === -1 || bell < st) ? bell : st;
      if (end === -1) return 0;
      const body = data.slice(index + 2, end);
      if (body.startsWith("11;")) {
        const light = isLightBackground(body);
        if (light !== null) events.push({ type: "background", light });
      }
      const compact = body.replace(/\s/g, "");
      if (compact === "7501;?" || compact.startsWith("7501;?:"))
        events.push({ type: "programStatus" });
      return end - index + (end === bell ? 1 : 2);
    }
    if (next === "_") {
      // An APC reply, such as the Kitty graphics protocol's `ESC _ G i=31;OK ESC \`.
      const end = data.indexOf("\x1b\\", index);
      if (end === -1) return 0;
      const body = data.slice(index + 2, end);
      if (body.startsWith("G")) events.push({ type: "graphics", ok: body.endsWith(";OK") });
      return end - index + 2;
    }
    if (next === "O") {
      const final = data[index + 2];
      if (final === undefined) return 0;
      const name = CSI_KEYS[final];
      if (name) events.push(key(name));
      return 3;
    }
    if (next === "\x1b") {
      // Some terminals send alt with an arrow or function key as Esc before its sequence.
      const after = data[index + 2];
      if (after === "[" || after === "O") {
        const inner: InputEvent[] = [];
        const length = this.#escape(data, index + 1, inner);
        if (length === 0) return 0;
        for (const event of inner)
          events.push(
            event.type === "key"
              ? { ...event, key: { ...event.key, meta: true, text: "" } }
              : event,
          );
        return 1 + length;
      }
      events.push(key("escape"));
      return 1;
    }
    const char = String.fromCodePoint(data.codePointAt(index + 1) ?? 0);
    events.push(plain(char, true));
    return 1 + char.length;
  }

  #csi(data: string, index: number, events: InputEvent[]): number {
    let end = index + 2;
    while (end < data.length) {
      const code = data.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end++;
    }
    if (end >= data.length) return 0;
    const length = end - index + 1;
    const final = data[end] ?? "";
    const raw = data.slice(index + 2, end);
    if (raw.startsWith("<") && (final === "M" || final === "m")) {
      const [button = 0, column = 1, row = 1] = raw.slice(1).split(";").map(Number);
      if ((button & 64) !== 0) {
        // Up and down; sideways, which sets bit 2 as well, does nothing here.
        if (final === "M" && (button & 2) === 0)
          events.push({ type: "wheel", delta: (button & 1) === 0 ? -1 : 1 });
        return length;
      }
      events.push({
        type: "mouse",
        action: final === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press",
        button: button & 3,
        row: row - 1,
        column: column - 1,
      });
      return length;
    }
    if (raw.startsWith("?") && final === "c") {
      events.push({ type: "attributes" });
      return length;
    }
    if (raw === "" && (final === "I" || final === "O")) {
      events.push({ type: "focus", focused: final === "I" });
      return length;
    }
    // The reply to CSI 16 t: CSI 6 ; height ; width t.
    if (final === "t" && raw.startsWith("6;")) {
      const [, height = 0, width = 0] = raw.split(";").map(Number);
      if (height > 0 && width > 0) events.push({ type: "cellSize", width, height });
      return length;
    }
    const params = raw.split(";").map((part) => Number.parseInt(part, 10) || 0);
    const modifier = params[1] ?? 1;
    if (final === "~") {
      if (raw === "200") {
        this.#paste = "";
        return length;
      }
      if (params[0] === 27 && params[2] !== undefined) {
        events.push(codepoint(params[2], modifier));
        return length;
      }
      const name = TILDE_KEYS[String(params[0])];
      if (name) events.push(modified(name, modifier));
      return length;
    }
    if (final === "u") {
      events.push(codepoint(params[0] ?? 0, modifier));
      return length;
    }
    if (final === "Z") {
      events.push(key("tab", { shift: true }));
      return length;
    }
    const name = CSI_KEYS[final];
    if (name) events.push(modified(name, modifier));
    return length;
  }
}

/** Length of the longest suffix of `data` that begins `marker`. */
function partialSuffix(data: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, data.length); length > 0; length--) {
    if (data.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
