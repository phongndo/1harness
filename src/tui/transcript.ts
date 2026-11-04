import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportSpan } from "../commands/registry.ts";
import type { CommandAction, FileChange, Item, TodoStep, NoticeLevel } from "../core/events.ts";
import { fileName, plural } from "../core/wording.ts";
import {
  isLive,
  paintStatus,
  plainLine,
  statusDot,
  type AgentRow,
  type AgentStatus,
} from "./agents.ts";
import { FIGURE_NAMES, type Figure } from "./figures.ts";
import { htmlText } from "./html.ts";
import { fit, pictureRows, type MediaContext, type Picture, type Shown } from "./images.ts";
import { renderMarkdown, type MarkdownOptions } from "./markdown.ts";
import { diffLine, style } from "./theme.ts";
import {
  diffBody,
  firstLine,
  oneLineText,
  outputText,
  plainText,
  shownPath,
  spread,
  truncate,
  visibleWidth,
  wrap,
} from "./text.ts";

export type ToolItem = Extract<
  Item,
  { kind: "command" | "file_change" | "tool_call" | "web_search" | "agent" }
>;

export type Block =
  /** A message for the agent; `label` says who sent it when the user did not, such as `Task from t1`. */
  | { kind: "user"; text: string; label?: string; images?: string[] }
  /** A task's result, as it reached the thread that delegated it. */
  | { kind: "result"; from: string; status: AgentStatus; text: string }
  | { kind: "assistant"; text: string }
  /** What the model thought, as the harness summarizes it: a line, or all of it in detail. */
  | { kind: "thinking"; text: string; folded?: boolean }
  | { kind: "plan"; text: string }
  /**
   * Consecutive tool items, shown as one tree. Settled once their turn has
   * ended; `awaiting` holds the ones an open approval is for.
   */
  | {
      kind: "tools";
      items: ToolItem[];
      settled: boolean;
      awaiting?: string[];
      /** Calls cut off when their turn ended, in a group a command outlives. */
      cut?: string[];
      /** Folded into its finished turn's summary, shown only in detail. */
      folded?: boolean;
    }
  | { kind: "todos"; steps: TodoStep[]; folded?: boolean }
  /**
   * What a finished turn did, in place of its work: a sentence, and the files
   * it changed with their lines added and removed.
   */
  | {
      kind: "worked";
      text: string;
      files: { path: string; added: number; removed: number }[];
      /** What failed among the folded work, which should not take ctrl+x to find. */
      failures?: string[];
    }
  | { kind: "notice"; level: NoticeLevel; text: string }
  /** A 1harness command's output, such as /mcp: a heading over aligned lines. */
  | { kind: "report"; title: string; lines: ReportSpan[][] }
  /** The agents a turn started: one row each, with its status and how it ended. */
  | { kind: "agents"; rows: AgentRow[] }
  /** The muted line that closes a turn: duration and token estimate. */
  | { kind: "summary"; text: string; outcome?: "completed" | "interrupted" | "failed" }
  /**
   * An image, with a caption under it; with its file's `path`, drawn again
   * from the file for other cells.
   */
  | { kind: "image"; picture: Picture; title: string; path?: string }
  /** A page the agent showed, drawn as a picture where the terminal shows them. */
  | { kind: "html"; title: string; html: string }
  /** How the user answered a request, as the thread's log recorded it. */
  | {
      kind: "decision";
      request: "approval" | "question";
      title: string;
      answer: string;
      outcome: "allowed" | "declined" | "answered" | "dismissed";
    };

/**
 * What a row does when it is clicked: a picture opens on the whole screen,
 * where it can be drawn sharper (from its file, page, or figure's source);
 * a code block is copied; tool calls show whole, or in brief again.
 */
export type Target =
  | {
      kind: "picture";
      picture: Picture;
      title: string;
      path?: string;
      html?: string;
      figure?: Figure;
    }
  | { kind: "code"; code: string; lang: string }
  /** Tool calls and the work a turn folded away, which show whole or in brief. */
  | { kind: "details" };

/** What a row in view does when clicked, and which of the target's rows it is. */
export interface Hit {
  target: Target;
  row: number;
}

/** A target over rows `start` to before `end` of a block. */
interface Spot {
  start: number;
  end: number;
  target: Target;
}

export interface RenderContext {
  width: number;
  cwd: string;
  /** Phase of the shared blink, for markers of work in progress. */
  blink: boolean;
  /** The time timers count to. */
  now: number;
  /** Shows tool calls whole: full commands, their output, and diffs. */
  details?: boolean;
  /** Whether images show, and the cells they are laid out in; without it, captions only. */
  media?: MediaContext;
  /**
   * A figure's rows at a width, a diagram's or an equation's: placeholder
   * rows and the picture they show, or text; null to show its source.
   */
  figure?: (figure: Figure, columns: number) => { rows: string[]; picture?: Shown } | null;
  /** Takes the pictures a block's rows show, for the screen to send ahead of them. */
  collect?: (shown: Shown) => void;
  /** Takes what rows `start` to before `end` of the block do when clicked. */
  mark?: (target: Target, start: number, end: number) => void;
  /** An image file's picture, fetched where the thread runs; undefined until it arrives. */
  image?: (path: string) => Picture | null | undefined;
  /** What a thread is doing, by its title, for naming the agents that report back. */
  threadTitle?: (threadId: string) => string | null;
  /**
   * A page's rows at a width: placeholder rows and the picture they show, or
   * a line saying it is being drawn; null to show its text instead.
   */
  html?: (
    html: string,
    columns: number,
  ) => { rows: string[]; picture?: Shown; live?: boolean } | null;
}

/** Columns kept on each side of an image, as prose has. */
export const IMAGE_INDENT = 2;

function mediaKey(media: MediaContext | undefined): string {
  return media && media.graphics
    ? `${media.cell.width}x${media.cell.height}:${media.maxRows}`
    : "text";
}

/**
 * A streaming reply's rows up to its last blank line between blocks, which
 * what streams after cannot change, for the next frame to render only the
 * rest: by the layout they were rendered for.
 */
interface Settled {
  layout: string;
  text: string;
  rows: string[];
  pictures: Shown[];
  spots: Spot[];
}

