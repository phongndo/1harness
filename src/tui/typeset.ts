import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { findExecutable } from "../drivers/index.ts";
import { BoundedMap } from "./cache.ts";
import {
  PLACEHOLDER,
  PLACEHOLDER_LIMIT,
  encodedPicture,
  placeholderColor,
  placeholderMark,
  type CellSize,
  type Picture,
  type Shown,
} from "./images.ts";
import { density } from "./look.ts";
import { lineHtml, page } from "./markup.ts";

// Pages drawn by html2term, as one picture over whole rows of cells. A worker
// stays running, so a paragraph takes a millisecond or two; a page that grew
// is drawn only from the row it grew at, so a long reply sends each paragraph
// once. With each page comes where its characters are, so what it shows can
// be selected, copied, and clicked as the terminal's own text can.

interface TextRun {
  top: number;
  bottom: number;
  x: number;
  text: string;
  ends: number[];
  wraps: boolean;
  href?: string;
}

interface HitBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Reply {
  ok: boolean;
  error?: string;
  png: string;
  width: number;
  height: number;
  page_pixels: number;
  layer: { text: TextRun[]; hits: HitBox[] };
}

/** A picture of a page's rows from `origin`, shown on those from `from` to before `to`. */
interface Slice {
  origin: number;
  from: number;
  to: number;
  picture: Picture;
  rows: number;
}

/** A row's characters by the cell each is over: none past its text, and "" under a wide one. */
export interface TextRow {
  cells: (string | null)[];
  /** The line goes on to the next row with text. */
  wraps: boolean;
}

/** A page as drawn: its rows, and what is where on them. */
export interface Sheet {
  rows: string[];
  /** Its pictures, over the rows that show them. */
  pictures: (Shown & { start: number; end: number })[];
  /** The page's height in rows, not rounded up. */
  height: number;
  /** Marked elements by name, over the rows they touch. */
  spots: { id: string; start: number; end: number }[];
  /** The same over only the rows whose middle is on them, so no two share a row. */
  middles: { id: string; start: number; end: number }[];
}

interface State {
  key: string;
  body: string[];
  sheet: Sheet;
  slices: Slice[];
  hits: HitBox[];
  pixels: number;
}

/** What a page is asked to be drawn as. */
interface Want {
  key: string;
  body: string[];
  columns: number;
  cell: CellSize;
  dark: boolean;
}

/** The most rows in one picture, so a long page is sent in parts and drawn within html2term's limit. */
const MOST_ROWS = 120;
/** How long a page that has come may wait for others. */
const TOGETHER_MS = 50;
/** A worker that answers nothing for this long has hung. */
const TIMEOUT_MS = 10_000;

/** A line of text on a row, which may be the one before its own or after it: a line is taller. */
export interface LineOn {
  /** How many rows further its own is. */
  own: number;
  from: number;
  to: number;
}

/** What is on the rows of each picture. */
const texts = new BoundedMap<number, { text: Map<number, TextRow>; lines: Map<number, LineOn[]> }>(
  4096,
);

/** A line is on a row it covers this share of. */
const COVERS = 0.3;

/** What a row's cells show of which picture's row, read from its first placeholder. */
function shownAt(row: string): { id: number; mark: string; before: number } | null {
  const at = row.indexOf(PLACEHOLDER);
  if (at === -1) return null;
  // oxlint-disable-next-line no-control-regex
  const color = /\x1b\[38;2;(\d+);(\d+);(\d+)m(?:\x1b\]8;;[^\x1b]*\x1b\\)?$/.exec(row.slice(0, at));
  if (!color) return null;
  const [, r = "0", g = "0", b = "0"] = color;
  const id = (Number(r) << 16) | (Number(g) << 8) | Number(b);
  return {
    id,
    mark: /^\p{M}/u.exec(row.slice(at + PLACEHOLDER.length))?.[0] ?? "",
    before: color.index,
  };
}

const MARKS = new Map(
  Array.from({ length: PLACEHOLDER_LIMIT }, (_, row) => [
    /^\p{M}/u.exec(placeholderMark(row, 0).slice(PLACEHOLDER.length))?.[0] ?? "",
    row,
  ]),
);

/** The text a typeset row shows, by cell; null for any other row. */
export function textRow(row: string): TextRow | null {
  const shown = shownAt(row);
  if (!shown) return null;
  return texts.get(shown.id)?.text.get(MARKS.get(shown.mark) ?? -1) ?? null;
}

