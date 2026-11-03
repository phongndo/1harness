import { BoundedMap, FetchCache } from "./cache.ts";
import type { FigureRenderer } from "./figures.ts";
import type { CellSize, Picture } from "./images.ts";
import { visibleWidth } from "./text.ts";
import { drawLater, loadResvg, onCells } from "./svg.ts";

// LaTeX math, two ways. In a line of prose, `$…$` reads as Unicode text, as
// it would be typed: Greek letters, operators, sub- and superscripts, `a/b`
// for fractions. Text selects, copies, wraps, and streams like the rest of the
// line. On a line of its own, `$$…$$` is typeset: MathJax lays it out as SVG
// with its glyphs as paths, resvg draws it, and the transcript shows it as a
// picture. A terminal without graphics, or TeX MathJax cannot read, gets the
// Unicode text instead, a line per row of the equation.

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  varkappa: "ϰ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  digamma: "ϝ",
};

/** Control words that stand for one symbol. */
const SYMBOLS: Record<string, string> = {
  ...GREEK,
  times: "×",
  cdot: "⋅",
  cdotp: "·",
  centerdot: "·",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "•",
  div: "÷",
  pm: "±",
  mp: "∓",
  setminus: "∖",
  smallsetminus: "∖",
  wr: "≀",
  dagger: "†",
  ddagger: "‡",
  amalg: "⨿",
  oplus: "⊕",
  ominus: "⊖",
  otimes: "⊗",
  oslash: "⊘",
  odot: "⊙",
  uplus: "⊎",
  sqcup: "⊔",
  sqcap: "⊓",
  cup: "∪",
  cap: "∩",
  wedge: "∧",
  land: "∧",
  vee: "∨",
  lor: "∨",
  neg: "¬",
  lnot: "¬",
  leq: "≤",
  le: "≤",
  leqslant: "⩽",
  geq: "≥",
  ge: "≥",
  geqslant: "⩾",
  lt: "<",
  gt: ">",
  neq: "≠",
  ne: "≠",
  nleq: "≰",
  ngeq: "≱",
  ll: "≪",
  gg: "≫",
  lesssim: "≲",
  gtrsim: "≳",
  approx: "≈",
  approxeq: "≊",
  equiv: "≡",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  asymp: "≍",
  doteq: "≐",
  propto: "∝",
  prec: "≺",
  succ: "≻",
  preceq: "⪯",
  succeq: "⪰",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  subsetneq: "⊊",
  supsetneq: "⊋",
  sqsubseteq: "⊑",
  sqsupseteq: "⊒",
  mid: "∣",
  nmid: "∤",
  parallel: "∥",
  perp: "⊥",
  vdash: "⊢",
  dashv: "⊣",
  models: "⊨",
  top: "⊤",
  bot: "⊥",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  emptyset: "∅",
  varnothing: "∅",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  aleph: "ℵ",
  beth: "ℶ",
  hbar: "ℏ",
  hslash: "ℏ",
  ell: "ℓ",
  wp: "℘",
  Re: "ℜ",
  Im: "ℑ",
  imath: "ı",
  jmath: "ȷ",
  prime: "′",
  angle: "∠",
  measuredangle: "∡",
  triangle: "△",
  square: "□",
  Box: "□",
  blacksquare: "■",
  diamond: "⋄",
  lozenge: "◊",
  checkmark: "✓",
  degree: "°",
  therefore: "∴",
  because: "∵",
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  bigcup: "⋃",
  bigcap: "⋂",
  bigvee: "⋁",
  bigwedge: "⋀",
  bigoplus: "⨁",
  bigotimes: "⨂",
  bigsqcup: "⨆",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  gets: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  implies: "⟹",
  impliedby: "⟸",
  iff: "⟺",
  longrightarrow: "⟶",
  longleftarrow: "⟵",
  Longrightarrow: "⟹",
  Longleftarrow: "⟸",
  mapsto: "↦",
  longmapsto: "⟼",
  hookrightarrow: "↪",
  hookleftarrow: "↩",
  twoheadrightarrow: "↠",
  rightharpoonup: "⇀",
  rightleftharpoons: "⇌",
  uparrow: "↑",
  downarrow: "↓",
  updownarrow: "↕",
  Uparrow: "⇑",
  Downarrow: "⇓",
  nearrow: "↗",
  searrow: "↘",
  langle: "⟨",
  rangle: "⟩",
  lceil: "⌈",
  rceil: "⌉",
  lfloor: "⌊",
  rfloor: "⌋",
  lbrace: "{",
  rbrace: "}",
  lbrack: "[",
  rbrack: "]",
  vert: "|",
  lvert: "|",
  rvert: "|",
  Vert: "‖",
  lVert: "‖",
  rVert: "‖",
  backslash: "\\",
  ldots: "…",
  dots: "…",
  dotsc: "…",
  dotsb: "⋯",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  colon: ":",
  quad: "  ",
  qquad: "    ",
  enspace: " ",
  thinspace: " ",
  space: " ",
};

