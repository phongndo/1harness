import { clearImages, deleteImage, placeVirtually, transmit, type Shown } from "./images.ts";
import { truncate, visibleWidth } from "./text.ts";

/** What the pictures the terminal keeps may take, decoded: a few screens' worth. */
const IMAGE_BUDGET = 256 * 1024 * 1024;

/** Gives the terminal its own background and text colors back. */
const UNGROUND = "\x1b]111\x1b\\\x1b]110\x1b\\";

export interface CursorPosition {
  row: number;
  column: number;
}

/**
 * A full-screen surface on the terminal's alternate screen. Each frame is a
 * list of rows; only rows that differ from the previous frame are rewritten,
 * in one write inside a synchronized update, so a streamed token costs one row
 * and terminals that support it never show a half-drawn frame.
 */
export class Screen {
  #out: NodeJS.WriteStream;
  #previous: (string | undefined)[] = [];
  /** What each of those rows starts with that changes apart from the rest of it. */
  #margins: (string | null)[] = [];
  #cursor: CursorPosition | null = null;
  #clear = true;
  #active = false;
  /**
   * Pictures the terminal has, by ID: the frame it has, the size it is placed
   * at, so each goes once, what it takes decoded, and when a frame last showed it.
   */
  #sent = new Map<number, { version: number; size: string; bytes: number; used: number }>();
  #frames = 0;
  #hover = false;

  #budget: number;
  /** The page's color and its text's, in place of the terminal's own. */
  #ground: { page: string; text: string } | null = null;

  /** `imageBudget` is what the pictures the terminal keeps may take, decoded, in bytes. */
  constructor(out: NodeJS.WriteStream, imageBudget = IMAGE_BUDGET) {
    this.#out = out;
    this.#budget = imageBudget;
  }

  get columns(): number {
    return this.#out.columns || 80;
  }

  get rows(): number {
    return this.#out.rows || 24;
  }