interface Entry {
  block: Block;
  version: number;
  settled?: Settled | null;
  cache: {
    width: number;
    version: number;
    blink: boolean;
    details: boolean;
    media: string;
    rows: string[];
    /** The pictures its rows show. */
    pictures: Shown[];
    /** What its rows do when clicked. */
    spots: Spot[];
  } | null;
}

const USER_LINES = 24;

export function isToolItem(item: Item): item is ToolItem {
  return (
    item.kind === "command" ||
    item.kind === "file_change" ||
    item.kind === "tool_call" ||
    item.kind === "web_search" ||
    item.kind === "agent"
  );
}

/**
 * The conversation as blocks separated by blank rows. Each block's rows are
 * cached by width and version, so a streamed delta re-renders only its block
 * and a frame costs one pass over the block list.
 */
export class Transcript {
  #entries: Entry[] = [];

  get size(): number {
    return this.#entries.length;
  }

  /** The newest block, looking past those `skip` accepts. */
  last(skip: (block: Block) => boolean = () => false): Block | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const block = this.#entries[index]?.block;
      if (block && !skip(block)) return block;
    }
    return undefined;
  }

  /** Puts a block in just before another, which must be in the transcript. */
  insertBefore<T extends Block>(block: T, before: Block): T {
    const at = this.#entries.findIndex((entry) => entry.block === before);
    this.#entries.splice(at === -1 ? this.#entries.length : at, 0, {
      block,
      version: 0,
      cache: null,
    });
    return block;
  }

  add<T extends Block>(block: T): T {
    this.#entries.push({ block, version: 0, cache: null });
    return block;
  }

  /** Marks a block as changed after mutating it. */
  touch(block: Block): void {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (entry?.block === block) {
        entry.version++;
        return;
      }
    }
  }

  remove(block: Block): void {
    this.#entries = this.#entries.filter((entry) => entry.block !== block);
  }

  /** Drops every cached row, for a theme change. */
  invalidate(): void {
    for (const entry of this.#entries) {
      entry.cache = null;
      entry.settled = null;
    }
  }

  /** Whether any block shows work in progress and needs the blink. */
  get animating(): boolean {
    return this.#entries.some((entry) => isAnimated(entry.block));
  }

  /** Whether a tool row is still running; agents at work are not counted. */
  get running(): boolean {
    return this.#entries.some((entry) => isRunningGroup(entry.block));
  }

  /** Blocks added after the first `count`, for what a turn added. */
  since(count: number): Block[] {
    return this.#entries.slice(count).map((entry) => entry.block);
  }

  /** Where the last message the user sent starts among all rows, or the top when there is none. */
  lastTurnRow(context: RenderContext): number {
    let total = 0;
    let row = 0;
    for (const entry of this.#entries) {
      const { rows } = this.#rows(entry, context);
      if (rows.length === 0) continue;
      if (total > 0) total += 1;
      if (entry.block.kind === "user") row = total;
      total += rows.length;
    }
    return row;
  }

  /** What the user last said at or above `row`, which rows under it answer. */
  askedAbove(context: RenderContext, row: number): string | null {
    let total = 0;
    let asked: string | null = null;
    for (const entry of this.#entries) {
      const { rows } = this.#rows(entry, context);
      if (rows.length === 0) continue;
      if (total > 0) total += 1;
      if (total > row) break;
      if (entry.block.kind === "user") asked = entry.block.text;
      total += rows.length;
    }
    return asked;
  }

  /**
   * The rows in view, `height` of them ending `scroll` rows above the last,
   * with the pictures they show and what each does when clicked; `top` is
   * the first one's place among all `total` rows.
   */
  view(
    context: RenderContext,
    height: number,
    scroll: number,
  ): {
    rows: string[];
    total: number;
    pictures: Shown[];
    targets: (Hit | null)[];
    top: number;
  } {
    const blocks: { rows: string[]; pictures: Shown[]; spots: Spot[] }[] = [];
    let total = 0;
    for (const entry of this.#entries) {
      const rendered = this.#rows(entry, context);
      if (rendered.rows.length === 0) continue;
      total += rendered.rows.length + (blocks.length > 0 ? 1 : 0);
      blocks.push(rendered);
    }
    const end = Math.max(0, total - Math.max(0, scroll));
    const start = Math.max(0, end - height);
    const rows: string[] = [];
    const targets: (Hit | null)[] = [];
    const pictures: Shown[] = [];
    let position = 0;
    for (const [index, { rows: block, pictures: used, spots }] of blocks.entries()) {
      const separated = index > 0;
      const size = block.length + (separated ? 1 : 0);
      if (position + size > start && position < end) {
        if (separated && position >= start) {
          rows.push("");
          targets.push(null);
        }
        const from = Math.max(0, start - position - (separated ? 1 : 0));
        const to = Math.min(block.length, end - position - (separated ? 1 : 0));
        // The pictures of a block in view go to the terminal ahead of the text showing them.
        for (const shown of used)
          if (!pictures.some((other) => other.picture.id === shown.picture.id))
            pictures.push(shown);
        for (let row = from; row < to; row++) {
          rows.push(block[row] ?? "");
          const spot = spots.find((one) => row >= one.start && row < one.end);
          targets.push(spot ? { target: spot.target, row: row - spot.start } : null);
        }
      }
      position += size;
      if (position >= end) break;
    }
    return { rows, total, pictures, targets, top: start };
  }

  #rows(
    entry: Entry,
    context: RenderContext,
  ): { rows: string[]; pictures: Shown[]; spots: Spot[] } {
    // A live block renders again on each blink, which also moves its timers on.
    const blink = isAnimated(entry.block) && context.blink;
    const details = context.details === true;
    const media = mediaKey(context.media);
    const cache = entry.cache;
    if (
      cache &&
      cache.width === context.width &&
      cache.version === entry.version &&
      cache.blink === blink &&
      cache.details === details &&
      cache.media === media
    ) {
      return cache;
    }
    const pictures: Shown[] = [];
    const spots: Spot[] = [];
    const marking: RenderContext = {
      ...context,
      collect: (shown) => pictures.push(shown),
      mark: (target, start, end) => spots.push({ start, end, target }),
    };
    const rows =
      entry.block.kind === "assistant"
        ? replyRows(entry, entry.block.text, marking, `${context.width}\0${details}\0${media}`, {
            pictures,
            spots,
          })
        : renderBlock(entry.block, marking);
    entry.cache = {
      width: context.width,
      version: entry.version,
      blink,
      details,
      media,
      rows,
      pictures,
      spots,
    };
    return entry.cache;
  }
}

