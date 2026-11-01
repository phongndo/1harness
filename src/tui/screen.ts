import { clearImages, deleteImage, placeVirtually, transmit, type Shown } from "./images.ts";
import { truncate, visibleWidth } from "./text.ts";

/** What the pictures the terminal keeps may take, decoded: a few screens' worth. */
const IMAGE_BUDGET = 256 * 1024 * 1024;

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
  #cursor: CursorPosition | null = null;
  #clear = true;
  #active = false;
  /**
   * Pictures the terminal has, by ID: the frame it has, the size it is placed
   * at, so each goes once, what it takes decoded, and when a frame last showed it.
   */
  #sent = new Map<number, { version: number; size: string; bytes: number; used: number }>();
  #frames = 0;

  #budget: number;

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
    // Focus reports tell the program status whether the user can see the screen.
    this.#out.write("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h");
  }

  leave(): void {
    if (!this.#active) return;
    this.#active = false;
    // Pictures go with the screen; they are sent again when it comes back.
    if (this.#sent.size > 0) this.#out.write(clearImages());
    this.#sent.clear();
    this.#out.write(
      "\x1b[?1004l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l",
    );
  }

  /** Forgets what is on screen so the next frame repaints every row, as after a resize. */
  invalidate(): void {
    this.#previous = [];
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

  render(
    lines: readonly string[],
    cursor: CursorPosition | null,
    pictures: readonly Shown[] = [],
  ): void {
    if (!this.#active) return;
    const columns = this.columns;
    // Pictures first: the placeholder text that shows them needs them sent.
    let frame = this.#pictures(pictures);
    frame += this.#clear ? "\x1b[H\x1b[2J" : "";
    this.#clear = false;
    const count = Math.max(lines.length, this.#previous.length);
    for (let row = 0; row < count; row++) {
      const line = lines[row] ?? "";
      if (line === this.#previous[row]) continue;
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
    this.#cursor = cursor;
    let output = `\x1b[?2026h\x1b[?25l${frame}`;
    if (cursor) output += `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
    this.#out.write(`${output}\x1b[?2026l`);
  }
}
