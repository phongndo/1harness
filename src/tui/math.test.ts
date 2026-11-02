import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Figure } from "./figures.ts";
import { pngSize } from "./images.ts";
import { inline, renderMarkdown, type MarkdownRegion } from "./markdown.ts";
import { Equations, texLines, texToUnicode } from "./math.ts";
import { imagePath } from "./transcript.ts";

const CELL = { width: 8, height: 16 };
const plain = (text: string) => stripVTControlCharacters(text);
const figure = ({ kind, source }: Figure) => [`<${kind}: ${source}>`];

describe("TeX as Unicode", () => {
  it("sets symbols, scripts, fractions, and roots as they would be typed", () => {
    assert.equal(texToUnicode("E = mc^2"), "E = mc²");
    assert.equal(texToUnicode("\\alpha \\leq \\beta \\neq \\gamma"), "α ≤ β ≠ γ");
    assert.equal(texToUnicode("\\sum_{i=1}^{n} x_i"), "∑ᵢ₌₁ⁿ xᵢ");
    assert.equal(texToUnicode("\\frac{1}{2} + \\frac{a+b}{c}"), "½ + (a+b)/c");
    assert.equal(texToUnicode("\\frac{\\sqrt{\\pi}}{2}"), "√π/2");
    assert.equal(texToUnicode("\\sqrt[3]{x} \\sqrt{x+1}"), "∛x √(x+1)");
    assert.equal(texToUnicode("A^{-1} A^T A^\\top f''"), "A⁻¹ Aᵀ Aᵀ f″");
    assert.equal(texToUnicode("\\mathbb{R}^n \\to \\mathcal{L}"), "ℝⁿ → ℒ");
  });

  it("marks what it cannot raise or lower, and keeps what it does not know", () => {
    assert.equal(texToUnicode("e^{-x^2}"), "e^(−x²)");
    assert.equal(texToUnicode("\\lim_{n \\to \\infty} a_n"), "lim_(n→∞) aₙ");
    assert.equal(texToUnicode("\\foo"), "foo");
  });

  it("sizes no delimiters and reads text as written", () => {
    assert.equal(texToUnicode("\\left( \\frac{a}{b} \\right)"), "(a/b)");
    assert.equal(texToUnicode("\\left. x \\right|_0^1"), "x |₀¹");
    assert.equal(texToUnicode("x \\text{ if } x > 0"), "x if x > 0");
    assert.equal(texToUnicode("\\operatorname*{argmax}_x f"), "argmaxₓ f");
  });

  it("brackets matrices, joins cases, and lines aligned rows up at their &", () => {
    assert.equal(texToUnicode("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"), "(a b; c d)");
    assert.equal(
      texToUnicode("|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & \\text{otherwise} \\end{cases}"),
      "|x| = {x, x ≥ 0; −x, otherwise}",
    );
    assert.deepEqual(
      texLines("\\begin{aligned} f(x) &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}"),
      ["f(x) = (x+1)²", "     = x² + 2x + 1"],
    );
  });

  it("never fails on TeX still streaming or out of balance", () => {
    assert.equal(texToUnicode("\\frac{1}{"), "1/");
    assert.equal(texToUnicode("a}b"), "ab");
    assert.equal(texToUnicode("\\begin{pmatrix} a & b"), "(a b)");
    assert.equal(texToUnicode(""), "");
  });
});

describe("math in Markdown", () => {
  it("reads inline math as Unicode, leaving prices, escapes, and code alone", () => {
    assert.equal(plain(inline("where $x^2 + y^2 = r^2$ holds")), "where x² + y² = r² holds");
    assert.equal(plain(inline("and \\(\\alpha_1\\) too")), "and α₁ too");
    assert.equal(plain(inline("costs $5 and $10 today")), "costs $5 and $10 today");
    assert.equal(plain(inline("echo $HOME/$USER")), "echo $HOME/$USER");
    assert.equal(plain(inline("a \\$5 bill, $x$")), "a $5 bill, x");
    assert.equal(plain(inline("`$x^2$` stays code")), "$x^2$ stays code");
    // Underscores in math are subscripts, not emphasis.
    assert.equal(plain(inline("$a_i$ and $b_j$")), "aᵢ and bⱼ");
  });

  it("draws display math once it closes, and shows its text while it streams", () => {
    const regions: MarkdownRegion[] = [];
    const done = renderMarkdown("Euler:\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n\nDone.", 60, "  ", {
      figure,
      region: (region) => regions.push(region),
    });
    assert.ok(done.includes("  <math: e^{i\\pi} + 1 = 0>"), done.join("\n"));
    assert.equal(done.at(-1), "  Done.");
    assert.deepEqual(
      regions.map((region) => region.kind),
      ["figure"],
    );
    const streaming = renderMarkdown("$$\ne^{i\\pi} +", 60, "  ", { figure });
    assert.ok(!streaming.some((row) => row.includes("<math")));
    assert.equal(plain(streaming.join("\n")), "  e^(iπ) +");
  });

  it("reads displays on one line, in \\[ \\], and in math fences", () => {
    for (const source of ["$$ x^2 $$", "\\[ x^2 \\]", "\\[\nx^2\n\\]", "```math\nx^2\n```"]) {
      const rows = renderMarkdown(source, 60, "  ", { figure });
      assert.ok(rows.includes("  <math: x^2>"), `${source}: ${rows.join("\n")}`);
    }
  });

  it("closes a display whose closer has punctuation after it, keeping the text below", () => {
    for (const source of ["\\[\nx^2\n\\].\nDone.", "$$ x^2 $$,\nDone."]) {
      const rows = renderMarkdown(source, 60, "  ", { figure });
      assert.ok(
        rows.some((row) => /^ {2}<math: x\^2[.,]>$/.test(row)),
        `${source}: ${rows.join("\n")}`,
      );
      assert.equal(plain(rows.at(-1) ?? ""), "  Done.");
    }
  });

  it("does not take a paragraph that starts with dollars, or swallow text after a display that never closed", () => {
    const rows = renderMarkdown("$$ never closes\n\nNext paragraph.", 60, "  ", { figure });
    assert.equal(plain(rows.at(-1) ?? ""), "  Next paragraph.");
    assert.ok(!rows.some((row) => row.includes("<math")));
  });

  it("sets display math as text where nothing draws it", () => {
    const rows = renderMarkdown("$$\n\\alpha + \\beta\n$$", 60);
    assert.ok(
      rows.some((row) => plain(row) === "  α + β"),
      rows.join("\n"),
    );
  });
});