/**
 * A reply's rows, rendering only what came after the rows it had settled at
 * this layout, while the reply has only grown since; `into` takes the
 * pictures and spots, as `context` collects and marks them.
 */
function replyRows(
  entry: Entry,
  text: string,
  context: RenderContext,
  layout: string,
  into: { pictures: Shown[]; spots: Spot[] },
): string[] {
  if (text.trim() === "") return [];
  const known = entry.settled;
  const base: Settled =
    known && known.layout === layout && text.startsWith(known.text)
      ? known
      : { layout, text: "", rows: [], pictures: [], spots: [] };
  into.pictures.push(...base.pictures);
  into.spots.push(...base.spots);
  const tail = text.slice(base.text.length);
  const marks: { line: number; rows: number; pictures: number; spots: number }[] = [];
  const rows = renderMarkdown(tail, context.width, "  ", {
    ...markdownOptions(context, base.rows.length),
    settled: (line, at) =>
      marks.push({ line, rows: at, pictures: into.pictures.length, spots: into.spots.length }),
  });
  entry.settled = base;
  const settle = marks.at(-1);
  if (settle && settle.rows <= rows.length) {
    let end = -1;
    for (let line = 0; line <= settle.line; line++) {
      end = tail.indexOf("\n", end + 1);
      if (end === -1) break;
    }
    // A line without its newline may yet grow; escapes and carriage returns can reach across lines.
    const done = end === -1 ? "" : tail.slice(0, end + 1);
    if (done !== "" && !["\r", "\x1b", "\x9b"].some((char) => done.includes(char)))
      entry.settled = {
        layout,
        text: base.text + done,
        rows: [...base.rows, ...rows.slice(0, settle.rows)],
        pictures: into.pictures.slice(0, settle.pictures),
        spots: into.spots.slice(0, settle.spots),
      };
  }
  if (rows.length > 0) return [...base.rows, ...rows];
  const all = [...base.rows];
  while (all.at(-1) === "") all.pop();
  return all;
}

function isAnimated(block: Block): boolean {
  if (block.kind === "agents") return block.rows.some((row) => isLive(row.status));
  return isRunningGroup(block);
}

function isRunningGroup(block: Block): boolean {
  return (
    block.kind === "tools" &&
    !block.settled &&
    block.items.some((item) => item.status === "running" && !block.cut?.includes(item.id))
  );
}

export function renderBlock(block: Block, context: RenderContext): string[] {
  const { width } = context;
  // A finished turn's work shows as its summary; in detail, all of it.
  if ("folded" in block && block.folded && !context.details) return [];
  switch (block.kind) {
    case "user":
      return userRows(block, context);
    case "result":
      return resultRows(block, context);
    case "thinking":
      return thinkingRows(block.text, context);
    case "worked":
      // In detail, the work it stands for shows right under it, saying the same.
      return context.details
        ? []
        : marked(workedRows(block, context), { kind: "details" }, context);
    case "assistant":
      return block.text.trim() === ""
        ? []
        : renderMarkdown(block.text, width, "  ", markdownOptions(context, 0));
    case "plan":
      return [
        truncate(`${style.strong("●")} ${style.bold("Proposed plan")}`, width),
        ...renderMarkdown(block.text, width, "  ", markdownOptions(context, 1)),
      ];
    case "tools":
      return marked(toolRows(block, context), { kind: "details" }, context);
    case "todos":
      return todoRows(block.steps, width);
    case "notice":
      return noticeRows(block, width);
    case "report":
      return reportRows(block, width);
    case "agents":
      return agentRows(block, context);
    case "summary":
      return [truncate(summaryRow(block, width), width)];
    case "decision":
      return decisionRows(block, width);
    case "image":
      return imageRows(block, context);
    case "html":
      return htmlRows(block, context);
  }
}

/** How the turn went stands apart from its counts: it is what a glance at the end looks for. */
function summaryRow(block: Extract<Block, { kind: "summary" }>, width: number): string {
  const { outcome, text } = block;
  if (!outcome) return style.muted(`  ${text}`);
  const at = text.indexOf(" · ");
  const label = at === -1 ? text : text.slice(0, at);
  const all = at === -1 ? "" : text.slice(at);
  // A narrow pane gives up what it says last, whole, not cut mid-word.
  const room = width - visibleWidth(label) - 4;
  const rest = visibleWidth(all) <= room ? all : all.slice(0, Math.max(0, all.lastIndexOf(" · ")));
  const said =
    outcome === "failed"
      ? style.removed(`✗ ${label}`)
      : outcome === "interrupted"
        ? style.attention(`■ ${label}`)
        : `${style.added("✓")} ${label}`;
  return `  ${style.bold(said)}${style.muted(rest)}`;
}

/** Lines of a page's text shown where it is not drawn, until ctrl+x shows them all. */
const PAGE_TEXT_LINES = 12;

/**
 * A page's rows: its picture, drawn where the thread runs at the
 * transcript's width, over a caption; or, where it cannot be drawn, its text.
 */
function htmlRows(block: Extract<Block, { kind: "html" }>, context: RenderContext): string[] {
  const { width } = context;
  const title = oneLineText(block.title);
  const drawn = context.html?.(block.html, width - IMAGE_INDENT * 2);
  const indent = " ".repeat(IMAGE_INDENT);
  if (drawn) {
    if (drawn.picture) {
      context.collect?.(drawn.picture);
      context.mark?.(
        { kind: "picture", picture: drawn.picture.picture, title, html: block.html },
        0,
        drawn.rows.length + 1,
      );
    }
    // A live page takes clicks itself; its caption is what opens it whole.
    const caption = drawn.live
      ? `${title} · live page · click here to open it whole`
      : `${title} · page`;
    return [
      ...drawn.rows.map((row) => indent + row),
      truncate(`${indent}${style.muted(caption)}`, width),
    ];
  }
  const lines = htmlText(block.html);
  const shown = context.details ? lines : lines.slice(0, PAGE_TEXT_LINES);
  const rows = [
    truncate(`${style.strong("▣")} ${style.text(title)} ${style.muted("· page")}`, width),
  ];
  for (const line of shown)
    rows.push(...wrap(indent + style.soft(oneLineText(line)), width, indent));
  if (lines.length > shown.length)
    rows.push(
      truncate(
        `${indent}${style.muted(`… ${lines.length - shown.length} more lines · ctrl+x shows them`)}`,
        width,
      ),
    );
  return rows;
}