/** Named operators, set as their names. */
const OPERATORS = new Set(
  (
    "arccos arcsin arctan arg cos cosh cot coth csc deg det dim exp gcd hom inf ker lcm lg " +
    "lim liminf limsup ln log max min Pr sec sin sinh sup tan tanh"
  ).split(" "),
);

/** Control words that set nothing: sizes, styles, and spacing TeX adjusts by itself. */
const IGNORED = new Set(
  (
    "displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits nonumber notag " +
    "left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr " +
    "bigm Bigm normalsize small large Large tiny strut mathstrut negthinspace allowbreak"
  ).split(" "),
);

/** A combining mark each accent puts over (or under) a character. */
const ACCENTS: Record<string, string> = {
  hat: "̂",
  widehat: "̂",
  check: "̌",
  tilde: "̃",
  widetilde: "̃",
  bar: "̄",
  overline: "̅",
  underline: "̲",
  vec: "⃗",
  overrightarrow: "⃗",
  dot: "̇",
  ddot: "̈",
  acute: "́",
  grave: "̀",
  breve: "̆",
  mathring: "̊",
};

const SUPERSCRIPTS: Record<string, string> = {
  ...Object.fromEntries([..."0123456789"].map((digit, at) => [digit, "⁰¹²³⁴⁵⁶⁷⁸⁹"[at]!])),
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  ...Object.fromEntries(
    [..."abcdefghijklmnoprstuvwxyz"].map((letter, at) => [
      letter,
      [..."ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ"][at]!,
    ]),
  ),
  ...Object.fromEntries(
    [..."ABDEGHIJKLMNOPRTUVW"].map((letter, at) => [letter, [..."ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ"][at]!]),
  ),
  α: "ᵅ",
  β: "ᵝ",
  γ: "ᵞ",
  δ: "ᵟ",
  θ: "ᶿ",
  φ: "ᵠ",
  ϕ: "ᵠ",
  χ: "ᵡ",
  "⊤": "ᵀ",
};

const SUBSCRIPTS: Record<string, string> = {
  ...Object.fromEntries([..."0123456789"].map((digit, at) => [digit, "₀₁₂₃₄₅₆₇₈₉"[at]!])),
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  ...Object.fromEntries(
    [..."aehijklmnoprstuvx"].map((letter, at) => [letter, [..."ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"][at]!]),
  ),
  β: "ᵦ",
  γ: "ᵧ",
  ρ: "ᵨ",
  φ: "ᵩ",
  ϕ: "ᵩ",
  χ: "ᵪ",
};

/** What stays as it is in a superscript, being raised already: primes, stars, degrees. */
const RAISED = new Set(["′", "″", "‴", "*", "∗", "°", "†", "‡", "∘"]);

/** Mathematical alphabets: where A and a start, and the letters Unicode placed elsewhere. */
const ALPHABETS: Record<
  string,
  { upper: number; lower?: number; digits?: number; holes: Record<string, string> }