describe("images in Markdown", () => {
  it("draws an image on a line of its own, and describes one within a line", () => {
    const asked: string[] = [];
    const regions: MarkdownRegion[] = [];
    const rows = renderMarkdown(
      "See ![a chart](inline.png) here.\n\n![Plot](out/plot.png)",
      60,
      "  ",
      {
        image: (src, alt) => {
          asked.push(src);
          return [`<image ${src}>`, alt];
        },
        region: (region) => regions.push(region),
      },
    );
    assert.deepEqual(asked, ["out/plot.png"]);
    assert.equal(plain(rows[0] ?? ""), "  See ▣ a chart here.");
    assert.ok(rows.includes("  <image out/plot.png>"));
    assert.deepEqual(regions.at(-1), {
      kind: "image",
      start: 2,
      end: 4,
      src: "out/plot.png",
      alt: "Plot",
    });
  });

  it("describes an image nothing draws", () => {
    const rows = renderMarkdown("![Plot](plot.png)", 60, "  ", { image: () => null });
    assert.equal(plain(rows[0] ?? ""), "  ▣ Plot");
  });

  it("finds an image's file from the thread's folder, and fetches none from the web", () => {
    assert.equal(imagePath("out/plot.png", "/work"), "/work/out/plot.png");
    assert.equal(imagePath("/tmp/a%20b.png", "/work"), "/tmp/a b.png");
    assert.equal(imagePath("file:///tmp/x.png", "/work"), "/tmp/x.png");
    assert.equal(imagePath("https://example.com/x.png", "/work"), null);
    assert.equal(imagePath("data:image/png;base64,AAAA", "/work"), null);
  });
});

describe("typeset equations", () => {
  it("typesets in the background, on whole cells, and draws again only for a new size", async () => {
    let ready!: () => void;
    let readied = new Promise<void>((resolve) => (ready = resolve));
    const equations = new Equations(() => ready());
    const tex = "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}";
    assert.equal(equations.picture(tex, false, 800, CELL), undefined, "typeset in the background");
    await readied;
    const drawn = equations.picture(tex, false, 800, CELL);
    assert.ok(drawn, "a picture");
    const size = pngSize(Buffer.from(drawn.data, "base64"));
    assert.ok(size);
    assert.equal(size.width % CELL.width, 0);
    assert.equal(size.height % CELL.height, 0);
    assert.ok(size.height >= 2 * CELL.height, "a fraction takes more than a row");
    assert.equal(
      equations.picture(tex, false, 1600, CELL),
      drawn,
      "a wider column draws nothing new",
    );
    const narrow = equations.picture(tex, false, 80, CELL);
    assert.ok(narrow && narrow.pixelWidth <= 80, "never wider than the room for it");
    const whole = equations.picture(tex, false, 2000, CELL, 600);
    assert.ok(whole && whole.pixelWidth > drawn.pixelWidth, "grows to fill the screen");

    readied = new Promise<void>((resolve) => (ready = resolve));
    assert.equal(equations.picture("\\frac{1}{", false, 800, CELL), undefined);
    await readied;
    assert.equal(equations.picture("\\frac{1}{", false, 800, CELL), null, "TeX it cannot read");
    readied = new Promise<void>((resolve) => (ready = resolve));
    assert.equal(equations.picture("\\bm{x}", false, 800, CELL), undefined);
    await readied;
    assert.equal(
      equations.picture("\\bm{x}", false, 800, CELL),
      null,
      "a command it does not know",
    );
    assert.deepEqual(equations.text("\\alpha^2"), ["α²"]);
  });
});