/** Changed files a turn's summary lists before saying how many more. */
const WORKED_FILES = 6;

/** A finished turn's work in a line, over the files it changed. */
function workedRows(block: Extract<Block, { kind: "worked" }>, context: RenderContext): string[] {
  const failures = block.failures ?? [];
  const detail = failures.length > 0 ? " · ctrl+x shows output" : "";
  const rows = [
    truncate(`${style.strong("●")} ${style.muted(`${block.text}${detail}`)}`, context.width),
  ];
  const files = block.files.slice(0, WORKED_FILES);
  const more = block.files.length - files.length;
  failures.forEach((failure, index) => {
    const last = index === failures.length - 1 && files.length === 0 && more === 0;
    rows.push(
      truncate(`${style.muted(last ? "└ " : "├ ")}${style.removed(`✗ ${failure}`)}`, context.width),
    );
  });
  files.forEach((file, index) => {
    const last = index === files.length - 1 && more === 0;
    const counts = [
      file.added > 0 ? style.added(`+${file.added}`) : "",
      file.removed > 0 ? style.removed(`−${file.removed}`) : "",
    ]
      .filter(Boolean)
      .join(" ");
    rows.push(
      truncate(
        `${style.muted(last ? "└ " : "├ ")}${style.text(shownPath(file.path, context.cwd))} ${counts}`,
        context.width,
      ),
    );
  });
  if (more > 0) rows.push(style.muted(`└ ${plural(more, "more file")}`));
  return rows;
}

/** Rows of thinking shown before the rest waits for details. */
const THINKING_LINES = 1;

/**
 * Thinking, quietly: its first line, or every line in detail, under a hollow
 * mark. A heading the model gave it, as **Planning the fix**, leads.
 */
function thinkingRows(text: string, context: RenderContext): string[] {
  const lines = plainText(text)
    .split("\n")
    .map((line) => line.replace(/\*\*([^*]+)\*\*/g, "$1").trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const shown = context.details ? lines : lines.slice(0, THINKING_LINES);
  const more = lines.length - shown.length;
  const rows = shown.flatMap((line, index) =>
    wrap(
      `${index === 0 ? style.faint("◦ ") : "  "}${style.muted(style.italic(line))}`,
      context.width,
      "  ",
    ),
  );
  // Collapsed, one line, cut to the width, with how much more there is.
  if (!context.details) {
    const head = rows[0] ?? "";
    return [truncate(more > 0 ? `${head} ${style.faint(`+${more}`)}` : head, context.width)];
  }
  return rows;
}

/** A block's rows, all marked as doing `target` when clicked. */
function marked(rows: string[], target: Target, context: RenderContext): string[] {
  if (rows.length > 0) context.mark?.(target, 0, rows.length);
  return rows;
}

/**
 * Where an image a reply links to is, on the machine the thread runs on: a
 * path, or a `file:` URL, taken from the thread's folder; null for one on
 * the web, which is not fetched.
 */
export function imagePath(src: string, cwd: string): string | null {
  try {
    if (/^file:/i.test(src)) return fileURLToPath(src);
    if (/^[a-z][\w+.-]*:/i.test(src) || src.startsWith("//")) return null;
    return resolve(cwd, decodeURI(src));
  } catch {
    return null;
  }
}

/**
 * Markdown's options for a block whose Markdown starts `offset` rows in:
 * figures and images drawn by the context, with their pictures collected,
 * and code blocks, figures, and images marked as what a click on them does.
 */
function markdownOptions(context: RenderContext, offset: number): MarkdownOptions {
  const draw = context.figure;
  const drawn = new Map<string, Shown>();
  const images = new Map<string, { shown: Shown; path: string }>();
  const media = context.media;
  return {
    ...(draw
      ? {
          figure: (figure: Figure, columns: number) => {
            const result = draw(figure, columns);
            if (result?.picture) {
              context.collect?.(result.picture);
              drawn.set(`${figure.kind}\0${figure.source}`, result.picture);
            }
            return result?.rows ?? null;
          },
        }
      : {}),
    // An image shows where the terminal can draw it, once it has come; until
    // then, and where it cannot, its description stands in for it.
    image: (src: string, alt: string, columns: number) => {
      if (!media?.graphics || !context.image) return null;
      const path = imagePath(src, context.cwd);
      const image = path ? context.image(path) : null;
      if (!path || !image) return null;
      const size = fit(image, columns, media);
      const shown = { picture: image, ...size };
      context.collect?.(shown);
      images.set(src, { shown, path });
      const rows = pictureRows(image, size);
      if (alt.trim()) rows.push(style.muted(truncate(oneLineText(alt), columns)));
      return rows;
    },
    region: (region) => {
      if (!context.mark) return;
      const start = region.start + offset;
      const end = region.end + offset;
      if (region.kind === "code")
        context.mark({ kind: "code", code: region.code, lang: region.lang }, start, end);
      else if (region.kind === "figure") {
        const { figure } = region;
        const shown = drawn.get(`${figure.kind}\0${figure.source}`);
        if (shown)
          context.mark(
            {
              kind: "picture",
              picture: shown.picture,
              title: FIGURE_NAMES[figure.kind].title,
              figure,
            },
            start,
            end,
          );
      } else {
        const image = images.get(region.src);
        if (image)
          context.mark(
            {
              kind: "picture",
              picture: image.shown.picture,
              title: region.alt.trim() || fileName(image.path),
              path: image.path,
            },
            start,
            end,
          );
      }
    },
  };
}

/**
 * An image's rows: placeholder characters the terminal draws its picture in,
 * then a caption. A terminal that shows no images gets the caption alone,
 * saying so.
 */
function imageRows(block: Extract<Block, { kind: "image" }>, context: RenderContext): string[] {
  // The file drawn for these cells once it comes; the picture it was first shown with until then.
  const fresh = block.path && context.media?.graphics ? context.image?.(block.path) : undefined;
  const image = fresh ?? block.picture;
  const title = oneLineText(block.title);
  const size = `${image.pixelWidth}×${image.pixelHeight}`;
  const media = context.media;
  if (!media?.graphics)
    return [
      truncate(
        `${style.strong("▣")} ${style.text(title)} ${style.muted(`· ${size} · this terminal shows no images`)}`,
        context.width,
      ),
    ];
  const fitted = fit(image, context.width - IMAGE_INDENT * 2, media);
  context.collect?.({ picture: image, ...fitted });
  context.mark?.(
    { kind: "picture", picture: image, title, ...(block.path ? { path: block.path } : {}) },
    0,
    fitted.rows + 1,
  );
  const indent = " ".repeat(IMAGE_INDENT);
  const caption = truncate(`${indent}${style.muted(`${title} · ${size}`)}`, context.width);
  return [...pictureRows(image, fitted, indent), caption];
}

/** What the user chose: a mark for how it went, what was asked, and the answer. */
function decisionRows(block: Extract<Block, { kind: "decision" }>, width: number): string[] {
  const mark =
    block.outcome === "allowed"
      ? style.added("✓")
      : block.outcome === "declined"
        ? style.removed("✗")
        : block.outcome === "dismissed"
          ? style.muted("–")
          : style.strong("◆");
  const answer =
    block.outcome === "dismissed"
      ? style.muted("dismissed")
      : style.text(oneLineText(block.answer));
  const title = oneLineText(block.title);
  return wrap(`${mark} ${style.soft(title)} ${style.muted("→")} ${answer}`, width, "  ");
}

function userRows(block: Extract<Block, { kind: "user" }>, context: RenderContext): string[] {
  const { width } = context;
  // In its own color, so what you sent stands apart from what agents wrote.
  const marker = `${style.prompt("┃")} `;
  const lines = plainText(block.text).replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, USER_LINES);
  const rows = block.label ? [truncate(marker + style.muted(block.label), width)] : [];
  rows.push(...shown.flatMap((line) => wrap(marker + style.bold(line), width, marker)));
  if (lines.length > shown.length)
    rows.push(truncate(marker + style.muted(`… ${lines.length - shown.length} more lines`), width));
  // Images sent with the message, small, under it; their names where they cannot show.
  for (const path of block.images ?? []) {
    const name = fileName(path);
    const shownImage = context.media?.graphics ? context.image?.(path) : undefined;
    if (shownImage && context.media) {
      const media = { ...context.media, maxRows: Math.min(context.media.maxRows, THUMBNAIL_ROWS) };
      const size = fit(shownImage, width - 2, media);
      context.collect?.({ picture: shownImage, ...size });
      context.mark?.(
        { kind: "picture", picture: shownImage, title: name, path },
        rows.length,
        rows.length + size.rows,
      );
      rows.push(...pictureRows(shownImage, size, marker));
    }
    rows.push(truncate(`${marker}${style.muted(`▣ ${oneLineText(name)}`)}`, width));
  }
  return rows;
}