> = {
  mathbb: {
    upper: 0x1d538,
    lower: 0x1d552,
    digits: 0x1d7d8,
    holes: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
  },
  mathcal: {
    upper: 0x1d49c,
    lower: 0x1d4b6,
    holes: {
      B: "ℬ",
      E: "ℰ",
      F: "ℱ",
      H: "ℋ",
      I: "ℐ",
      L: "ℒ",
      M: "ℳ",
      R: "ℛ",
      e: "ℯ",
      g: "ℊ",
      o: "ℴ",
    },
  },
  mathfrak: {
    upper: 0x1d504,
    lower: 0x1d51e,
    holes: { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" },
  },
  mathbf: { upper: 0x1d400, lower: 0x1d41a, digits: 0x1d7ce, holes: {} },
};
ALPHABETS["mathscr"] = ALPHABETS["mathcal"]!;
ALPHABETS["boldsymbol"] = ALPHABETS["mathbf"]!;
ALPHABETS["bm"] = ALPHABETS["mathbf"]!;
ALPHABETS["textbf"] = ALPHABETS["mathbf"]!;

function alphabet(name: string, text: string): string {
  const letters = ALPHABETS[name];
  if (!letters) return text;
  return [...text]
    .map((char) => {
      const hole = letters.holes[char];
      if (hole) return hole;
      const code = char.codePointAt(0) ?? 0;
      if (code >= 65 && code <= 90) return String.fromCodePoint(letters.upper + code - 65);
      if (code >= 97 && code <= 122 && letters.lower !== undefined)
        return String.fromCodePoint(letters.lower + code - 97);
      if (code >= 48 && code <= 57 && letters.digits !== undefined)
        return String.fromCodePoint(letters.digits + code - 48);
      return char;
    })
    .join("");
}

/** Fractions with a character of their own. */
const VULGAR: Record<string, string> = {
  "1/2": "½",
  "1/3": "⅓",
  "2/3": "⅔",
  "1/4": "¼",
  "3/4": "¾",
  "1/5": "⅕",
  "1/6": "⅙",
  "1/8": "⅛",
};

/** Text that reads as one term, which a fraction or root needs no parentheses around. */
function single(text: string): boolean {
  if (/^[\p{L}\p{N}\p{M}.′√∛∜]+$/u.test(text)) return true;
  // One bracketed group, its opener closed by the last character.
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "⟨": "⟩" };
  const close = pairs[text[0] ?? ""];
  if (!close || !text.endsWith(close)) return false;
  let depth = 0;
  for (const [at, char] of [...text].entries()) {
    if (char === text[0]) depth++;
    else if (char === close && --depth === 0) return at === [...text].length - 1;
  }
  return false;
}

function grouped(text: string): string {
  return text === "" || single(text) ? text : `(${text})`;
}

/** Text raised or lowered with `table`'s characters, or marked with `mark` where some have none. */
function shifted(text: string, table: Record<string, string>, mark: string): string {
  const bare = text.replace(/\s+/g, "");
  if (bare === "") return "";
  if (mark === "^" && [...bare].every((char) => RAISED.has(char))) return bare;
  const chars = [...bare];
  if (chars.every((char) => table[char] !== undefined))
    return chars.map((char) => table[char]).join("");
  return chars.length === 1 ? `${mark}${bare}` : `${mark}(${bare})`;
}

/** Matrix environments and the brackets they set their rows in. */
const MATRICES: Record<string, [string, string]> = {
  matrix: ["", ""],
  smallmatrix: ["", ""],
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
};

/** The marker a row break leaves in converted text, between the lines of a display. */
const BREAK = "\n";

/**
 * Reads TeX into Unicode text. It never fails: what it does not know, it
 * sets as written, without the backslash, and a group still streaming closes
 * where the text ends.
 */
class Reader {
  #tex: string;
  #at = 0;

  constructor(tex: string) {
    this.#tex = tex;
  }

  /**
   * Everything up to the `}` that closes the group being read, or at the
   * `top`, up to the end, past any `}` that closes nothing.
   */
  sequence(top = false): string {
    let out = "";
    while (this.#at < this.#tex.length) {
      const char = this.#tex[this.#at]!;
      if (char === "}") {
        if (!top) return out;
        this.#at++;
        continue;
      }
      if (char === "^" || char === "_") {
        this.#at++;
        const script = this.#argument();
        out += shifted(script, char === "^" ? SUPERSCRIPTS : SUBSCRIPTS, char);
        continue;
      }
      out += this.#atom();
    }
    return out;
  }