  /**
   * Switches to the alternate screen with autowrap off, so a miscounted width
   * can never scroll the frame, and turns on bracketed paste and mouse reports:
   * the wheel, clicks, and drags with a button held, for selecting text.
   */
  enter(): void {
    if (this.#active) return;
    this.#active = true;
    this.invalidate();
    if (this.#ground) this.#out.write(this.#grounded());
    // Focus reports tell the program status whether the user can see the screen.
    this.#out.write("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h");
    if (this.#hover) this.#out.write("\x1b[?1003h");
  }

  /** Sets the terminal's background and text colors, until it leaves; null gives its own back. */
  ground(ground: { page: string; text: string } | null): void {
    if (ground?.page === this.#ground?.page && ground?.text === this.#ground?.text) return;
    this.#ground = ground;
    if (this.#active) this.#out.write(this.#grounded());
  }

  #grounded(): string {
    const ground = this.#ground;
    return ground ? `\x1b]11;${ground.page}\x1b\\\x1b]10;${ground.text}\x1b\\` : UNGROUND;
  }

  leave(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#ground) this.#out.write(UNGROUND);
    // Pictures go with the screen; they are sent again when it comes back.
    if (this.#sent.size > 0) this.#out.write(clearImages());
    this.#sent.clear();
    if (this.#hover) this.#out.write("\x1b[?1003l");
    this.#out.write(
      "\x1b[?1004l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l",
    );
  }

  /** Forgets what is on screen so the next frame repaints every row, as after a resize. */
  invalidate(): void {
    this.#previous = [];
    this.#margins = [];
    this.#cursor = null;
    this.#clear = true;
  }

  /**
   * Sends the frame's pictures the terminal does not have yet, or has an
   * older frame of, with a virtual placement at the size their rows show
   * them; placed again at a new size.
   */
  #pictures(shown: readonly Shown[]): string {
    let out = "";
    const frame = ++this.#frames;
    for (const one of shown) {
      const size = `${one.columns}x${one.rows}`;
      const version = one.picture.version ?? 0;
      const sent = this.#sent.get(one.picture.id);
      if (sent?.size === size && sent.version === version) {
        sent.used = frame;
        continue;
      }
      // A new frame under the same ID takes the old one's place, and is placed again.
      if (sent?.version !== version) out += transmit(one.picture);
      out += placeVirtually(one);
      const bytes = one.picture.pixelWidth * one.picture.pixelHeight * 4;
      this.#sent.set(one.picture.id, { version, size, bytes, used: frame });
    }
    return out + this.#evict(frame);
  }

  /**
   * Deletes the pictures shown longest ago while those the terminal keeps take
   * more than it should hold; one shown again is sent again.
   */
  #evict(frame: number): string {
    let total = 0;
    for (const sent of this.#sent.values()) total += sent.bytes;
    if (total <= this.#budget) return "";
    let out = "";
    const oldest = [...this.#sent].filter(([, sent]) => sent.used < frame);
    oldest.sort(([, a], [, b]) => a.used - b.used);
    for (const [id, sent] of oldest) {
      if (total <= this.#budget) break;
      out += deleteImage(id);
      this.#sent.delete(id);
      total -= sent.bytes;
    }
    return out;
  }

  /**
   * Moves what is on screen where a frame shows it further up or down, as a
   * scroll does, so only the rows that come into view are written: the terminal
   * scrolls the rows between, pictures' placeholders with them.
   */
  #shift(whole: readonly string[], margins: readonly (string | null)[]): string {
    if (this.#previous.length !== whole.length || whole.length < 4) return "";
    // By what comes after the margin, which is written again wherever it moved to.
    const before = this.#previous.map((line = "", row) => past(line, this.#margins[row]));
    const lines = whole.map((line, row) => past(line, margins[row]));
    const where = new Map<string, number>();
    for (const [row, line] of before.entries()) if (line && !where.has(line)) where.set(line, row);
    // How many rows each distance would move into place, and between which rows they are.
    const moves = new Map<number, { count: number; first: number; last: number }>();
    for (const [row, line] of lines.entries()) {
      const from = line && line !== before[row] ? where.get(line) : undefined;
      if (from === undefined) continue;
      const move = moves.get(from - row) ?? { count: 0, first: row, last: row };
      moves.set(from - row, { ...move, count: move.count + 1, last: row });
    }
    let by = 0;
    let best = { count: 2, first: 0, last: 0 };
    for (const [distance, move] of moves)
      if (move.count > best.count) {
        by = distance;
        best = move;
      }
    if (by === 0) return "";
    const top = Math.min(best.first, best.first + by);
    const bottom = Math.max(best.last, best.last + by);
    // Rows between that stay where they are would be written again.
    let held = 0;
    for (let row = top; row <= bottom; row++) if (lines[row] && lines[row] === before[row]) held++;
    if (held >= best.count) return "";
    this.#previous = shifted(this.#previous, top, bottom, by, "");
    this.#margins = shifted(this.#margins, top, bottom, by, null);
    return `\x1b[${top + 1};${bottom + 1}r\x1b[${Math.abs(by)}${by > 0 ? "S" : "T"}\x1b[r`;
  }

  /** Asks the terminal for every move of the mouse, or only those with a button held. */
  hover(on: boolean): void {
    if (on === this.#hover) return;
    this.#hover = on;
    if (this.#active) this.#out.write(on ? "\x1b[?1003h" : "\x1b[?1003l\x1b[?1002h");
  }

  render(
    lines: readonly string[],
    cursor: CursorPosition | null,
    pictures: readonly Shown[] = [],
    margins: readonly (string | null)[] = [],
  ): void {
    if (!this.#active) return;
    const columns = this.columns;
    // Pictures first: the placeholder text that shows them needs them sent.
    let frame = this.#pictures(pictures);
    frame += this.#clear ? "\x1b[H\x1b[2J" : "";
    this.#clear = false;
    frame += this.#shift(lines, margins);
    const count = Math.max(lines.length, this.#previous.length);
    for (let row = 0; row < count; row++) {
      const line = lines[row] ?? "";
      const was = this.#previous[row];
      if (line === was) continue;
      const margin = margins[row];
      const before = this.#margins[row];
      // Only what is beside it changed, as the rail does when the rest scrolls past it.
      if (
        margin &&
        before &&
        was?.startsWith(before) &&
        line.startsWith(margin) &&
        was.slice(before.length) === line.slice(margin.length)
      ) {
        frame += `\x1b[${row + 1};1H${margin}\x1b[0m`;
        continue;
      }
      // A row too wide would write over its own last cell, autowrap being off, so it is cut.
      const width = visibleWidth(line);
      frame += `\x1b[${row + 1};1H${width > columns ? truncate(line, columns) : line}\x1b[0m`;
      // Erasing after a full-width row would clear its last cell.
      if (width < columns) frame += "\x1b[K";
    }
    const moved = cursor?.row !== this.#cursor?.row || cursor?.column !== this.#cursor?.column;
    if (frame === "" && !moved) return;
    // Rows past the end were cleared, so they compare equal to an empty row.
    this.#previous = Array.from({ length: count }, (_, row) => lines[row] ?? "");
    this.#margins = Array.from({ length: count }, (_, row) => margins[row] ?? null);
    this.#cursor = cursor;
    let output = `\x1b[?2026h\x1b[?25l${frame}`;
    if (cursor) output += `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
    this.#out.write(`${output}\x1b[?2026l`);
  }
}

/** A row after its margin, where it starts with one. */
function past(line: string, margin: string | null | undefined): string {
  return margin && line.startsWith(margin) ? line.slice(margin.length) : line;
}

/** Rows with those from `top` to `bottom` moved up by `by`, or down, and `blank` where they were. */
function shifted<T>(rows: readonly T[], top: number, bottom: number, by: number, blank: T): T[] {
  const part = rows.slice(top, bottom + 1);
  const gap = Array.from({ length: Math.abs(by) }, () => blank);
  const after = by > 0 ? [...part.slice(by), ...gap] : [...gap, ...part.slice(0, by)];
  return [...rows.slice(0, top), ...after, ...rows.slice(bottom + 1)];
}