/** The most rows an image sent with a message takes, as a thumbnail. */
const THUMBNAIL_ROWS = 12;

/** Who a result is from and how the task ended, over its first line. */
function resultRows(block: Extract<Block, { kind: "result" }>, context: RenderContext): string[] {
  const { width } = context;
  // The agent by what it was doing, where the client knows its title.
  const from = oneLineText(context.threadTitle?.(block.from) || block.from);
  const head = `${statusDot(block.status)} ${style.text(`Result from ${from}`)}`;
  const rows = [truncate(`${head} ${style.muted("·")} ${paintStatus(block.status)}`, width)];
  const line = plainLine(block.text);
  if (line) rows.push(truncate(`  ${style.muted(line)}`, width));
  return rows;
}

/** A failed tool call in one line: what ran, and how it ended where the output says. */
export function failureText(item: ToolItem): string {
  const lines = "output" in item ? plainText(item.output).trim().split("\n") : [];
  const last = oneLineText(lines.at(-1) ?? "");
  // The count a test runner ends on says how many; this says which.
  const named = lines.find((line) => /^\s*(?:✖|✗|×|FAIL\b|not ok\b)/.test(line))?.trim();
  const first = named && named !== lines.at(-1)?.trim() ? ` · first: ${oneLineText(named)}` : "";
  const what =
    item.kind === "command"
      ? `${oneLineText(item.command)}${item.exitCode ? ` · exit ${item.exitCode}` : ""}`
      : item.kind === "tool_call"
        ? toolName(item)
        : item.kind === "file_change"
          ? "File change"
          : item.kind === "web_search"
            ? "Web search"
            : "Tool call";
  return last ? `${what}: ${last}${first}` : what;
}

function noticeRows(block: Extract<Block, { kind: "notice" }>, width: number): string[] {
  const paint = block.level === "error" ? style.removed : style.attention;
  const label = block.level === "error" ? "Error " : block.level === "warning" ? "Warning " : "";
  return plainText(block.text)
    .replace(/\s+$/, "")
    .split("\n")
    .flatMap((line, index) =>
      wrap(
        // A command to run stands out from the words around it.
        `  ${index === 0 && label ? style.bold(paint(label)) : ""}${(line.startsWith("$ ") ? style.bold : style.soft)(line)}`,
        width,
        "  ",
      ),
    );
}

const TONES: Record<ReportSpan["tone"], (text: string) => string> = {
  strong: (text) => style.bold(style.strong(text)),
  text: style.text,
  soft: style.soft,
  muted: style.muted,
  good: style.added,
  bad: style.removed,
};

/** A long last span, such as a list of tools, wraps under where it starts. */
function reportRows(block: Extract<Block, { kind: "report" }>, width: number): string[] {
  const rows = [truncate(`${style.strong("●")} ${style.text(oneLineText(block.title))}`, width)];
  for (const spans of block.lines) {
    if (spans.length === 0) {
      rows.push("");
      continue;
    }
    // A span can carry a harness's own text, such as a server's error.
    // Spans pad their columns with spaces, which stay; line breaks become spaces.
    const clean = spans.map((span) => ({
      ...span,
      text: plainText(span.text).replace(/\n/g, " "),
    }));
    const head = clean.slice(0, -1);
    const last = clean.at(-1);
    const lead = `  ${head.map((span) => TONES[span.tone](span.text)).join("")}`;
    const hang = " ".repeat(2 + visibleWidth(head.map((span) => span.text).join("")));
    rows.push(...wrap(lead + (last ? TONES[last.tone](last.text) : ""), width, hang));
  }
  return rows;
}