/** The lines of text on a typeset row; null for any other row. */
export function linesOn(row: string): LineOn[] | null {
  const shown = shownAt(row);
  const known = shown && texts.get(shown.id);
  return known ? (known.lines.get(MARKS.get(shown.mark) ?? -1) ?? []) : null;
}

/** A typeset row with cells `from` to before `to` on `fill`, which shows through its picture. */
export function paintCells(row: string, from: number, to: number, fill: string): string {
  if (to <= from) return row;
  let cell = 0;
  let out = "";
  for (let at = 0; at < row.length;) {
    if (!row.startsWith(PLACEHOLDER, at)) {
      out += row[at++];
      continue;
    }
    if (cell === from) out += `\x1b[48;2;${fill}m`;
    if (cell === to) out += "\x1b[49m";
    const marked = /^\p{M}*/u.exec(row.slice(at + PLACEHOLDER.length, at + PLACEHOLDER.length + 8));
    out += PLACEHOLDER + (marked?.[0] ?? "");
    at += PLACEHOLDER.length + (marked?.[0].length ?? 0);
    cell++;
  }
  return cell <= to ? `${out}\x1b[49m` : out;
}

/** A font file fontconfig has for a family, and the family it is of. */
function match(family: string, also = ""): { file: string; family: string } | null {
  try {
    const [file = "", name = ""] = execFileSync(
      "fc-match",
      ["-f", "%{file}\n%{family}", family + also],
      {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).split("\n");
    return file ? { file, family: name } : null;
  } catch {
    return null;
  }
}

/**
 * fontconfig's monospace font, if it has one: without any it answers with a
 * proportional one, where html2term has a monospace of its own.
 */
function monospace(): string | null {
  const found = match("monospace", ":spacing=mono");
  return found && /mono|code|courier|consol|menlo/i.test(found.family) ? found.file : null;
}

/** The first of some files that is there. */
function first(...paths: (string | undefined)[]): string | null {
  return paths.find((path) => path && existsSync(path)) ?? null;
}

/** Fonts as T3 Code names them, first found first: the Mac's own, then Inter, then what there is. */
function fonts(): { text: string | null; code: string | null } {
  const inter = () => {
    const found = match("Inter");
    return found && /inter/i.test(found.family) ? found.file : null;
  };
  return {
    text:
      first(process.env["ONEHARNESS_FONT"], "/System/Library/Fonts/SFNS.ttf") ??
      inter() ??
      match("sans-serif")?.file ??
      null,
    code:
      first(process.env["ONEHARNESS_CODE_FONT"], "/System/Library/Fonts/SFNSMono.ttf") ??
      monospace(),
  };
}

/** What draws pages, for the cells and the theme there are. */
export interface Typeset {
  typesetter: Typesetter;
  cell: CellSize;
  dark: boolean;
}

export interface TypesetHost {
  /** Pages have come, to be shown. */
  arrived: () => void;
}

export class Typesetter {
  #host: TypesetHost;
  #child: ChildProcess | null = null;
  #waiting: { take: (reply: Reply | null) => void }[] = [];
  #states = new WeakMap<object, State>();
  /** What each page is being drawn as, and what it should be next. */
  #drawing = new WeakMap<object, { now: string; next: Want | null }>();
  #failed = new WeakMap<object, string>();
  #usable: boolean | null = null;
  #stamp = 0;
  #told = false;
  /** When the first page the host has not been told of came. */
  #since: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(host: TypesetHost) {
    this.#host = host;
    this.#start();
  }

  /** Counts the pages that have come, so what waited for one knows to look again. */
  get stamp(): number {
    return this.#stamp;
  }

  /** Whether pages can be drawn; null while it is not known yet. */
  get usable(): boolean | null {
    return this.#usable;
  }

  close(): void {
    this.#child?.kill();
    this.#child = null;
  }

  #start(): void {
    const binary = process.env["HTML2TERM_BIN"] || findExecutable("html2term");
    if (!binary) {
      this.#usable = false;
      return;
    }
    const { text, code } = fonts();
    const child = spawn(
      binary,
      [
        "serve",
        ...(text ? ["--font", `Text=${text}`] : []),
        ...(code ? ["--font", `Code=${code}`] : []),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.#child = child;
    const end = () => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#usable = false;
      for (const { take } of this.#waiting.splice(0)) take(null);
      this.#arrive();
    };
    child.on("error", end);
    child.on("close", end);
    child.stdin.on("error", () => {});
    child.unref();
    for (const stream of [child.stdin, child.stdout])
      (stream as unknown as { unref?: () => void }).unref?.();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const waiting = this.#waiting.shift();
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      if (this.#waiting.length > 0) this.#watch();
      let reply: Reply | null = null;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        // Nothing it says but JSON means anything; the page stays text.
      }
      waiting?.take(reply?.ok ? reply : null);
    });
    // An html2term too old to draw pages this way refuses the options, and says so here.
    void this.#ask(
      "<p>.</p>",
      { columns: 4, cell: { width: 8, height: 16 }, dark: true },
      0,
      1,
    ).then((reply) => {
      this.#usable = reply !== null && reply.layer !== undefined;
      this.#arrive();
    });
  }

  #watch(): void {
    this.#timer ??= setTimeout(() => this.#child?.kill("SIGKILL"), TIMEOUT_MS);
    this.#timer.unref();
  }

  #ask(
    html: string,
    { columns, cell, dark }: Pick<Want, "columns" | "cell" | "dark">,
    top: number,
    rows: number,
  ): Promise<Reply | null> {
    const { promise, resolve } = Promise.withResolvers<Reply | null>();
    const child = this.#child;
    if (!child?.stdin) return Promise.resolve(null);
    const scale = density(cell);
    const options = {
      width: Math.ceil((columns * cell.width) / scale),
      pixel_width: columns * cell.width,
      scale,
      appearance: dark ? "dark" : "light",
      transparent: true,
      top,
      row: cell.height,
      most: rows * cell.height,
      layer: true,
      small: true,
    };
    this.#waiting.push({ take: resolve });
    this.#watch();
    child.stdin.write(`${JSON.stringify({ html, options })}\n`);
    return promise;
  }

  /**
   * Tells the host, once for all that come together: pages still being drawn
   * would only move those that have come, whose pictures may then be out of view.
   */
  #arrive(): void {
    this.#stamp++;
    this.#since ??= performance.now();
    if (this.#told) return;
    this.#told = true;
    setImmediate(() => {
      this.#told = false;
      const since = this.#since ?? 0;
      if (this.#waiting.length > 0 && performance.now() - since < TOGETHER_MS) return;
      this.#since = null;
      this.#host.arrived();
    });
  }

  /**
   * The page for `owner` with `body`'s blocks, `columns` wide. While it is
   * drawn, what it was before, or "pending" the first time; null where it
   * cannot be drawn.
   */
  sheet(
    owner: object,
    body: string[],
    columns: number,
    cell: CellSize,
    dark: boolean,
  ): { sheet: Sheet; stale: boolean } | "pending" | null {
    if (this.#usable === false) return null;
    const shape = `${columns}:${cell.width}x${cell.height}:${dark}`;
    const key = `${shape}\0${body.join("")}`;
    if (this.#failed.get(owner) === key) return null;
    const state = this.#states.get(owner);
    if (state?.key === key) return { sheet: state.sheet, stale: false };
    const want: Want = { key, body, columns, cell, dark };
    const drawing = this.#drawing.get(owner);
    if (!drawing) void this.#draw(owner, want);
    else if (drawing.now !== key) drawing.next = want;
    // A page at another width says nothing of how this one is laid out.
    if (state && state.key.startsWith(`${shape}\0`)) return { sheet: state.sheet, stale: true };
    return "pending";
  }

  /** Whether a page at this size has been drawn for `owner`, whatever it then said. */
  known(owner: object, columns: number, cell: CellSize, dark: boolean): boolean {
    const shape = `${columns}:${cell.width}x${cell.height}:${dark}\0`;
    return this.#states.get(owner)?.key.startsWith(shape) === true || this.#failed.has(owner);
  }

  async #draw(owner: object, want: Want): Promise<void> {
    const drawing: { now: string; next: Want | null } = { now: want.key, next: null };
    this.#drawing.set(owner, drawing);
    const state = await this.#drawn(this.#states.get(owner), want);
    this.#drawing.delete(owner);
    if (state) this.#states.set(owner, state);
    else this.#failed.set(owner, want.key);
    this.#arrive();
    if (drawing.next) void this.#draw(owner, drawing.next);
  }

  /** The page drawn, but for the rows `before` drew that are the same above and below what changed. */
  async #drawn(before: State | undefined, want: Want): Promise<State | null> {
    const { cell, columns, key } = want;
    const shape = key.slice(0, key.indexOf("\0") + 1);
    const old = before?.key.startsWith(shape) ? before : null;
    let from = 0;
    /** The first block after what changed, and where it was, if it is still there. */
    let rest: { block: number; y: number } | null = null;
    if (old) {
      const differs = old.body.findIndex((block, index) => block !== want.body[index]);
      from = Math.floor((differs === -1 ? old.pixels : blockTop(old.hits, differs)) / cell.height);
      let same = 0;
      while (
        same < old.body.length - Math.max(0, differs) - 1 &&
        old.body.at(-1 - same) === want.body.at(-1 - same)
      )
        same++;
      if (differs !== -1 && same > 0 && old.body.length === want.body.length) {
        const block = old.body.length - same;
        rest = { block, y: blockTop(old.hits, block) };
      }
    }
    const html = page(want.body.join(""));
    const kept = cut(old?.slices ?? [], 0, from);
    const slices = [...kept];
    let reply: Reply | null = null;
    for (let row = from; ;) {
      // As far as what comes after is, which need not be drawn if it has not moved.
      const most = rest ? Math.max(1, Math.ceil(rest.y / cell.height) - row) : MOST_ROWS;
      reply = await this.#ask(html, want, row * cell.height, Math.min(most, MOST_ROWS));
      if (!reply) return null;
      const rows = Math.max(1, Math.round(reply.height / cell.height));
      slices.push({
        origin: row,
        from: row,
        to: row + rows,
        picture: encodedPicture(reply.png, reply.width, reply.height),
        rows,
      });
      const top = row * cell.height;
      for (const run of reply.layer.text) {
        run.top += top;
        run.bottom += top;
      }
      for (const hit of reply.layer.hits) hit.y += top;
      row += rows;
      if (old && rest && row * cell.height >= rest.y) {
        const moved =
          Math.abs(blockTop(reply.layer.hits, rest.block) - rest.y) > 0.5 ||
          Math.abs(reply.page_pixels - old.pixels) > 0.5;
        if (!moved) {
          slices.push(...cut(old.slices, row, Infinity));
          break;
        }
        rest = null;
      }
      // A hair past a whole row is the row's own rounding.
      if (row * cell.height >= reply.page_pixels - 0.5 || slices.length > 400) break;
    }
    const { layer, page_pixels: pixels } = reply;
    return {
      key,
      body: want.body,
      slices,
      hits: layer.hits,
      pixels,
      sheet: sheetOf(slices, layer.text, layer.hits, pixels, columns, cell),
    };
  }
}

