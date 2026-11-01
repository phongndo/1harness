import { truncate, visibleWidth } from "./text.ts";

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

  constructor(out: NodeJS.WriteStream) {
    this.#out = out;
  }

  get columns(): number {
    return this.#out.columns || 80;
  }

  get rows(): number {
    return this.#out.rows || 24;
  }

  /**
   * Switches to the alternate screen with autowrap off, so a miscounted width
   * can never scroll the frame, and turns on bracketed paste and wheel reports.
   */
  enter(): void {
    if (this.#active) return;
    this.#active = true;
    this.invalidate();
    // Focus reports tell the program status whether the user can see the screen.
    this.#out.write("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h");
  }

  leave(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#out.write(
      "\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l",
    );
  }

  /** Forgets what is on screen so the next frame repaints every row, as after a resize. */
  invalidate(): void {
    this.#previous = [];
    this.#cursor = null;
    this.#clear = true;
  }

  render(lines: readonly string[], cursor: CursorPosition | null): void {
    if (!this.#active) return;
    const columns = this.columns;
    let frame = this.#clear ? "\x1b[H\x1b[2J" : "";
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