function todoRows(steps: readonly TodoStep[], width: number): string[] {
  const done = steps.filter((step) => step.status === "completed").length;
  const rows = [
    truncate(
      `${style.strong("●")} ${style.muted(`Todos · ${done} of ${steps.length} done`)}`,
      width,
    ),
  ];
  steps.forEach((step, index) => {
    const branch = style.muted(index === steps.length - 1 ? "└ " : "├ ");
    const label = oneLineText(step.text);
    const text =
      step.status === "completed"
        ? style.muted(`✓ ${label}`)
        : step.status === "in_progress"
          ? style.bold(style.strong(`▪ ${label}`))
          : style.text(`○ ${label}`);
    rows.push(truncate(branch + text, width));
  });
  return rows;
}

// Tool groups

type Category = "edit" | "command" | "read" | "search" | "web" | "fetch" | "agent" | "other";

function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/** What a group did, a phrase per category, most telling first. */
const PHRASES: Record<Category, (count: number) => string> = {
  edit: (count) => `changed ${plural(count, "file")}`,
  command: (count) => `ran ${plural(count, "command")}`,
  read: (count) => `read ${plural(count, "file")}`,
  search: (count) => `searched code ${times(count)}`,
  web: (count) => `searched the web ${times(count)}`,
  fetch: (count) => `fetched ${plural(count, "page")}`,
  agent: (count) => `started ${plural(count, "agent")}`,
  other: (count) => `used ${plural(count, "tool")}`,
};

/** The parsed actions of a command that only reads, lists, or searches; null otherwise. */
function exploration(item: ToolItem): CommandAction[] | null {
  if (item.kind !== "command" || !item.actions?.length) return null;
  return item.actions.every((action) => action.type !== "other") ? item.actions : null;
}

function category(item: ToolItem): Category {
  switch (item.kind) {
    case "command": {
      const actions = exploration(item);
      if (!actions) return "command";
      return actions.every((action) => action.type === "read") ? "read" : "search";
    }
    case "file_change":
      return "edit";
    case "web_search":
      return "web";
    case "agent":
      return "agent";
    case "tool_call":
      return item.category;
  }
}