/** Where a page's block starts, down it. */
function blockTop(hits: readonly HitBox[], block: number): number {
  return Math.max(0, hits.find((one) => one.id === `b:${block}`)?.y ?? 0);
}

/** What of some slices is on rows `from` to before `to`. */
function cut(slices: readonly Slice[], from: number, to: number): Slice[] {
  return slices.flatMap((slice) => {
    const part = { ...slice, from: Math.max(slice.from, from), to: Math.min(slice.to, to) };
    return part.from < part.to ? [part] : [];
  });
}

/** When each line was last drawn, and as what but for its counts. */
const drawnLines = new WeakMap<object, { html: string; kind: string; at: number }>();
/** How often a line is drawn again when only its counts change. */
const LINE_MS = 1000;

/**
 * A row typeset on one row of cells, as a line under the composer is; as it
 * was until it is drawn, and while only counts in it tick on, for a while.
 */
export function typeLine(
  set: Typeset,
  owner: object,
  row: string,
  columns: number,
  collect: (shown: Shown) => void,
): string {
  if (row.trim() === "") return row;
  const { typesetter, cell, dark } = set;
  const scale = density(cell);
  const height = Math.floor(cell.height / scale);
  let html = lineHtml(row, height, Math.floor((columns * cell.width) / scale));
  const kind = `${columns}:${dark}:${html.replace(/\d[\d.,]*[kM]?/g, "0")}`;
  const last = drawnLines.get(owner);
  if (last?.kind === kind && performance.now() - last.at < LINE_MS) html = last.html;
  else if (last?.html !== html) drawnLines.set(owner, { html, kind, at: performance.now() });
  const drawn = typesetter.sheet(owner, [html], columns, cell, dark);
  if (drawn === null) return row;
  if (drawn === "pending") return "";
  for (const shown of drawn.sheet.pictures) collect(shown);
  return drawn.sheet.rows[0] ?? "";
}

