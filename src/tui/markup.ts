import { fenceFigure } from "./figures.ts";
import { ICONS, type IconName } from "./look.ts";
import {
  HASH_COMMENTS,
  IMAGE_LINE,
  KEYWORDS,
  displayMath,
  divider,
  emphasis,
  tableCells,
} from "./markdown.ts";
import { texToUnicode } from "./math.ts";
import { surfaces } from "./theme.ts";
import { charWidth, plainText } from "./text.ts";

// Pages for what the transcript shows, which html2term draws as T3 Code's chat
// looks: Markdown as HTML, and rows of work with their icons. Everything an
// agent wrote is escaped, and html2term loads nothing and runs no scripts.

/** A block of a page, with the space it wants above and below, in CSS pixels. */
export interface Part {
  html: string;
  above: number;
  below: number;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Code in a line; its surface is painted behind it, over spacers for its sides. */
function chip(code: string): string {
  const color = `${surfaces().strong.slice(1)}1a`;
  return `<i class="g"></i><code data-chip="${color} 4 5.2 1.6">${escapeHtml(code)}</code><i class="g"></i>`;
}

const COPY_ICON = ICONS.copy;

/** An icon as an inline SVG, `size` CSS pixels square. */
function svg(path: string, size: number, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
  );
}

/** A link's label: one to a file in its own color, and only web, mail, and file links go anywhere. */
function link(label: string, url: string): string {
  const web = /^(?:https?|mailto|file):/i.test(url);
  const path = !/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith("#");
  const file = path || /^file:/i.test(url);
  if (!web && !path) return label;
  return `<a${web ? ` href="${escapeHtml(url)}"` : ""}${file ? ' class="f"' : ""}>${label}</a>`;
}

/** Inline Markdown as HTML, read in the order `inline` reads it. */
function inlineHtml(text: string): string {
  const kept: string[] = [];
  const hold = (html: string) => `\u{E000}${kept.push(html) - 1}\u{E001}`;
  const put = (value: string): string =>
    value.replace(/\u{E000}(\d+)\u{E001}/gu, (_, at: string) => put(kept[Number(at)] ?? ""));
  const paint = (value: string): string => {
    let out = emphasis(value, "***", (body) => `<strong><em>${paint(body)}</em></strong>`);
    out = emphasis(out, "**", (body) => `<strong>${paint(body)}</strong>`);
    out = emphasis(out, "__", (body) => `<strong>${paint(body)}</strong>`);
    out = emphasis(out, "*", (body) => `<em>${paint(body)}</em>`);
    out = emphasis(out, "_", (body) => `<em>${body}</em>`);
    return emphasis(out, "~~", (body) => `<del>${body}</del>`);
  };
  const held = text
    .replace(/[\u{E000}\u{E001}]/gu, "�")
    .replace(/(?<![\\`])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, body: string) =>
      hold(chip(/^ .*[^ ].* $/.test(body) ? body.slice(1, -1) : body)),
    )
    .replace(
      /\\\((.+?)\\\)|(?<![\\$])\$\$(?!\s)(.+?)(?<!\s)\$\$|(?<![\\$\w])\$(?![\s$])((?:[^$\\]|\\.)+?)(?<![\s\\])\$(?![\w$])/g,
      (_, paren?: string, double?: string, single?: string) =>
        hold(escapeHtml(texToUnicode(paren ?? double ?? single ?? ""))),
    )
    .replace(/\\([\\`*_~[\]()#|<>!$-])/g, (_, char: string) => hold(escapeHtml(char)))
    .replace(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, alt: string) =>
      hold(`<span class="m">▣ ${escapeHtml(alt) || "image"}</span>`),
    )
    .replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
      hold(link(paint(escapeHtml(label)), put(url))),
    )
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) => hold(link(escapeHtml(url), url)))
    .replace(/(?<![\w/])https?:\/\/[^\s<>"'`\u{E000}]+[^\s<>"'`.,;:!?)\]\u{E000}]/gu, (url) =>
      hold(link(escapeHtml(url), url)),
    );
  return put(paint(escapeHtml(held)));
}

