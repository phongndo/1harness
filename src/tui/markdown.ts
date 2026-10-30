import { style } from "./theme.ts";
import { visibleWidth, wrap } from "./text.ts";

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
export function highlight(line: string, lang: string): string {
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

/** Inline Markdown: code spans, emphasis, and links. */
export function inline(text: string): string {
  const parts = text.split(/(`+[^`]+`+)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return style.strong(part.replace(/^`+|`+$/g, ""));
      return part
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
          label === url ? style.link(url) : `${style.link(label)} ${style.muted(`(${url})`)}`,
        )
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) =>
          style.bold(a ?? b ?? ""),
        )
        .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\*)/g, (_, lead: string, body: string) => {
          return lead + style.italic(body);
        })
        .replace(/~~([^~]+)~~/g, (_, body: string) => style.strike(body));
    })
    .join("");
}

function rule(width: number, label = ""): string {
  const head = label ? `─ ${label} ` : "";
  return style.faint(head + "─".repeat(Math.max(0, width - visibleWidth(head))));
}

/**
 * Renders Markdown the way fx prints assistant replies: indented prose, faint
 * list markers and code rules, bold headings, and code in its own grays.
 * Returns rows already wrapped to `width`.
 */
export function renderMarkdown(text: string, width: number, indent = "  "): string[] {
  const rows: string[] = [];
  const inner = Math.max(10, width - visibleWidth(indent));
  let fence: { marker: string; lang: string } | null = null;
  let blank = true;
  const push = (line: string, hanging: string, hard = false) => {
    rows.push(...wrap(line, width, hanging, hard));
    blank = false;
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (raw.trim().startsWith(fence.marker)) {
        push(indent + rule(inner), indent);
        fence = null;
        continue;
      }
      push(indent + highlight(raw.replace(/\t/g, "  "), fence.lang), indent, true);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw);
    if (open) {
      fence = { marker: open[1] ?? "```", lang: open[2] ?? "" };
      push(indent + rule(inner, fence.lang), indent);
      continue;
    }
    if (raw.trim() === "") {
      if (!blank) rows.push("");
      blank = true;
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
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
    if (/^\s*\|/.test(raw)) {
      const cells = raw.trim();
      if (/^\|[\s:|-]+\|$/.test(cells)) {
        push(indent + style.faint(cells.replace(/[^|]/g, "─").replace(/\|/g, "┼")), indent, true);
      } else {
        push(indent + cells.replace(/\|/g, style.faint("│")), indent, true);
      }
      continue;
    }
    push(indent + inline(raw.trim()), indent);
  }
  while (rows.at(-1) === "") rows.pop();
  return rows;
}
