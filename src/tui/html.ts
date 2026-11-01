// A page's text, for a terminal that shows no pictures, or while it is drawn:
// what a reader would take from it, its headings, paragraphs, list items and
// table cells on lines of their own, without its markup, styles, or scripts.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
  bull: "•",
  copy: "©",
};

/** Tags that start and end a line of their own. */
const BLOCKS =
  /<\/?(?:p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|table|thead|tbody|tfoot|blockquote|pre|figure|figcaption|dl|dt|dd|hr|form|fieldset|details|summary)\b[^>]*>/gi;

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** A page as lines of plain text. */
export function htmlText(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    // A drawing has no text to read; its place is kept.
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, "\n▣ graphic\n")
    .replace(/<canvas\b[\s\S]*?<\/canvas\s*>/gi, "\n▣ graphic\n")
    .replace(/<img\b[^>]*>/gi, (tag) => `\n▣ ${/\balt="([^"]*)"/i.exec(tag)?.[1] || "image"}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    // A list item, or a table's row, starts a line; a row's cells are set apart on it.
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, "\t")
    .replace(BLOCKS, "\n")
    .replace(/<[^>]*>/g, "");
  const lines = decode(text)
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((cell) => cell.replace(/[ \f\v\u00a0]+/g, " ").trim())
        .filter(Boolean)
        .join("   "),
    );
  // Blank lines between blocks, one at most.
  const kept: string[] = [];
  for (const line of lines)
    if (line !== "" || (kept.length > 0 && kept.at(-1) !== "")) kept.push(line);
  while (kept.at(-1) === "") kept.pop();
  return kept;
}