/** One sentence for a group: its top two phrases, and a count of the rest. */
export function groupSummary(items: readonly ToolItem[]): string {
  const counts = new Map<Category, number>();
  // The sentence counts files changed, however many edits it took.
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind === "file_change") {
      for (const change of item.changes) files.add(change.path);
      counts.set("edit", files.size);
    } else counts.set(category(item), (counts.get(category(item)) ?? 0) + 1);
  }
  const present = (Object.keys(PHRASES) as Category[]).filter((name) => counts.has(name));
  const phrases = present.slice(0, 3).map((name) => PHRASES[name](counts.get(name) ?? 0));
  const rest = present.slice(3).reduce((sum, name) => sum + (counts.get(name) ?? 0), 0);
  if (rest > 0) phrases.push(`performed ${plural(rest, "other action")}`);
  const sentence =
    phrases.length <= 2
      ? phrases.join(" and ")
      : `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
  const failed = items.filter((item) => item.status === "failed").length;
  const capital = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return failed > 0 ? `${capital} · ${failed} failed` : capital;
}

/** A group of one is a single row; more get a sentence over a tree. */
function toolRows(block: Extract<Block, { kind: "tools" }>, context: RenderContext): string[] {
  const { items } = block;
  // A group whose only calls started agents shows nothing; the agents' rows show them.
  if (items.length === 0) return [];
  const running = isRunningGroup(block);
  const marker = running && !context.blink ? " " : style.strong("●");
  const waiting = (item: ToolItem) => block.awaiting?.includes(item.id) ?? false;
  const settled = (item: ToolItem) => block.settled || (block.cut?.includes(item.id) ?? false);
  const line = (item: ToolItem) => toolLine(item, settled(item), context.cwd, waiting(item));
  const [only] = items;
  // A long command is otherwise a silent row, with no sign whether it is getting anywhere.
  const tail = (item: ToolItem, hang: string): string[] => {
    if (item.kind !== "command" || item.status !== "running" || settled(item)) return [];
    const last = plainText(item.output).trimEnd().split("\n").at(-1)?.trim();
    if (!last) return [];
    // A failure scrolling by is the one line here worth stopping the eye.
    const paint = /✖|✗|\b(?:fail(?:ed|ure)?|error)\b/i.test(last) ? style.removed : style.muted;
    return [truncate(`${hang}${paint(last)}`, context.width)];
  };
  if (only && items.length === 1) {
    if (context.details) return detailedItem(only, `${marker} `, "  ", context, line(only));
    return [truncate(`${marker} ${line(only)}`, context.width), ...tail(only, "  ")];
  }
  // What is still running has its own row, so it is not told as already done.
  const finished = running ? items.filter((item) => item.status !== "running") : items;
  const heading = finished.length > 0 ? groupSummary(finished) : `Running ${items.length} calls`;
  const rows = [truncate(`${marker} ${style.muted(heading)}`, context.width)];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    const branch = style.muted(last ? "└ " : "├ ");
    if (context.details)
      rows.push(
        ...detailedItem(item, branch, style.muted(last ? "  " : "│ "), context, line(item)),
      );
    else
      rows.push(
        truncate(branch + line(item), context.width),
        ...tail(item, style.muted(last ? "  " : "│ ")),
      );
  });
  return rows;
}

/** Output lines shown under a tool call in detail, from its end. */
const DETAIL_OUTPUT_LINES = 20;
/** Diff lines shown per edit in detail. */
const DETAIL_DIFF_LINES = 40;

/**
 * A tool call in detail: its whole first row wrapped, then its full command,
 * its output's last lines, or its diffs, under `hang`.
 */
function detailedItem(
  item: ToolItem,
  lead: string,
  hang: string,
  context: RenderContext,
  line: string,
): string[] {
  const { width } = context;
  const body: string[] = [];
  const tail = (text: string, limit: number, paint: (line: string) => string) => {
    const lines = outputText(text).replace(/\s+$/, "").split("\n");
    if (lines.length === 1 && lines[0] === "") return;
    if (lines.length > limit) body.push(style.muted(`… ${lines.length - limit} earlier lines`));
    for (const kept of lines.slice(-limit)) body.push(paint(kept));
  };
  switch (item.kind) {
    case "command": {
      // The row shows the command's first line, wrapped; its other lines follow.
      for (const text of plainText(item.command).trim().split("\n").slice(1))
        body.push(style.soft(text));
      tail(item.output, DETAIL_OUTPUT_LINES, style.muted);
      break;
    }
    case "file_change":
      for (const change of item.changes) {
        if (item.changes.length > 1) body.push(style.text(shownPath(change.path, context.cwd)));
        const lines = diffBody(plainText(change.diff).split("\n"));
        for (const text of lines.slice(0, DETAIL_DIFF_LINES))
          body.push(diffLine(text, style.muted));
        if (lines.length > DETAIL_DIFF_LINES)
          body.push(style.muted(`… ${lines.length - DETAIL_DIFF_LINES} more lines`));
      }
      break;
    case "tool_call":
      tail(item.output, DETAIL_OUTPUT_LINES, style.muted);
      break;
    case "agent":
      tail(item.summary, DETAIL_OUTPUT_LINES, style.muted);
      break;
    case "web_search":
      break;
  }
  const rows = wrap(lead + line, width, hang, true);
  for (const text of body) rows.push(...wrap(`${hang}${text}`, width, hang, true));
  return rows;
}

/** Colors a shell command the way fx does: programs and operators brighter, flags softer. */
function highlightCommand(command: string): string {
  const [head = "", ...rest] = plainText(command).trim().split("\n");
  const more = rest.length > 0 ? style.muted(" …") : "";
  let expectProgram = true;
  const tokens = head.split(/(\s+)/);
  return (
    tokens
      .map((token) => {
        if (token === "" || /^\s+$/.test(token)) return token;
        if (/^(&&|\|\||\||;|&)$/.test(token)) {
          expectProgram = true;
          return style.text(token);
        }
        if (expectProgram && !/^\w+=/.test(token)) {
          expectProgram = false;
          return style.text(token);
        }
        if (token.startsWith("-")) return style.soft(token);
        return style.muted(token);
      })
      .join("") + more
  );
}

/** Lines a change adds and removes, past its diff's header. */
export function changeCounts(change: FileChange): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffBody(change.diff.split("\n"))) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function diffCounts(changes: readonly FileChange[]): string {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const counts = changeCounts(change);
    added += counts.added;
    removed += counts.removed;
  }
  if (added === 0 && removed === 0) return "";
  if (removed === 0) return ` +${added}`;
  return ` +${added} / -${removed}`;
}

/** 1harness's own tools, in words: what each did, is doing, and the action itself. */
const OWN_TOOLS: Record<string, [string, string, string]> = {
  orchestrator_capabilities: [
    "Checked which harnesses can take tasks",
    "Checking which harnesses can take tasks",
    "checking harnesses",
  ],
  delegate_task: ["Handed off a task", "Handing off a task", "handing off a task"],
  tool_search: ["Looked for a tool", "Looking for a tool", "looking for a tool"],
  task_status: ["Checked on a task", "Checking on a task", "checking on a task"],
  task_cancel: ["Cancelled a task", "Cancelling a task", "cancelling a task"],
  thread_list: ["Listed threads", "Listing threads", "listing threads"],
  thread_read: ["Read a thread", "Reading a thread", "reading a thread"],
  thread_send: ["Messaged a thread", "Messaging a thread", "messaging a thread"],
  thread_wait: ["Waited for a thread", "Waiting for a thread", "waiting for a thread"],
  thread_interrupt: ["Interrupted a thread", "Interrupting a thread", "interrupting a thread"],
};

/**
 * The thread or task one of 1harness's own tools acts on, from its input,
 * such as ` t13`; its input itself is JSON, which says nothing more here.
 */
function ownTarget(summary: string): string {
  try {
    const input = JSON.parse(summary) as Record<string, unknown>;
    const target = input["threadId"] ?? input["taskId"];
    return typeof target === "string" ? ` ${oneLineText(target)}` : "";
  } catch {
    return "";
  }
}

/** A tool call's name, with its server's but for 1harness's own, which adds nothing. */
function toolName(item: Extract<ToolItem, { kind: "tool_call" }>): string {
  return oneLineText(
    item.server && item.server !== "1harness" ? `${item.server}/${item.tool}` : item.tool,
  );
}

/** What a file change acts on: its one file, or how many. */
function changeTarget(changes: readonly FileChange[], cwd: string): string {
  const [change] = changes;
  return changes.length === 1 && change ? shownPath(change.path, cwd) : `${changes.length} files`;
}

function asks(what: string): string {
  return `${style.attention("Asks to")} ${what}`;
}

/** What a tool call waiting for approval asks to do. */
function asking(item: ToolItem, cwd: string): string {
  switch (item.kind) {
    case "command":
      return asks(`${style.muted("run")} ${highlightCommand(item.command)}`);
    case "file_change": {
      const [change] = item.changes;
      const target = changeTarget(item.changes, cwd);
      const verb = change?.kind === "add" ? "write" : change?.kind === "delete" ? "delete" : "edit";
      return asks(style.muted(`${verb} ${target}${diffCounts(item.changes)}`));
    }
    case "tool_call": {
      const name = toolName(item);
      const target = item.summary ? ` ${shownPath(item.summary, cwd)}` : "";
      return asks(style.muted(`use ${name}${target}`));
    }
    case "web_search":
      return asks(style.muted(`search the web for ${oneLineText(item.query)}`));
    case "agent":
      return asks(style.muted(`start an agent: ${oneLineText(item.description)}`));
  }
}

/** One row of a tool group: a verb in fx's tense, then the target. */
function toolLine(item: ToolItem, settled: boolean, cwd: string, waiting = false): string {
  const running = item.status === "running";
  if (waiting && running && !settled) return asking(item, cwd);
  /** Picks the verb for the item's state; `noun` names the action when it did not happen. */
  const verb = (past: string, present: string, noun: string) => {
    const prefix = running && settled ? "Stopped" : item.status === "declined" ? "Declined" : "";
    if (prefix) return noun ? `${prefix} ${noun}` : prefix;
    if (item.status === "failed") return noun ? `Failed ${noun}` : "Failed";
    return running ? present : past;
  };
  switch (item.kind) {
    case "command": {
      const actions = exploration(item);
      // Codex parses commands that only explore, and its own UI shows what they did.
      if (actions && item.status !== "failed" && item.status !== "declined") {
        const done = !running || settled;
        return style.muted(actions.map((action) => describeAction(action, done, cwd)).join(", "));
      }
      const exited = item.exitCode !== null && item.exitCode !== 0;
      const word = exited && !running ? "Ran" : verb("Ran", "Running", "");
      const exit = exited ? style.muted(` · exit ${item.exitCode}`) : "";
      // What is running now is the one row of the group to read.
      const live = running && !settled;
      const shown = live ? style.text(oneLineText(item.command)) : highlightCommand(item.command);
      return `${style.muted(`${word} `)}${shown}${exit}`;
    }
    case "file_change": {
      const [change] = item.changes;
      const kinds = new Set(item.changes.map((entry) => entry.kind));
      const kind = kinds.size === 1 ? change?.kind : "update";
      const target = changeTarget(item.changes, cwd);
      if (item.changes.length === 1 && change?.movePath) {
        const moved = `${target} → ${shownPath(change.movePath, cwd)}`;
        return style.muted(
          `${verb("Moved", "Moving", "move")} ${moved}${diffCounts(item.changes)}`,
        );
      }
      const word =
        kind === "add"
          ? verb("Wrote", "Writing", "write")
          : kind === "delete"
            ? verb("Deleted", "Deleting", "delete")
            : verb("Edited", "Editing", "edit");
      return style.muted(`${word} ${target}${diffCounts(item.changes)}`);
    }
    case "web_search":
      return style.muted(
        `${verb("Searched web", "Searching web", "web search")} ${oneLineText(item.query)}`,
      );
    case "agent": {
      // The harness's own agents: what they are doing while running, then what they found.
      const summary = item.summary ? ` · ${oneLineText(firstLine(item.summary))}` : "";
      return style.muted(
        `${verb("Agent finished", "Agent working on", "agent")} ${oneLineText(item.description)}${summary}`,
      );
    }
    case "tool_call": {
      // An extension's choice, which says what this tool did better than its name can.
      if (item.display) return style.muted(oneLineText(item.display));
      const target = item.summary ? ` ${shownPath(item.summary, cwd)}` : "";
      const failure =
        item.status === "failed" && item.output.trim() !== ""
          ? `: ${oneLineText(firstLine(item.output))}`
          : "";
      // 1harness's own tools say what they did; its server's name adds nothing.
      const own = item.server === "1harness" ? OWN_TOOLS[item.tool] : undefined;
      if (own) {
        const [past, present, noun] = own;
        return style.muted(`${verb(past, present, noun)}${ownTarget(item.summary)}${failure}`);
      }
      const name = toolName(item);
      const words: Record<Category, [string, string, string]> = {
        read: ["Read", "Reading", "read"],
        search: ["Searched", "Searching", "search"],
        fetch: ["Fetched", "Fetching", "fetch"],
        edit: [name, name, name],
        command: [name, name, name],
        web: [name, name, name],
        agent: [name, name, name],
        other: item.server ? [`Called ${name}`, `Calling ${name}`, name] : [name, name, name],
      };
      const [past, present, noun] = words[category(item)];
      return style.muted(`${verb(past, present, noun)}${target}${failure}`);
    }
  }
}

function describeAction(action: CommandAction, done: boolean, cwd: string): string {
  switch (action.type) {
    case "read":
      return `${done ? "Read" : "Reading"} ${shownPath(action.path, cwd)}`;
    case "list":
      return `${done ? "Listed" : "Listing"} ${action.path ? shownPath(action.path, cwd) : "files"}`;
    case "search": {
      const where = action.path ? ` in ${shownPath(action.path, cwd)}` : "";
      return `${done ? "Searched" : "Searching"} ${action.query ? oneLineText(action.query) : "files"}${where}`;
    }
    case "other":
      return "";
  }
}

// Agents 1harness runs

const STATUS_ORDER: readonly AgentStatus[] = [
  "needs you",
  "working",
  "starting",
  "failed",
  "stopped",
  "done",
  "idle",
];

/**
 * One agent's rows: its status dot and what it is doing, with what it runs
 * on at the right, then, where it asks for something, what.
 */
function agentRow(row: AgentRow, lead: string, hang: string, context: RenderContext): string[] {
  const title = `${lead}${style.strong(oneLineText(row.title))}`;
  // Too narrow for both, what it is doing stays and what it runs on goes.
  const fits = visibleWidth(title) + 2 + visibleWidth(row.label) <= context.width;
  const rows = [
    fits ? spread(title, style.muted(row.label), context.width) : truncate(title, context.width),
  ];
  const shown = oneLineText(row.detail);
  if (shown)
    rows.push(
      truncate(
        hang + (row.status === "needs you" ? style.attention(shown) : style.muted(shown)),
        context.width,
      ),
    );
  return rows;
}

function agentRows(block: Extract<Block, { kind: "agents" }>, context: RenderContext): string[] {
  const live = block.rows.some((row) => isLive(row.status));
  const [only] = block.rows;
  if (only && block.rows.length === 1) {
    const marker = live && !context.blink ? "  " : `${statusDot(only.status)} `;
    return agentRow(only, marker, "  ", context);
  }
  const counts = STATUS_ORDER.flatMap((status) => {
    const count = block.rows.filter((row) => row.status === status).length;
    return count > 0 ? [`${count} ${status}`] : [];
  });
  const marker = live && !context.blink ? " " : style.strong("●");
  const rows = [
    truncate(
      `${marker} ${style.muted([`${block.rows.length} agents`, ...counts].join(" · "))}`,
      context.width,
    ),
  ];
  block.rows.forEach((row, index) => {
    const last = index === block.rows.length - 1;
    const dot = isLive(row.status) && !context.blink ? "  " : `${statusDot(row.status)} `;
    rows.push(
      ...agentRow(
        row,
        `${style.muted(last ? "└ " : "├ ")}${dot}`,
        style.muted(last ? "    " : "│   "),
        context,
      ),
    );
  });
  return rows;
}