  /** One thing: a group, a command, or a character. */
  #atom(): string {
    const char = this.#tex[this.#at]!;
    if (char === "{") return this.#group();
    if (char === "\\") return this.#command();
    this.#at++;
    if (char === "~") return " ";
    if (char === "&") return " ";
    if (char === "'") {
      // Primes run together: ′, ″, ‴.
      let count = 1;
      while (this.#tex[this.#at] === "'") {
        count++;
        this.#at++;
      }
      return ["′", "″", "‴"][Math.min(count, 3) - 1]!;
    }
    if (/\s/.test(char)) {
      while (/\s/.test(this.#tex[this.#at] ?? "")) this.#at++;
      return " ";
    }
    if (char === "-") return "−";
    return char;
  }

  #group(): string {
    this.#at++;
    const body = this.sequence();
    if (this.#tex[this.#at] === "}") this.#at++;
    return body;
  }

  #skipSpace(): void {
    while (/\s/.test(this.#tex[this.#at] ?? "")) this.#at++;
  }

  /** A command's argument: a group, or the one thing after it. */
  #argument(): string {
    this.#skipSpace();
    if (this.#at >= this.#tex.length) return "";
    const char = this.#tex[this.#at]!;
    if (char === "{") return this.#group();
    if (char === "}") return "";
    return this.#atom();
  }

  /** A group's text as written, for `\text` and names. */
  #raw(): string {
    this.#skipSpace();
    if (this.#tex[this.#at] !== "{") return this.#argument();
    let depth = 0;
    const start = this.#at + 1;
    for (; this.#at < this.#tex.length; this.#at++) {
      const char = this.#tex[this.#at];
      if (char === "\\") this.#at++;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) break;
    }
    const text = this.#tex.slice(start, this.#at);
    this.#at++;
    return text.replace(/\\([{}$%&#_ ])/g, "$1");
  }

  /** An optional `[…]` argument, as written. */
  #optional(): string | null {
    this.#skipSpace();
    if (this.#tex[this.#at] !== "[") return null;
    const end = this.#tex.indexOf("]", this.#at);
    if (end === -1) return null;
    const text = this.#tex.slice(this.#at + 1, end);
    this.#at = end + 1;
    return new Reader(text).sequence();
  }

  #command(): string {
    this.#at++;
    const word = /^[A-Za-z]+/.exec(this.#tex.slice(this.#at))?.[0];
    if (!word) {
      // A control symbol: an escaped character, or spacing.
      const char = this.#tex[this.#at] ?? "";
      this.#at++;
      if (char === "\\") return BREAK;
      if (char === "," || char === ":" || char === ";" || char === " ") return " ";
      if (char === "!") return "";
      if (char === "|") return "‖";
      return char;
    }
    this.#at += word.length;
    // A starred form, such as `\operatorname*`, reads as the plain one.
    if (this.#tex[this.#at] === "*") this.#at++;
    const symbol = SYMBOLS[word];
    if (symbol !== undefined) return symbol;
    if (OPERATORS.has(word)) return word;
    if (IGNORED.has(word)) {
      // `\left.` sizes an empty delimiter.
      if (/^(?:left|right|middle|big|Big|bigg|Bigg)/.test(word)) {
        this.#skipSpace();
        if (this.#tex[this.#at] === ".") this.#at++;
      }
      return "";
    }
    const accent = ACCENTS[word];
    if (accent) {
      const body = this.#argument();
      const chars = [...body];
      if (word === "overline" || word === "underline")
        return chars.map((char) => char + accent).join("");
      return chars.length === 0 ? "" : body + accent;
    }
    if (ALPHABETS[word] && word !== "textbf") return alphabet(word, this.#argument());
    switch (word) {
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac": {
        const top = this.#argument().trim();
        const bottom = this.#argument().trim();
        return VULGAR[`${top}/${bottom}`] ?? `${grouped(top)}/${grouped(bottom)}`;
      }
      case "binom":
      case "dbinom":
      case "tbinom": {
        const top = this.#argument().trim();
        const bottom = this.#argument().trim();
        return `C(${top}, ${bottom})`;
      }
      case "sqrt": {
        const index = this.#optional()?.trim();
        const body = this.#argument().trim();
        const root =
          index === "3"
            ? "∛"
            : index === "4"
              ? "∜"
              : index
                ? `${shifted(index, SUPERSCRIPTS, "^")}√`
                : "√";
        return root + grouped(body);
      }
      case "text":
      case "textrm":
      case "textit":
      case "textbf":
      case "textsf":
      case "texttt":
      case "textnormal":
      case "mbox":
      case "hbox":
        return this.#raw();
      case "mathrm":
      case "mathit":
      case "mathsf":
      case "mathtt":
      case "mathnormal":
      case "operatorname":
        return this.#raw().replace(/\\,|\\ /g, " ");
      case "not": {
        const next = this.#argument();
        const negated: Record<string, string> = {
          "=": "≠",
          "∈": "∉",
          "≡": "≢",
          "<": "≮",
          ">": "≯",
          "≤": "≰",
          "≥": "≱",
          "⊂": "⊄",
          "⊆": "⊈",
          "∼": "≁",
          "≈": "≉",
        };
        return negated[next] ?? `${next}̸`;
      }
      case "bmod":
      case "mod":
        return " mod ";
      case "pmod":
        return ` (mod ${this.#argument().trim()})`;
      case "tag":
        return `  (${this.#raw()})`;
      case "label":
      case "color":
      case "hspace":
      case "vspace":
      case "phantom":
      case "hphantom":
      case "vphantom":
        this.#raw();
        return word.endsWith("space") || word.endsWith("phantom") ? " " : "";
      case "textcolor":
      case "colorbox":
        this.#raw();
        return this.#argument();
      case "boxed":
      case "fbox":
        return `[${this.#argument()}]`;
      case "overbrace":
      case "underbrace":
      case "underset":
      case "overset":
      case "stackrel":
        if (word.endsWith("set") || word === "stackrel") {
          this.#argument();
          return this.#argument();
        }
        return this.#argument();
      case "begin":
        return this.#environment(this.#raw());
      case "end":
        // An end with no begin before it, as when a display starts mid-environment.
        this.#raw();
        return "";
      default:
        return word;
    }
  }

  /** An environment's body, up to its `\end`: matrices bracketed in a line, the rest as lines. */
  #environment(name: string): string {
    const bare = name.replace(/\*$/, "");
    // An array's column spec is not content.
    if (bare === "array" || bare === "alignat") this.#raw();
    const rows = splitTop(this.#body(name), "\\\\")
      .map((row) => splitTop(row, "&").map((cell) => tidy(new Reader(cell).sequence(true))))
      .filter((cells) => cells.some((cell) => cell !== ""));
    const brackets = MATRICES[bare];
    if (brackets)
      return `${brackets[0]}${rows.map((cells) => cells.join(" ")).join("; ")}${brackets[1]}`;
    if (bare === "cases" || bare === "dcases")
      return `{ ${rows.map((cells) => cells.filter(Boolean).join(", ")).join("; ")} }`;
    // Aligned rows line up at their `&`s: columns in pairs, right then left, as `align` sets them.
    const widths: number[] = [];
    for (const cells of rows)
      cells.forEach((cell, column) => {
        widths[column] = Math.max(widths[column] ?? 0, visibleWidth(cell));
      });
    return rows
      .map((cells) =>
        cells
          .map((cell, column) => {
            const pad = " ".repeat((widths[column] ?? 0) - visibleWidth(cell));
            if (cells.length === 1) return cell;
            return column % 2 === 0 ? pad + cell : column === cells.length - 1 ? cell : cell + pad;
          })
          .join(" "),
      )
      .join(BREAK);
  }

  /** The text up to the `\end{name}` that closes `\begin{name}`, nested ones included. */
  #body(name: string): string {
    const start = this.#at;
    let depth = 1;
    const tag = /\\(begin|end)\s*\{([^}]*)\}/g;
    tag.lastIndex = this.#at;
    for (let match = tag.exec(this.#tex); match; match = tag.exec(this.#tex)) {
      if (match[2] !== name) continue;
      depth += match[1] === "begin" ? 1 : -1;
      if (depth === 0) {
        this.#at = tag.lastIndex;
        return this.#tex.slice(start, match.index);
      }
    }
    this.#at = this.#tex.length;
    return this.#tex.slice(start);
  }
}

/** Text with its spaces evened out, and none just inside brackets, as `\left( x \right)` leaves. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([([{⟨]) /g, "$1")
    .replace(/ ([)\]}⟩])/g, "$1")
    .trim();
}

/**
 * TeX split at each `separator` outside groups and environments, as an
 * environment's rows at `\\` and their cells at `&`.
 */
function splitTop(tex: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < tex.length; at++) {
    if (tex.startsWith("\\begin", at)) depth++;
    else if (tex.startsWith("\\end", at)) depth--;
    if (depth === 0 && tex.startsWith(separator, at)) {
      parts.push(tex.slice(from, at));
      at += separator.length - 1;
      from = at + 1;
      continue;
    }
    const char = tex[at];
    if (char === "\\") at++;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  parts.push(tex.slice(from));
  return parts;
}

/** TeX as lines of Unicode text: one for most, one per row of an aligned display or cases. */
export function texLines(tex: string): string[] {
  return new Reader(tex.trim())
    .sequence(true)
    .split(BREAK)
    .map((line) => (/^ {2,}/.test(line) ? line.trimEnd() : tidy(line)))
    .filter((line) => line.trim() !== "");
}

/** TeX as one line of Unicode text, its rows set apart by semicolons. */
export function texToUnicode(tex: string): string {
  return texLines(tex).join("; ");
}

// —— Typesetting ——

/** What a typeset equation's em is, as a share of a cell's height: a little larger than text. */
const EM_SHARE = 0.9;

/** The most an equation is scaled up to fill the screen, past which it looks blown up. */
const MOST_ZOOM = 4;

/** Equations the renderer keeps, typeset and drawn; the oldest go first. */
const KEPT = 256;

/** Colors for an equation's ink, those of prose in the dark and light palettes. */
const INK = { dark: "#d0d0d0", light: "#444444" };

/** TeX packages: what a reply's math is likely to use, without what needs a browser. */
const PACKAGES = [
  "base",
  "ams",
  "newcommand",
  "boldsymbol",
  "braket",
  "cancel",
  "cases",
  "mathtools",
  "textmacros",
  "mhchem",
];

type Typeset = (tex: string) => Promise<string | null>;

/**
 * MathJax, loaded when the first equation needs it: TeX in, SVG out, with
 * glyphs as paths so no font is needed to draw it. Its font's glyph data
 * loads as equations need it, so a conversion may wait on a file.
 */
async function loadMathJax(): Promise<Typeset> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] =
    await Promise.all([
      import("@mathjax/src/js/mathjax.js"),
      import("@mathjax/src/js/input/tex.js"),
      import("@mathjax/src/js/output/svg.js"),
      import("@mathjax/src/js/adaptors/liteAdaptor.js"),
      import("@mathjax/src/js/handlers/html.js"),
      import("@mathjax/src/js/util/asyncLoad/esm.js"),
    ]);
  await Promise.all([
    import("@mathjax/src/js/input/tex/base/BaseConfiguration.js"),
    import("@mathjax/src/js/input/tex/ams/AmsConfiguration.js"),
    import("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js"),
    import("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js"),
    import("@mathjax/src/js/input/tex/braket/BraketConfiguration.js"),
    import("@mathjax/src/js/input/tex/cancel/CancelConfiguration.js"),
    import("@mathjax/src/js/input/tex/cases/CasesConfiguration.js"),
    import("@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js"),
    import("@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js"),
    import("@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js"),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    InputJax: new TeX({ packages: PACKAGES }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  // One at a time: a conversion that waits on glyph data is retried whole.
  let queue: Promise<unknown> = Promise.resolve();
  return (tex) => {
    const done = queue.then(async () => {
      try {
        const node = await mathjax.handleRetriesFor(() => document.convert(tex, { display: true }));
        const svg = adaptor.innerHTML(node);
        // TeX it could not read comes back as an error in the picture; it reads better as text.
        return /data-mml-node="merror"/.test(svg) ? null : svg;
      } catch {
        return null;
      }
    });
    queue = done;
    return done;
  };
}

/** An equation's SVG at its natural size for `em` pixels: its viewBox is a thousand units an em. */
function naturalSize(svg: string, em: number): { width: number; height: number } | null {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) return null;
  return { width: (Number(box[1]) / 1000) * em, height: (Number(box[2]) / 1000) * em };
}

/**
 * Typesets and keeps equations. MathJax and resvg load in the background
 * when the first equation comes; each equation is typeset once, off the
 * frame, and drawn again only for a new size or theme. Until it is typeset,
 * `picture` says so, and `onReady` is called once there is more to show.
 */
export class Equations implements FigureRenderer {
  #onReady: () => void;
  /** MathJax and resvg, loading or loaded: what typesets, or null when either cannot. */
  #engine: Promise<Typeset | null> | null = null;
  #broken = false;
  /** Each equation's SVG, by its TeX: null when it cannot be typeset. */
  #svgs = new FetchCache<string, string | null>({ limit: KEPT, arrived: () => this.#onReady() });
  #pictures = new BoundedMap<string, Picture | null>(KEPT);

  constructor(onReady: () => void) {
    this.#onReady = onReady;
  }

  /**
   * The picture of an equation set for cells of `cell` pixels and at most
   * `width` pixels wide, or as large as fits `width` by `fill` pixels:
   * undefined while it is typeset, null when it cannot be.
   */
  picture(
    tex: string,
    light: boolean,
    width: number,
    cell: CellSize,
    fill?: number,
  ): Picture | null | undefined {
    const svg = this.#svg(tex.trim());
    if (typeof svg !== "string") return svg === null ? null : undefined;
    const em = cell.height * EM_SHARE;
    const natural = naturalSize(svg, em);
    if (!natural) return null;
    const scale =
      fill === undefined
        ? Math.min(1, width / natural.width)
        : Math.min(MOST_ZOOM, width / natural.width, fill / natural.height);
    const drawnWidth = Math.max(1, Math.round(natural.width * scale));
    const drawnHeight = Math.max(1, Math.round(natural.height * scale));
    // Drawn again only for a new size, cell, or theme: a wider screen alone changes nothing.
    const key = `${light ? "light" : "dark"}\0${drawnWidth}x${drawnHeight}\0${cell.width}x${cell.height}\0${tex}`;
    const known = this.#pictures.get(key);
    if (known !== undefined) return known;
    const inked = svg.replace(/currentColor/g, INK[light ? "light" : "dark"]);
    // Rasterized once sent, as a diagram is.
    const drawn = drawLater(onCells(inked, drawnWidth, drawnHeight, cell), () => {
      // Drawn as text instead, once the views draw again.
      this.#pictures.set(key, null);
      this.#onReady();
    });
    this.#pictures.set(key, drawn);
    return drawn;
  }

  /** The equation as lines of Unicode text, for a terminal without graphics. */
  text(tex: string): string[] | null {
    const lines = texLines(tex);
    return lines.length > 0 ? lines : null;
  }

  get available(): boolean {
    return !this.#broken;
  }

  /** An equation's SVG, typeset in the background on first asking. */
  #svg(tex: string): string | null | undefined {
    return this.#svgs.get(tex, async () => {
      const typeset = await this.#load();
      return typeset ? typeset(tex) : null;
    });
  }

  #load(): Promise<Typeset | null> {
    this.#engine ??= (async () => {
      try {
        const [typeset, ready] = await Promise.all([loadMathJax(), loadResvg()]);
        if (ready) return typeset;
      } catch {
        // Without MathJax, every equation is text.
      }
      this.#broken = true;
      return null;
    })();
    return this.#engine;
  }
}