/** A page's rows, its text noted by row, for `textRow` to find. */
function sheetOf(
  slices: readonly Slice[],
  text: readonly TextRun[],
  hits: readonly HitBox[],
  pixels: number,
  columns: number,
  cell: CellSize,
): Sheet {
  const lines = new Map<number, TextRun[]>();
  for (const run of text) {
    // A line's row is the one its middle is on, so each line has one row and no row two.
    const row = Math.floor((run.top + run.bottom) / 2 / cell.height);
    lines.set(row, [...(lines.get(row) ?? []), run]);
  }
  const rows: string[] = [];
  const pictures: Sheet["pictures"] = [];
  for (const { origin, from, to, picture, rows: count } of slices) {
    pictures.push({ picture, columns, rows: count, start: from, end: to });
    const noted = new Map<number, TextRow>();
    const on = new Map<number, LineOn[]>();
    for (let row = from; row < to; row++) {
      const runs = (lines.get(row) ?? []).toSorted((a, b) => a.x - b.x);
      rows.push(pictureRow(picture.id, row - origin, columns, runs, cell.width));
      if (runs.length > 0) noted.set(row - origin, cellsOf(runs, columns, cell.width));
      const near = [row - 1, row, row + 1].flatMap((own): LineOn[] => {
        const line = lines.get(own);
        if (!line) return [];
        const top = Math.max(row * cell.height, Math.min(...line.map((run) => run.top)));
        const bottom = Math.min(
          (row + 1) * cell.height,
          Math.max(...line.map((run) => run.bottom)),
        );
        if (own !== row && bottom - top < cell.height * COVERS) return [];
        const left = Math.min(...line.map((run) => run.x));
        const right = Math.max(...line.map((run) => run.x + (run.ends.at(-1) ?? 0)));
        return [
          {
            own: own - row,
            from: Math.floor(left / cell.width),
            to: Math.min(columns, Math.ceil(right / cell.width)),
          },
        ];
      });
      if (near.length > 0) on.set(row - origin, near);
    }
    texts.set(picture.id, { text: noted, lines: on });
  }
  const over = (round: (edge: number) => number, last: (edge: number) => number) =>
    hits
      .filter((hit) => !hit.id.startsWith("b:"))
      .map((hit) => ({
        id: hit.id,
        start: round(hit.y / cell.height),
        end: last((hit.y + hit.height) / cell.height),
      }));
  return {
    rows,
    pictures,
    height: pixels / cell.height,
    spots: over(Math.floor, Math.ceil),
    middles: over(Math.round, Math.round),
  };
}

