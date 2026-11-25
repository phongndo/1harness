import type { Shown } from "./images.ts";
import { dropCells, placeholderCells } from "./images.ts";
import type { Look } from "./look.ts";
import { density } from "./look.ts";
import { escapeHtml, fitText } from "./markup.ts";
import { surfaces } from "./theme.ts";
import { plainText } from "./text.ts";
import type { Typesetter } from "./typeset.ts";

// The prompt rail: a strip for each message sent, down the margin beside the
// column, as T3 Code's timeline has. Strips of the turns in view are brighter;
// the one the mouse is over is longest, over what was asked and answered, and
// a click goes to it. All sizes are T3 Code's, in CSS pixels.

const SPACING = 8;
const LEFT = 32;
const REACH = 40;
const STRIP = { width: 24, height: 2 };
/** A strip's share of its full width by how far it is from the one under the mouse. */
const SHARE = [1, 0.667, 0.417] as const;
const REST = 0.333;
const MIN_ITEMS = 2;
const MIN_HEIGHT = 64;
/** What the rail leaves of the timeline above and below it. */
const CLEAR = 236;
const GUTTER = 48;
const CARD = { left: 64, width: 320 };
/** A strip reached above the first and below the last. */
const SLACK = 4;

/** A message sent: the row it starts at, what it says, and the reply it got. */
export interface Asked {
  row: number;
  text: string;
  reply: string;
  block?: object;
}

/** The rail as drawn on rows of the screen from `top`, cells from `column`. */
export interface RailFrame {
  top: number;
  column: number;
  columns: number;
  cells: string[];
  pictures: Shown[];
  /** The message at a row of the screen, `along` so many of the rail's columns. */
  at: (row: number, along: number) => number | null;
  /** The preview over the transcript. */
  card: { top: number; column: number; columns: number; rows: string[] } | null;
}