const TOKENS =
  /(\/\/.*$|#.*$|--.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)|([=+*/%!&|^~?<>-]+)|([()[\]{}.,;:]+)/gi;
const TYPES = new Set(
  "string number boolean void any unknown never object bigint symbol int float double char bool str u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64 String Vec Option Result Promise Array Record Map Set".split(
    " ",
  ),
);

/** A line of code as HTML, in the colors T3 Code gives its parts. */
function codeHtml(line: string, lang: string): string {
  const language = lang.toLowerCase();
  const colors = surfaces();
  const span = (color: string, text: string) =>
    `<span style="color:${color}">${escapeHtml(text)}</span>`;
  if (language === "diff" || language === "patch") {
    if (line.startsWith("+") && !line.startsWith("+++")) return span(colors.added, line);
    if (line.startsWith("-") && !line.startsWith("---")) return span(colors.removed, line);
    if (line.startsWith("@@")) return span(colors.muted, line);
    return escapeHtml(line);
  }
  if (language === "" || /^(?:text|txt|plain|plaintext)$/.test(language)) return escapeHtml(line);
  const hash = HASH_COMMENTS.has(language);
  const dash = language === "sql" || language === "lua" || language === "haskell";
  const { syntax } = colors;
  let out = "";
  let at = 0;
  // Its own, since a template's code is read while its line is.
  const tokens = new RegExp(TOKENS);
  for (let match = tokens.exec(line); match; match = tokens.exec(line)) {
    const [token, comment, literal, number, word, operator] = match;
    out += escapeHtml(line.slice(at, match.index));
    at = match.index + token.length;
    if (comment) {
      if (comment.startsWith("//") ? !hash : comment.startsWith("#") ? hash : dash) {
        out += span(syntax.mark, comment);
      } else {
        // Only looked like a comment: its first character is read, and the rest again.
        out += span(syntax.operator, token.charAt(0));
        at = match.index + 1;
        tokens.lastIndex = at;
      }
    } else if (literal) {
      // What a template puts in is code again.
      for (const part of literal.startsWith("`") ? literal.split(/(\$\{[^}]*\})/) : [literal])
        out +=
          part.startsWith("${") && part.endsWith("}")
            ? span(syntax.keyword, "${") +
              codeHtml(part.slice(2, -1), lang) +
              span(syntax.keyword, "}")
            : span(syntax.literal, part);
    } else if (number) out += span(syntax.number, number);
    else if (word) {
      const call = /^\s*\(/.test(line.slice(at));
      out += span(
        KEYWORDS.has(word)
          ? syntax.keyword
          : TYPES.has(word)
            ? syntax.type
            : call
              ? syntax.call
              : syntax.name,
        word,
      );
    } else if (operator) out += span(syntax.operator, operator);
    else out += span(syntax.mark, token);
  }
  return out + escapeHtml(line.slice(at));
}

/** What a piece of text takes across a line, near enough to share a table's width by. */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) {
    const cells = charWidth(char.codePointAt(0) ?? 0);
    if (cells === 2) width += 1;
    else if (/[ilj.,;:'|!()[\]I]/.test(char)) width += 0.3;
    else if (/[mwMW@%]/.test(char)) width += 0.86;
    else if (/[A-Z]/.test(char)) width += 0.68;
    else if (/[ftr]/.test(char)) width += 0.38;
    else if (char === " ") width += 0.28;
    else width += 0.58 * cells;
  }
  return width * size;
}

/** Text cut to fit `room` CSS pixels on one line, as far as its width is known. */
export function fitText(text: string, size: number, room: number): string {
  if (textWidth(text, size) <= room) return text;
  let out = "";
  let width = textWidth("…", size);
  for (const char of text) {
    width += textWidth(char, size);
    if (width > room) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** A table, its columns sharing the width as their widest cells do, as a browser shares it. */
function tableHtml(lines: string[]): string {
  const aligns = divider(lines[1] ?? "") ?? [];
  const rows = [lines[0] ?? "", ...lines.slice(2)].map(tableCells);
  const columns = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      24,
      ...rows.map(
        (cells) =>
          Math.min(384, textWidth(cells[column] ?? "", 14)) +
          (column === 0 || column === columns - 1 ? 12 : 24),
      ),
    ),
  );
  const total = widths.reduce((sum, width) => sum + width, 0);
  const row = (cells: string[], tag: string) =>
    `<tr>${Array.from({ length: columns }, (_, column) => {
      const align = aligns[column] ?? "left";
      const share = ((widths[column] ?? 0) / total) * 100;
      const styles = `width:${share.toFixed(2)}%${align === "left" ? "" : `;text-align:${align}`}`;
      return `<${tag} style="${styles}">${inlineHtml(cells[column] ?? "")}</${tag}>`;
    }).join("")}</tr>`;
  const [head = [], ...body] = rows;
  return `<table>${row(head, "th")}${body.map((cells) => row(cells, "td")).join("")}</table>`;
}

/** What Markdown as HTML comes to: its blocks, and the code its copy targets name by place. */
export interface Markup {
  parts: Part[];
  code: { code: string; lang: string }[];
}

const SPACE = 10.4;
const FENCE = /^\s*(?:(`{3,})\s*([\w+#.-]*)[^`]*|(~{3,})\s*([\w+#.-]*).*)$/;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])(?:\s+(.*)|)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;

function starts(line: string, next: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    /^\s*>/.test(line) ||
    (/^\s*\|/.test(line) && /^\s*\|/.test(next) && divider(next) !== null)
  );
}

/** A list's items from line `index`, each its own blocks, and the line after it. */
function listHtml(
  lines: string[],
  index: number,
  into: Markup,
  bubble: boolean,
): { html: string; next: number } {
  const first = ITEM.exec(lines[index] ?? "")!;
  const base = (first[1] ?? "").length;
  const ordered = first[3] !== undefined;
  const items: string[][] = [];
  let at = index;
  for (; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const item = ITEM.exec(line);
    const indent = line.length - line.trimStart().length;
    if (item && indent <= base + 1 && !RULE.test(line)) {
      if (indent < base || (item[3] !== undefined) !== ordered) break;
      items.push([item[4] ?? ""]);
      continue;
    }
    if (line.trim() === "") {
      const next = lines.slice(at + 1).find((one) => one.trim() !== "") ?? "";
      const inside = next.length - next.trimStart().length;
      const same = ITEM.exec(next);
      if (next === "" || (inside <= base + 1 && !(same && (same[3] !== undefined) === ordered)))
        break;
      items.at(-1)?.push("");
      continue;
    }
    // A line no further in than the list is the item's own, unless it starts something else.
    if (indent <= base && starts(line, lines[at + 1] ?? "")) break;
    items.at(-1)?.push(line.slice(Math.min(indent, base + (ordered ? 3 : 2))));
  }
  const start = ordered && first[3] !== "1" ? ` start="${Number(first[3])}"` : "";
  const body = items
    .map((item) => {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[0] ?? "");
      const content = task ? [task[2] ?? "", ...item.slice(1)] : item;
      const inner: Markup = { parts: [], code: into.code };
      blocks(content, inner, bubble);
      const box = task ? `<span class="t">${task[1] === " " ? "☐" : "☑"}</span>` : "";
      const [head, ...rest] = inner.parts;
      const text = head?.html.replace(/^<p>([\s\S]*)<\/p>$/, "$1") ?? "";
      return `<li${task ? ' class="k"' : ""}>${box}${text}${join(rest, 4)}</li>`;
    })
    .join("");
  const tag = ordered ? "ol" : "ul";
  const wide = ordered && items.length > 9 ? ' style="padding-left:26px"' : "";
  return { html: `<${tag}${start}${wide}>${body}</${tag}>`, next: at };
}

function blocks(lines: string[], into: Markup, bubble: boolean): void {
  const push = (html: string, above = SPACE, below = SPACE) =>
    into.parts.push({ html, above, below });
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? fence[3] ?? "```";
      const lang = fence[2] ?? fence[4] ?? "";
      const code: string[] = [];
      const inset = line.length - line.trimStart().length;
      for (index++; index < lines.length; index++) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index] ?? "")?.[1];
        if (close && close[0] === marker[0] && close.length >= marker.length) break;
        const raw = lines[index] ?? "";
        code.push(raw.slice(Math.min(inset, raw.length - raw.trimStart().length)));
      }
      index++;
      const at = into.code.push({ code: code.join("\n"), lang }) - 1;
      const shown = code.map((row) => codeHtml(row.replace(/\t/g, "  "), lang)).join("\n");
      push(
        `<div class="c" data-hit="c:${at}"><div class="h"><span>${escapeHtml(lang)}</span>${svg(COPY_ICON, 14, surfaces().muted)}</div><pre>${shown || " "}</pre></div>`,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] ?? "#").length);
      push(`<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`, 20, 8);
      index++;
      continue;
    }
    if (RULE.test(line)) {
      push("<hr>", 21, 21);
      index++;
      continue;
    }
    if (
      /^\s*\|/.test(line) &&
      /^\s*\|/.test(lines[index + 1] ?? "") &&
      divider(lines[index + 1] ?? "")
    ) {
      const rows: string[] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) rows.push(lines[index++]!);
      push(tableHtml(rows));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim() !== "") {
        const raw = lines[index] ?? "";
        if (!/^\s*>/.test(raw) && starts(raw, lines[index + 1] ?? "")) break;
        body.push(raw.replace(/^\s*>\s?/, ""));
        index++;
      }
      const inner: Markup = { parts: [], code: into.code };
      blocks(body, inner, bubble);
      push(`<blockquote>${join(inner.parts)}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const list = listHtml(lines, index, into, bubble);
      push(list.html);
      index = list.next;
      continue;
    }
    const text: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      const raw = lines[index] ?? "";
      const item = ITEM.exec(raw);
      // Only a list from 1 breaks into a paragraph, so a year that starts a line does not.
      if (
        text.length > 0 &&
        (starts(raw, lines[index + 1] ?? "") || (item && (item[3] ?? "1") === "1"))
      )
        break;
      text.push(raw);
      index++;
    }
    const joined = text.map((raw, at) => {
      const hard = /(?: {2,}|\\)$/.test(raw) && at < text.length - 1;
      return (
        raw.trim().replace(/\\$/, "") + (hard || (bubble && at < text.length - 1) ? "\u{E002}" : "")
      );
    });
    push(`<p>${inlineHtml(joined.join("\n")).replace(/\u{E002}\n?/gu, "<br>")}</p>`);
  }
}

/** Blocks one under another, the larger of the space each wants between them. */
function join(parts: readonly Part[], first = 0): string {
  return parts
    .map((part, index) => {
      const space = index === 0 ? first : Math.max(part.above, parts[index - 1]?.below ?? 0);
      return space > 0 ? `<div style="padding-top:${space}px">${part.html}</div>` : part.html;
    })
    .join("");
}

/** A list that opens over the composer: an entry as it is drawn. */
export interface ListRow {
  label: string;
  detail: string;
  tag: string;
  chosen: boolean;
  /** Drawn as what is in use now. */
  current: boolean;
  inert: boolean;
}

/** The space an entry takes down a list, over its ends, and for its search and keys, in CSS pixels. */
export const LIST = { row: 28, end: 8, head: 41, foot: 33 } as const;

/**
 * A list as a page `width` by `height` CSS pixels, its bottom open to the
 * composer it meets: each part is drawn again only when it changes.
 */
export function optionsHtml(
  rows: readonly ListRow[],
  head: { text: string; hint: boolean; search: boolean; tabs: string } | null,
  foot: { keys: string; place: string } | null,
  width: number,
  height: number,
): string[] {
  const colors = surfaces();
  const side = `border-left:1px solid ${colors.menuBorder};border-right:1px solid ${colors.menuBorder};background:${colors.menu}`;
  const parts: string[] = [];
  // The first has the list's rounded top, over the space at its end.
  const part = (html: string, tall: number, styles = "") => {
    const first = parts.length === 0;
    const top = first
      ? `;border-top:1px solid ${colors.menuBorder};border-radius:16px 16px 0 0;padding-top:${LIST.end - 1}px`
      : "";
    parts.push(
      `<div data-hit="b:${parts.length}" style="${side};font-size:12px;height:${tall + (first ? LIST.end : 0)}px${top}${styles}">${html}</div>`,
    );
  };
  if (head) {
    const mark = head.search
      ? `<span style="width:24px;flex:none">${svg(ICONS.search, 14, colors.icon)}</span>`
      : "";
    part(
      `<div style="display:flex;align-items:center;height:36px;padding:0 16px;font-size:14px;color:${head.hint ? colors.muted : colors.strong}">${mark}<span style="white-space:pre">${escapeHtml(head.text)}</span><span style="white-space:pre;font-size:12px">${ansiHtml(head.tabs)}</span></div>` +
        `<div style="height:1px;margin:0 12px;background:${head.search ? colors.focus : colors.line}"></div>`,
      LIST.head,
    );
  }
  for (const [index, row] of rows.entries()) {
    const room = width - 34;
    const tag = row.tag ? fitText(row.tag, 12, 120) : "";
    const tagged = tag ? textWidth(tag, 12) + 24 : 0;
    const label = fitText(row.label, 12.4, room - tagged);
    const left = room - tagged - textWidth(label, 12.4) - 8 - (row.current ? 20 : 0);
    const detail = row.detail && left > 40 ? fitText(row.detail, 12, left) : "";
    part(
      `<div data-hit="m:${index}" style="display:flex;align-items:center;gap:8px;height:${LIST.row}px;margin:0 7px;padding:0 8px;border-radius:8px;white-space:pre${row.chosen ? `;background:${colors.highlight}` : ""}">` +
        `<span style="font-weight:500;color:${row.inert ? colors.muted : colors.strong}">${escapeHtml(label)}</span>` +
        (row.current ? svg("M20 6 9 17l-5-5", 14, colors.muted) : "") +
        `<span style="flex:1;color:${colors.muted}">${escapeHtml(detail)}</span>` +
        (tag
          ? `<span style="padding:0 8px;border-radius:6px;line-height:20px;color:${colors.label};background:${colors.highlight}">${escapeHtml(tag)}</span>`
          : "") +
        "</div>",
      LIST.row,
    );
  }
  if (rows.length === 0)
    part(`<div style="padding:3px 16px;color:${colors.muted}">No matches</div>`, LIST.row);
  const used =
    LIST.end +
    (head ? LIST.head : 0) +
    Math.max(1, rows.length) * LIST.row +
    (foot ? LIST.foot : 0);
  // The last cell is filled, so the list meets the composer; whole pixels, as layout rounds to.
  const spare = Math.floor(Math.max(0, height - used));
  if (foot)
    part(
      `<div style="height:1px;margin:0 12px;background:${colors.line}"></div><div style="display:flex;justify-content:space-between;padding:4px 16px;white-space:pre"><span>${ansiHtml(foot.keys)}</span><span style="color:${colors.muted}">${escapeHtml(foot.place)}</span></div>`,
      LIST.foot + spare,
      `;padding-top:${Math.min(8, spare)}px`,
    );
  else part("", spare);
  return parts;
}

/** A row of the terminal's as one line of a page, what it has at the right kept there. */
export function lineHtml(row: string, height: number, width: number): string {
  // oxlint-disable-next-line no-control-regex
  const apart = /^(.*?\S(?:\x1b\[[\d;]*m)*) {3,}((?:\x1b\[[\d;]*m)*\S.*)$/.exec(row);
  const [left, right] = apart ? [apart[1] ?? "", apart[2] ?? ""] : [row, ""];
  return (
    `<div style="display:flex;justify-content:space-between;width:${width}px;height:${height}px;padding:0 16px;font-size:12px;line-height:${height}px;white-space:pre;overflow:hidden">` +
    `<span>${ansiHtml(left.trimEnd())}</span><span>${ansiHtml(right.trimEnd())}</span></div>`
  );
}

/** Whether Markdown has what is drawn another way: a diagram, display math, or an image. */
export function hasFigures(text: string): boolean {
  const lines = plainText(text).split("\n");
  return lines.some((line, index) => {
    const fence = FENCE.exec(line);
    if (fence) return fenceFigure(fence[2] ?? fence[4] ?? "") !== null;
    return IMAGE_LINE.test(line) || displayMath(lines, index) !== null;
  });
}

/** Markdown as a page's blocks; a message's lines break where they were broken. */
export function markup(text: string, bubble = false): Markup {
  const out: Markup = { parts: [], code: [] };
  blocks(plainText(text).split("\n"), out, bubble);
  return out;
}

/** Blocks as a page's body, each marked, so a longer page can tell which of it is unchanged. */
export function flow(parts: readonly Part[]): string[] {
  return parts.map((part, index) => {
    const space = index === 0 ? 0 : Math.max(part.above, parts[index - 1]?.below ?? 0);
    return `<div style="height:${space}px"></div><div data-hit="b:${index}">${part.html}</div>`;
  });
}

/** Text the terminal styles, as HTML with its colors: a row's attributes and its 24-bit and ANSI colors. */
export function ansiHtml(row: string): string {
  const colors = surfaces();
  const ansi: Record<number, string> = {
    31: colors.removed,
    32: colors.added,
    33: colors.attention,
    34: colors.link,
    36: colors.active,
  };
  let bold = false;
  let italic = false;
  let struck = false;
  let color = "";
  let out = "";
  let at = 0;
  const text = (value: string) => {
    if (value === "") return;
    const styles =
      (color ? `color:${color};` : "") +
      (bold ? "font-weight:600;" : "") +
      (italic ? "font-style:italic;" : "") +
      (struck ? "text-decoration:line-through;" : "");
    out += styles ? `<span style="${styles}">${escapeHtml(value)}</span>` : escapeHtml(value);
  };
  // oxlint-disable-next-line no-control-regex
  for (const match of row.matchAll(/\x1b\[([\d;]*)m/g)) {
    text(row.slice(at, match.index));
    at = match.index + match[0].length;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index] ?? 0;
      if (code === 0) {
        bold = italic = struck = false;
        color = "";
      } else if (code === 1) bold = true;
      else if (code === 2) color = colors.muted;
      else if (code === 22) {
        bold = false;
        if (color === colors.muted) color = "";
      } else if (code === 3 || code === 23) italic = code === 3;
      else if (code === 9 || code === 29) struck = code === 9;
      else if (code === 39) color = "";
      else if (code === 38 && codes[index + 1] === 2) {
        color = `rgb(${codes.slice(index + 2, index + 5).join(",")})`;
        index += 4;
      } else if (code in ansi) color = ansi[code] ?? "";
    }
  }
  text(row.slice(at));
  return out;
}

/** A row of work: an icon, or the space of one, before text on one line or wrapped. */
export interface WorkRow {
  icon?: IconName | undefined;
  dimmed?: boolean;
  /** In as far as text after an icon is. */
  inset?: boolean;
  text: string;
  wraps?: boolean;
}

/** Rows of work as T3 Code lists them, `width` CSS pixels wide, each a block of its own. */
export function workHtml(rows: readonly WorkRow[], width: number): string[] {
  const colors = surfaces();
  return rows.map(({ icon, dimmed, inset, text, wraps }, index) => {
    const lead = icon
      ? `<span class="i">${svg(ICONS[icon], 16, dimmed ? colors.failed : colors.icon)}</span>`
      : inset
        ? '<span class="i"></span>'
        : "";
    const cut = wraps ? text : cutAnsi(text, width - (lead ? 32 : 4));
    return `<div class="w" data-hit="b:${index}">${lead}<span class="x${wraps ? "" : " n"}">${ansiHtml(cut)}</span></div>`;
  });
}

/** Styled text cut to fit `room` CSS pixels, its styles with it. */
function cutAnsi(row: string, room: number): string {
  // oxlint-disable-next-line no-control-regex
  const plain = row.replace(/\x1b\[[\d;]*m/g, "");
  if (textWidth(plain, 14) <= room) return row;
  let left = fitText(plain, 14, room).length - 1;
  let out = "";
  // oxlint-disable-next-line no-control-regex
  for (const piece of row.split(/(\x1b\[[\d;]*m)/)) {
    if (piece.startsWith("\x1b[")) out += piece;
    else if (left > 0) {
      out += piece.slice(0, left);
      left -= piece.length;
      if (left <= 0) out += "…";
    }
  }
  return out;
}

/** What was sent, in a bubble at the column's right. */
export function bubbleHtml(parts: readonly Part[], label: string): string {
  const head = label ? `<div class="m">${escapeHtml(label)}</div>` : "";
  return `<div class="u"><div class="v">${head}${join(parts)}</div></div>`;
}

/** The line that heads a finished turn's answer, over its failures and the files it changed. */
export function workedHtml(head: string, rows: readonly WorkRow[], width: number): string {
  const chevron = svg("m9 18 6-6-6-6", 14, surfaces().muted);
  return `<div class="d"><div class="e"><span class="m">${escapeHtml(fitText(head, 14, width - 40))}</span>${chevron}</div>${workHtml(rows, width).join("")}</div>`;
}

/**
 * A surface's color as a veil over the page that looks the same on it, so what
 * the terminal fills cells with, as selected text's, shows through.
 */
function veil(color: string): string {
  const [from = 0, to = 0] = [surfaces().page, color].map((value) =>
    Number.parseInt(value.slice(1, 3), 16),
  );
  const light = to >= from;
  const alpha = light ? (to - from) / Math.max(1, 255 - from) : (from - to) / Math.max(1, from);
  return `rgba(${light ? "255,255,255" : "0,0,0"},${(Math.round(alpha * 255) / 255).toFixed(4)})`;
}

/** A whole page: the body, in T3 Code's sizes and the look's colors. */
export function page(body: string): string {
  const colors = surfaces();
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent}
body{font:400 14px/22.75px Text,sans-serif;color:${colors.text};overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{font-weight:600;color:${colors.strong};line-height:1.3}
h1{font-size:20px}h2{font-size:18px}h3{font-size:16px}h4,h5,h6{font-size:14px}h6{color:${colors.muted}}
strong{font-weight:700}
code{font-family:Code,monospace;font-size:11.9px;color:${colors.strong}}
i.g{display:inline-block;width:5.2px;height:1px}
a{color:${colors.link};text-decoration:none}a.f{color:${colors.file}}
ol,ul{padding-left:20px}ul ul{list-style-type:circle}li+li{margin-top:4px}
li.k{list-style-type:none}.t{display:inline-block;width:20px;margin-left:-20px}
blockquote{border-left:2px solid ${colors.quote};padding-left:12.8px}
hr{border:0;border-top:1px solid ${colors.quote};height:1px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:7.2px 12px;border-bottom:1px solid ${colors.line}}
th{padding:8.8px 12px;font-weight:600}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
.c{background:${veil(colors.code)};border:1px solid ${colors.codeBorder};border-radius:8px}
.h{display:flex;justify-content:space-between;align-items:center;height:36px;padding:0 14px;color:${colors.muted};font-size:12px}
pre{font:400 13px/17.875px Code,monospace;white-space:pre-wrap;padding:2px 14.4px 12.8px;color:${colors.text}}
.w{display:flex;align-items:flex-start;padding-left:4px;min-height:24px}
.i{flex:none;width:28px;height:22.75px;padding-top:3.4px}
.i svg{display:block;width:16px;height:16px}
.x{flex:1;min-width:0;white-space:pre-wrap}.n{white-space:pre;overflow:hidden}
.m{color:${colors.muted}}
.u{display:flex;justify-content:flex-end}
.v{max-width:80%;background:${veil(colors.bubble)};border-radius:16px;padding:12px;color:${colors.strong}}
.d{border-bottom:1px solid ${colors.line};padding-bottom:8px}
.e{display:flex;align-items:center;gap:4px;padding:0 4px}
</style>${body}`;
}