/** A row's placeholder cells, those over a link linked to where it goes. */
function pictureRow(
  id: number,
  row: number,
  columns: number,
  runs: readonly TextRun[],
  cellWidth: number,
): string {
  const links = runs.flatMap((run) => {
    const url = run.href;
    if (!url || [...url].some((char) => char <= " " || char === "\x7f")) return [];
    const end = run.x + (run.ends.at(-1) ?? 0);
    return [{ url, from: Math.floor(run.x / cellWidth), to: Math.ceil(end / cellWidth) }];
  });
  let out = placeholderColor(id);
  let open = "";
  for (let column = 0; column < columns; column++) {
    const url = links.find((link) => column >= link.from && column < link.to)?.url ?? "";
    if (url !== open) out += `\x1b]8;;${url}\x1b\\`;
    open = url;
    out += placeholderMark(row, column);
  }
  return `${out}${open ? "\x1b]8;;\x1b\\" : ""}\x1b[39m`;
}

/** A line's characters, each under the cell its middle is over. */
function cellsOf(runs: readonly TextRun[], columns: number, cellWidth: number): TextRow {
  const cells: (string | null)[] = Array.from({ length: columns }, () => null);
  let end = 0;
  for (const run of runs) {
    let from = run.x;
    // What stands apart without a space between, as a table's cells do, is apart in its text.
    const gap = run.x - end;
    if (end > 0 && gap > cellWidth * 1.5) {
      const between = Math.min(columns - 1, Math.floor((end + gap / 2) / cellWidth));
      cells[between] = "\t";
    }
    let index = 0;
    for (const char of run.text) {
      const to = run.x + (run.ends[index++] ?? 0);
      const at = Math.max(0, Math.min(columns - 1, Math.floor((from + to) / 2 / cellWidth)));
      cells[at] = (cells[at] ?? "") + char;
      from = to;
    }
    end = from;
  }
  const last = cells.findLastIndex((cell) => cell !== null);
  const begin = cells.findIndex((cell) => cell !== null);
  // Between characters a line is whole, though a wide one is over more cells than its own.
  for (let at = begin; at >= 0 && at < last; at++) cells[at] ??= "";
  return { cells, wraps: runs.some((run) => run.wraps) };
}