/** Text as one line, without Markdown's marks. */
function preview(text: string): string {
  return plainText(text.slice(0, 1500))
    .replace(/```\w*/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class Rail {
  #cards = new WeakMap<Asked, object>();
  #last = new Map<string, Asked>();

  /**
   * The rail beside a column that starts at `left`, over `room` rows showing
   * the transcript's rows from `top`; null where it has no room or too little
   * to list. `hover` is the message the mouse is over.
   */
  frame(
    look: Look,
    typeset: Typesetter | null,
    asked: readonly Asked[],
    place: { left: number; room: number; top: number; total: number; columns: number },
    hover: number | null,
    dark: boolean,
  ): RailFrame | null {
    const { cell } = look;
    const scale = density(cell);
    if (asked.length < MIN_ITEMS || place.left * cell.width < GUTTER * scale) return null;
    const pane = (place.room * cell.height) / scale;
    const natural = (asked.length - 1) * SPACING;
    const height = Math.min(natural, Math.max(MIN_HEIGHT, pane - CLEAR));
    const above = (pane - height) / 2;
    const topRow = Math.max(0, Math.floor(((above - SLACK) * scale) / cell.height));
    const endRow = Math.min(
      place.room,
      Math.ceil(((above + height + SLACK) * scale) / cell.height),
    );
    const column = Math.floor((LEFT * scale) / cell.width);
    const reach = Math.min(REACH, (place.left * cell.width) / scale - LEFT);
    const columns = Math.max(
      1,
      Math.min(place.left - column, Math.ceil(((LEFT + reach) * scale) / cell.width) - column),
    );
    const rows = endRow - topRow;
    if (rows < 1) return null;
    const active = hover !== null && hover < asked.length ? hover : null;
    const seen = asked.map((item, index) => {
      const next = asked[index + 1]?.row ?? place.total;
      return item.row < place.top + place.room && next > place.top;
    });
    const step = asked.length > 1 ? height / (asked.length - 1) : 0;
    const { muted, strong } = surfaces();
    const key = `rail:${columns}x${rows}:${height}:${above}:${active}:${seen.map(Number).join("")}:${muted}`;
    const shown = look.tile(key, columns, rows, () =>
      asked
        .map((_, index) => {
          const share = active === null ? REST : (SHARE[Math.abs(index - active)] ?? REST);
          // A tile is drawn in CSS pixels.
          const x = LEFT - (column * cell.width) / scale;
          const y = above + index * step - STRIP.height / 2 - (topRow * cell.height) / scale;
          const strip = (color: string, opacity: number) =>
            `<rect x="${x}" y="${y}" width="${STRIP.width * share}" height="${STRIP.height}" rx="1" fill="${color}" fill-opacity="${opacity}"/>`;
          return (
            strip(muted, index === active ? 0.6 : 0.25) + (seen[index] ? strip(strong, 0.55) : "")
          );
        })
        .join(""),
    );
    const pictures = [shown];
    let card: RailFrame["card"] = null;
    const item = active === null ? undefined : asked[active];
    if (item && active !== null && typeset) {
      // Over the column, or up to it: the margin under it is blank, but for the rail's strips.
      const left = Math.max(
        column + columns,
        Math.min(place.left, Math.round((CARD.left * scale) / cell.width)),
      );
      const wide = Math.min(
        Math.round((CARD.width * scale) / cell.width),
        place.left + place.columns - left,
      );
      const drawn = typeset.sheet(
        this.#owner(item),
        [cardHtml(item, (wide * cell.width) / scale)],
        wide,
        cell,
        dark,
      );
      if (drawn && drawn !== "pending") {
        const { sheet } = drawn;
        pictures.push(...sheet.pictures);
        const middle = ((above + active * step) * scale) / cell.height;
        const at = Math.round(middle - sheet.height / 2);
        card = {
          top: Math.max(0, Math.min(place.room - sheet.rows.length, at)),
          column: left,
          columns: wide,
          rows: sheet.rows.slice(0, place.room),
        };
      }
    }
    return {
      top: topRow,
      column,
      columns,
      cells: Array.from({ length: rows }, (_, row) =>
        placeholderCells(shown.picture, row, 0, columns),
      ),
      pictures,
      at: (row, along) => {
        if (row < topRow || row >= endRow) return null;
        const top = (row * cell.height) / scale - above;
        const tall = cell.height / scale;
        const on = asked.flatMap((_, index) =>
          index * step >= top && index * step < top + tall ? [index] : [],
        );
        // Strips closer than rows share one: across it, from the first of them to the last.
        const pick = on[Math.min(on.length - 1, Math.floor((along / columns) * on.length))];
        if (pick !== undefined) return pick;
        const near = step > 0 ? (top + tall / 2) / step : 0;
        return Math.max(0, Math.min(asked.length - 1, Math.round(near)));
      },
      card,
    };
  }

  /** What a message's card is kept by, the same one while it says the same. */
  #owner(item: Asked): object {
    const key = `${item.row}\0${item.text}`;
    const known = this.#last.get(key) ?? item;
    if (this.#last.size > 64) this.#last.clear();
    this.#last.set(key, known);
    let owner = this.#cards.get(known);
    if (!owner) this.#cards.set(known, (owner = {}));
    return owner;
  }
}

/** What was asked, over the first lines of the reply to it, in a card `width` CSS pixels wide. */
function cardHtml(item: Asked, width: number): string {
  const colors = surfaces();
  const room = width - 26;
  const asked = fitText(preview(item.text) || "User message", 14.3, room);
  const reply = fitText(preview(item.reply), 14, room * 2.6);
  return (
    `<div style="background:${colors.menu};border:1px solid ${colors.menuBorder};border-radius:12px;padding:12px;line-height:20px">` +
    `<div style="font-weight:500;color:${colors.strong};white-space:nowrap;overflow:hidden">${escapeHtml(asked)}</div>` +
    (reply
      ? `<div style="margin-top:4px;color:${colors.muted};max-height:60px;overflow:hidden">${escapeHtml(reply)}</div>`
      : "") +
    "</div>"
  );
}

/** What is beside a screen row, as wide as the margin; null where the rail's card lies over both. */
export function marginOf(at: number, left: number, rail: RailFrame | null): string | null {
  if (rail?.card?.rows[at - rail.card.top] !== undefined) return null;
  const strip = rail?.cells[at - rail.top];
  return rail && strip
    ? " ".repeat(rail.column) + strip + " ".repeat(left - rail.column - rail.columns)
    : " ".repeat(left);
}

/** A screen row: the transcript's after its margin, beside the rail and under its card. */
export function beside(row: string, at: number, left: number, rail: RailFrame | null): string {
  const margin = marginOf(at, left, rail);
  if (margin !== null) return row === "" && margin.trim() === "" ? row : margin + row;
  const { card, column, columns, cells, top } = rail!;
  const strip = cells[at - top];
  const lead = strip
    ? " ".repeat(column) + strip + " ".repeat(Math.max(0, card!.column - column - columns))
    : " ".repeat(card!.column);
  const rest = dropCells(" ".repeat(left) + row, card!.column + card!.columns);
  return lead + (card!.rows[at - card!.top] ?? "") + rest;
}
