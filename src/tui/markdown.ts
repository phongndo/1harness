import { stripVTControlCharacters } from "node:util";
import { fenceFigure, type Figure } from "./figures.ts";
import { texLines, texToUnicode } from "./math.ts";
import { style } from "./theme.ts";
import { plainText, visibleWidth, wrap } from "./text.ts";

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue def default defer delete do elif else " +
    "enum export extends false finally fn for from func function go if impl import in interface " +
    "let loop match mod mut new nil none null of package pub raise return self static struct " +
    "super switch this throw true try type typeof use var void where while with yield"
  ).split(" "),
);
const HASH_COMMENTS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "shell",
  "python",
  "py",
  "ruby",
  "rb",
  "yaml",
  "yml",
  "toml",
  "nix",
  "make",
  "makefile",
  "dockerfile",
  "r",
  "perl",
]);
const TOKEN =
  /(\/\/.*$|#.*$|--.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)/gi;

/** Light syntax coloring in fx's grays: keywords brighter, literals softer, comments muted. */
function highlight(line: string, lang: string): string {
  const language = lang.toLowerCase();
  if (language === "diff" || language === "patch") {
    if (line.startsWith("+") && !line.startsWith("+++")) return style.added(line);
    if (line.startsWith("-") && !line.startsWith("---")) return style.removed(line);
    if (line.startsWith("@@")) return style.muted(line);
    return line;
  }
  if (language === "" || language === "text" || language === "txt") return line;
  const hashComments = HASH_COMMENTS.has(language);
  const dashComments = language === "sql" || language === "lua" || language === "haskell";
  return line.replace(
    TOKEN,
    (match, comment: string, literal: string, number: string, word: string) => {
      if (comment) {
        const isComment = comment.startsWith("//")
          ? !hashComments
          : comment.startsWith("#")
            ? hashComments
            : dashComments;
        return isComment ? style.muted(comment) : highlightRest(comment, language);
      }
      if (literal || number) return style.soft(match);
      if (word && KEYWORDS.has(word)) return style.text(word);
      return match;
    },
  );
}

/** Highlights text that looked like a comment opener but is not one in this language. */
function highlightRest(text: string, language: string): string {
  return text.charAt(0) + highlight(text.slice(1), language);
}

/** Sets text aside behind a placeholder, as `held` keeps it, for `put` to bring back. */
function holder(): { hold: (text: string) => string; put: (text: string) => string } {
  const kept: string[] = [];
  return {
    hold: (text) => {
      kept.push(text);
      return `${kept.length - 1}`;
    },
    put: (text) => text.replace(/(\d+)/g, (_, index: string) => kept[Number(index)] ?? ""),
  };
}

/** Whether a character is whitespace, or the start or end of the text. */
function isBlank(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function punctuation(char: string | undefined): boolean {
  return char !== undefined && /[\p{P}\p{S}]/u.test(char);
}

/**
 * Emphasis marked with `marker`, as CommonMark reads it: an opener comes
 * before text and a closer after it, a marker by punctuation counts only
 * beside space or punctuation, and `_` never opens or closes inside a word.
 */
function emphasis(text: string, marker: string, paint: (body: string) => string): string {
  // Most text has none of a marker; reading it a character at a time would find none.
  if (!text.includes(marker)) return text;
  const size = marker.length;
  const at = (index: number) => text.startsWith(marker, index);
  // A marker that is part of a longer run of its character is not this marker.
  const lone = (index: number) =>
    at(index) && text[index - 1] !== marker[0] && text[index + size] !== marker[0];
  const left = (index: number) => {
    const before = text[index - 1];
    const after = text[index + size];
    return !isBlank(after) && (!punctuation(after) || isBlank(before) || punctuation(before));
  };
  const right = (index: number) => {
    const before = text[index - 1];
    const after = text[index + size];
    return !isBlank(before) && (!punctuation(before) || isBlank(after) || punctuation(after));
  };
  const word = marker[0] === "_";
  const opens = (index: number) =>
    lone(index) && left(index) && (!word || !right(index) || punctuation(text[index - 1]));
  const closes = (index: number) =>
    lone(index) && right(index) && (!word || !left(index) || punctuation(text[index + size]));
  // Each closer takes the nearest opener before it, as CommonMark's delimiter stack does.
  const openers: number[] = [];
  const pairs: [number, number][] = [];
  for (let index = 0; index < text.length;) {
    if (openers.length > 0 && closes(index)) {
      pairs.push([openers.pop() ?? 0, index]);
      index += size;
    } else if (opens(index)) {
      openers.push(index);
      index += size;
    } else index++;
  }
  // The outermost pairs are painted; what they hold is read again inside them.
  pairs.sort((a, b) => a[0] - b[0]);
  let out = "";
  let from = 0;
  for (const [open, close] of pairs) {
    if (open < from) continue;
    out += text.slice(from, open) + paint(text.slice(open + size, close));
    from = close + size;
  }
  return out + text.slice(from);
}

/** Bold, italics, and strikethrough, outermost markers first. */
function emphasize(text: string): string {
  let out = emphasis(text, "***", (body) => style.bold(style.italic(emphasize(body))));
  out = emphasis(out, "**", (body) => style.bold(emphasize(body)));
  out = emphasis(out, "__", (body) => style.bold(emphasize(body)));
  out = emphasis(out, "*", (body) => style.italic(emphasis(body, "*", style.italic)));
  out = emphasis(out, "_", (body) => style.italic(body));
  return emphasis(out, "~~", (body) => style.strike(body));
}

/** Inline Markdown: code spans, emphasis, and links. */
export function inline(text: string): string {
  // Set aside first, so nothing else reads them: code spans, kept as written,
  // backslashes and all; then escaped characters, literal; then links, whose
  // URLs are not emphasis. A backtick after a backslash or in a longer run
  // opens no code span. Placeholders are private-use characters, which the
  // text itself gives up.
  const { hold, put } = holder();
  const held = text
    .replace(/[]/g, "�")
    .replace(/(?<![\\`])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, body: string) =>
      hold(style.strong(body)),
    )
    // Math reads as Unicode text: `\(…\)`, `$$…$$` within a line, and `$…$` as
    // Pandoc reads it, so `$5 and $10` stay prices: its dollars hug the TeX,
    // and the closing one has no digit or letter after it.
    .replace(
      /\\\((.+?)\\\)|(?<![\\$])\$\$(?!\s)(.+?)(?<!\s)\$\$|(?<![\\$\w])\$(?![\s$])((?:[^$\\]|\\.)+?)(?<![\s\\])\$(?![\w$])/g,
      (_, paren?: string, double?: string, single?: string) =>
        hold(texToUnicode(paren ?? double ?? single ?? "")),
    )
    .replace(/\\([\\`*_~[\]()#|<>!$-])/g, (_, char: string) => hold(char))
    // An image within a line is its description; one on a line of its own is drawn.
    .replace(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, alt: string) =>
      hold(style.muted(`▣ ${put(alt) || "image"}`)),
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      hold(
        label === url
          ? style.link(put(url))
          : `${style.link(emphasize(put(label)))} ${style.muted(`(${put(url)})`)}`,
      ),
    );
  return put(emphasize(held));
}

function rule(width: number, label = ""): string {
  const head = label ? `─ ${label} ` : "";
  return style.faint(head + "─".repeat(Math.max(0, width - visibleWidth(head))));
}

type Align = "left" | "center" | "right";

/** A table row's cells: split at pipes outside code spans, with `\|` as a literal pipe. */
function tableCells(line: string): string[] {
  const body = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let code = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char === "\\" && body[index + 1] === "|") {
      cell += "|";
      index++;
      continue;
    }
    if (char === "\\" && body[index + 1] === "`") {
      cell += "\\`";
      index++;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (body[index + run] === "`") run++;
      const ticks = "`".repeat(run);
      // A code span closes on a run of the same length; a run with none later is literal.
      if (code === run) code = 0;
      else if (code === 0 && new RegExp(`(?<!\`)${ticks}(?!\`)`).test(body.slice(index + run)))
        code = run;
      cell += ticks;
      index += run - 1;
      continue;
    }
    if (char === "|" && code === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** The alignments a table's divider row sets, or null when the row is not a divider. */
function divider(line: string): Align[] | null {
  const cells = tableCells(line);
  if (!cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
  );
}

function place(text: string, width: number, align: Align): string {
  const missing = Math.max(0, width - visibleWidth(text));
  if (align === "right") return " ".repeat(missing) + text;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + text + " ".repeat(missing - left);
  }
  return text + " ".repeat(missing);
}

/**
 * Column widths that fit `room`: columns narrower than an even share keep
 * their width, and the rest split what is left in proportion to theirs.
 */
function fitColumns(natural: number[], room: number): number[] {
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= room) return natural;
  const widths = [...natural];
  let open = natural.map((_, index) => index);
  let left = room;
  for (;;) {
    const share = left / open.length;
    const fits = open.filter((index) => (natural[index] ?? 0) <= share);
    if (fits.length === 0) break;
    for (const index of fits) left -= natural[index] ?? 0;
    open = open.filter((index) => !fits.includes(index));
    if (open.length === 0) return widths;
  }
  // The columns too wide for a share split what is left evenly, a column at least.
  const share = Math.max(1, Math.floor(left / open.length));
  let spare = Math.max(0, left - share * open.length);
  for (const index of open) {
    widths[index] = share + (spare > 0 ? 1 : 0);
    spare--;
  }
  return widths;
}

/** A table too wide for columns: each row as `Header: value` lines, a blank line between rows. */
function tableRecords(rows: string[][], width: number, indent: string): string[] {
  const [header = [], ...body] = rows;
  const out: string[] = [];
  body.forEach((cells, row) => {
    if (row > 0) out.push("");
    cells.forEach((cell, column) => {
      const name = header[column] ?? "";
      out.push(
        ...wrap(`${indent}${style.bold(name)}${name ? ": " : ""}${cell}`, width, `${indent}  `),
      );
    });
  });
  return out;
}

/**
 * A Markdown table as aligned columns under a bold header, with cells
 * wrapped inside their column when the table is wider than the screen.
 */
function renderTable(lines: string[], aligns: Align[], width: number, indent: string): string[] {
  const rows = lines.map((line) => tableCells(line).map((cell) => inline(cell)));
  const columns = Math.max(aligns.length, ...rows.map((cells) => cells.length));
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(1, ...rows.map((cells) => visibleWidth(cells[column] ?? ""))),
  );
  const gap = style.faint(" │ ");
  const room = width - visibleWidth(indent) - (columns - 1) * 3;
  // Too narrow for columns of a few characters, each row goes as lines of header and value.
  if (room < columns * 3 && rows.length > 1) return tableRecords(rows, width, indent);
  const widths = fitColumns(natural, room);
  // So too when a column would split its words, up to ten characters long, mid-word.
  const longest = Array.from({ length: columns }, (_, column) =>
    Math.max(
      0,
      ...rows.flatMap((cells) =>
        stripVTControlCharacters(cells[column] ?? "")
          .split(/\s+/)
          .map((word) => visibleWidth(word)),
      ),
    ),
  );
  const splits = widths.some((size, column) => size < Math.min(longest[column] ?? 0, 10));
  if (splits && rows.length > 1) return tableRecords(rows, width, indent);
  const out: string[] = [];
  rows.forEach((cells, row) => {
    const wrapped = widths.map((columnWidth, column) => {
      const text = cells[column] ?? "";
      return wrap(row === 0 ? style.bold(text) : text, columnWidth);
    });
    const height = Math.max(...wrapped.map((parts) => parts.length));
    for (let line = 0; line < height; line++)
      out.push(
        indent +
          wrapped
            .map((parts, column) =>
              place(parts[line] ?? "", widths[column] ?? 1, aligns[column] ?? "left"),
            )
            .join(gap)
            .trimEnd(),
      );
    if (row === 0)
      out.push(indent + style.faint(widths.map((size) => "─".repeat(size)).join("─┼─")));
  });
  return out;
}

/** A code block, a figure, or an image, by the rows it takes, from `start` to before `end`. */
export type MarkdownRegion =
  | { kind: "code"; start: number; end: number; code: string; lang: string }
  | { kind: "figure"; start: number; end: number; figure: Figure }
  | { kind: "image"; start: number; end: number; src: string; alt: string };

/** What Markdown hands to whoever shows it, to draw as its own rows. */
export interface MarkdownOptions {
  /**
   * The rows for a figure (a diagram, an equation) `columns` wide, without
   * the indent, or null to show its source: a diagram's as code, an
   * equation's as Unicode text.
   */
  figure?: (figure: Figure, columns: number) => string[] | null;
  /** The rows for an image on a line of its own, without the indent; null for its description. */
  image?: (src: string, alt: string, columns: number) => string[] | null;
  /** Told where each code block, figure, and image is, so a click on one can copy or enlarge it. */
  region?: (region: MarkdownRegion) => void;
  /**
   * Told of each blank line between blocks, by its index among the lines and
   * the rows before what follows it: nothing after it changes what came
   * before, so the text after it renders alone the same.
   */
  settled?: (line: number, rows: number) => void;
}

/** A display's delimiters: `$$…$$` and `\[…\]`. */
const DISPLAYS: [string, string][] = [
  ["$$", "$$"],
  ["\\[", "\\]"],
];

/**
 * A line's text before the display's `close` that ends it, and any
 * punctuation after the closer, which goes inside, as TeX sets it: `\].`
 * reads as `.\]`. Null when the line does not end the display.
 */
function closing(line: string, close: string): [string, string] | null {
  const trimmed = line.trimEnd();
  const tail = /[.,;:!?]*$/.exec(trimmed)?.[0] ?? "";
  const body = trimmed.slice(0, trimmed.length - tail.length);
  return body.endsWith(close) ? [body.slice(0, -close.length), tail] : null;
}

/**
 * The display math starting at line `index`: its TeX, the last line it
 * takes, and whether its closer has come, which it has not while it
 * streams; null when the line opens none.
 */
function displayMath(
  lines: string[],
  index: number,
): { tex: string; end: number; closed: boolean } | null {
  const first = (lines[index] ?? "").trim();
  const pair = DISPLAYS.find(([open]) => first.startsWith(open));
  if (!pair) return null;
  const [open, close] = pair;
  const rest = first.slice(open.length);
  // All on one line: `$$ x $$`.
  const oneLine = rest.trim().length >= close.length ? closing(rest, close) : null;
  if (oneLine !== null) {
    const tex = oneLine[0].trim();
    // `$$5 and $$10` is no display; a display's line holds only the display.
    return tex.includes(open) ? null : { tex: tex + oneLine[1], end: index, closed: true };
  }
  const body = [rest];
  for (let at = index + 1; at < lines.length; at++) {
    const line = (lines[at] ?? "").trimEnd();
    const last = closing(line, close);
    if (last !== null) {
      body.push(last[0]);
      return { tex: body.join("\n").trim() + last[1], end: at, closed: true };
    }
    // A blank line ends the paragraph a display can be in; this one never closed.
    if (line.trim() === "") return { tex: body.join("\n").trim(), end: at - 1, closed: false };
    body.push(line);
  }
  return { tex: body.join("\n").trim(), end: lines.length - 1, closed: false };
}

/** An image on a line of its own: `![alt](src)`, with an optional title. */
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/;

/**
 * Renders Markdown the way fx prints assistant replies: indented prose, faint
 * list markers and code rules, bold headings, and code in its own grays.
 * Diagrams, display math, and images on lines of their own are drawn by
 * `options` where it can. Returns rows already wrapped to `width`.
 */
export function renderMarkdown(
  text: string,
  width: number,
  indent = "  ",
  options: MarkdownOptions = {},
): string[] {
  const rows: string[] = [];
  const inner = Math.max(10, width - visibleWidth(indent));
  let fence: { marker: string; lang: string; start: number; lines: string[] } | null = null;
  let blank = true;
  const closeFence = () => {
    if (fence)
      options.region?.({
        kind: "code",
        start: fence.start,
        end: rows.length,
        code: fence.lines.join("\n"),
        lang: fence.lang,
      });
    fence = null;
  };
  const push = (line: string, hanging: string, hard = false) => {
    rows.push(...wrap(line, width, hanging, hard));
    blank = false;
  };

  // A figure stands apart from the text around it, a blank row on each side.
  const figureRows = (drawn: string[], region: (start: number, end: number) => MarkdownRegion) => {
    if (!blank && rows.at(-1) !== "") rows.push("");
    const start = rows.length;
    rows.push(...drawn.map((row) => (row === "" ? "" : indent + row)));
    options.region?.(region(start, rows.length));
    rows.push("");
    blank = true;
  };

  const lines = plainText(text).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    // A table is a header row, a divider row, and the rows under them.
    const aligns =
      !fence && /^\s*\|/.test(raw) && /^\s*\|/.test(lines[index + 1] ?? "")
        ? divider(lines[index + 1] ?? "")
        : null;
    if (aligns) {
      const body = [raw];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) body.push(lines[index++]!);
      index--;
      rows.push(...renderTable(body, aligns, width, indent));
      blank = false;
      continue;
    }
    if (fence) {
      // A fence closes on a line of only its marker's character, at least as many.
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw)?.[1];
      if (close && close[0] === fence.marker[0] && close.length >= fence.marker.length) {
        push(indent + rule(inner), indent);
        closeFence();
        continue;
      }
      fence.lines.push(raw);
      push(indent + highlight(raw.replace(/\t/g, "  "), fence.lang), indent, true);
      continue;
    }
    // A backtick fence's info string has no backticks, so inline ```code``` opens none.
    const open = /^\s*(?:(`{3,})\s*([\w+#.-]*)[^`]*|(~{3,})\s*([\w+#.-]*).*)$/.exec(raw);
    // A figure's fence, once it has closed, shows as the figure; still
    // streaming, or one that cannot be drawn, it shows as code.
    const fenceMarker = open?.[1] ?? open?.[3] ?? "";
    const kind = open ? fenceFigure(open[2] ?? open[4] ?? "") : null;
    if (open && kind && options.figure) {
      const end = lines.findIndex(
        (line, at) =>
          at > index && (/^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1] ?? "").startsWith(fenceMarker),
      );
      const figure: Figure = { kind, source: lines.slice(index + 1, end).join("\n") };
      const drawn = end === -1 ? null : options.figure(figure, inner);
      if (drawn) {
        figureRows(drawn, (start, stop) => ({ kind: "figure", start, end: stop, figure }));
        index = end;
        continue;
      }
    }
    // Display math, once closed, is typeset; while it streams, it reads as text.
    const display = open ? null : displayMath(lines, index);
    if (display) {
      const figure: Figure = { kind: "math", source: display.tex };
      const drawn = display.closed
        ? (options.figure?.(figure, inner) ?? texLines(display.tex).map((line) => style.text(line)))
        : null;
      if (drawn) figureRows(drawn, (start, stop) => ({ kind: "figure", start, end: stop, figure }));
      // Still streaming: what has come, as text, until it closes.
      else for (const line of texLines(display.tex)) push(indent + style.soft(line), indent);
      index = display.end;
      continue;
    }
    const image = IMAGE_LINE.exec(raw);
    if (image) {
      const alt = image[1] ?? "";
      const src = image[2] ?? "";
      const drawn = options.image?.(src, alt, inner);
      if (drawn) {
        figureRows(drawn, (start, stop) => ({ kind: "image", start, end: stop, src, alt }));
        continue;
      }
    }
    if (open) {
      fence = {
        marker: open[1] ?? open[3] ?? "```",
        lang: open[2] ?? open[4] ?? "",
        start: rows.length,
        lines: [],
      };
      push(indent + rule(inner, fence.lang), indent);
      continue;
    }
    if (raw.trim() === "") {
      if (!blank) rows.push("");
      blank = true;
      options.settled?.(index, rows.length);
      continue;
    }
    // Closing #s come after a space, so `C#` keeps its own.
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw);
    if (heading) {
      push(indent + style.bold(inline(heading[1] ?? "")), indent);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      push(indent + rule(inner), indent);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const nest = "  ".repeat(Math.floor((bullet[1] ?? "").length / 2));
      let body = bullet[2] ?? "";
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      const marker = task ? (task[1] === " " ? "☐ " : "☑ ") : "• ";
      if (task) body = task[2] ?? "";
      push(indent + nest + style.faint(marker) + inline(body), `${indent + nest}  `);
      continue;
    }
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    if (ordered) {
      const nest = "  ".repeat(Math.floor((ordered[1] ?? "").length / 2));
      const number = `${ordered[2] ?? "1"}.`;
      push(
        `${indent + nest + style.faint(number)} ${inline(ordered[3] ?? "")}`,
        indent + nest + " ".repeat(number.length + 1),
      );
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      push(`${indent + style.faint("│")} ${style.soft(inline(quote[1] ?? ""))}`, `${indent}  `);
      continue;
    }
    push(indent + inline(raw.trim()), indent);
  }
  // A block still streaming is one too, so far.
  closeFence();
  while (rows.at(-1) === "") rows.pop();
  return rows;
}
