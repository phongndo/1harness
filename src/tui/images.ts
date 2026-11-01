// Images in the transcript, drawn with the Kitty graphics protocol, which Rex,
// kitty, and Ghostty speak. A PNG is sent to the terminal once, by an ID, with
// a virtual placement; its block's rows are then placeholder characters, text
// the terminal draws the picture in, so it scrolls and redraws like text. Rex
// keeps pictures shown this way, where it drops ones placed over the cells.

/** A cell's size in pixels, as terminals that report it usually have it. */
export const DEFAULT_CELL = { width: 8, height: 16 };

/** The most rows an image takes, as a share of the screen, so a tall one does not fill it. */
const SCREEN_SHARE = 0.6;

export interface CellSize {
  width: number;
  height: number;
}

/** What the transcript needs to lay images out: whether they show, and the cells they fill. */
export interface MediaContext {
  graphics: boolean;
  cell: CellSize;
  /** The most rows one image may take. */
  maxRows: number;
}

/** An image as the transcript keeps it: a PNG, its ID with the terminal, and its size. */
export interface Picture {
  id: number;
  /** The PNG, base64-encoded, as the protocol sends it. */
  data: string;
  pixelWidth: number;
  pixelHeight: number;
  /** Counts new frames of a picture that changes, as a live page's does: each is sent again. */
  version?: number;
}

/** A picture in a view, at the size its block lays it out, which the screen sends ahead of the text. */
export interface Shown {
  picture: Picture;
  columns: number;
  rows: number;
}

let nextId = 1;

/** The width and height a PNG's header gives, or null when the data is no PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The IHDR chunk comes first: length, type, then width and height.
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A picture from PNG bytes, with an ID of its own; null when the bytes are not a PNG. */
export function picture(bytes: Uint8Array): Picture | null {
  const size = pngSize(bytes);
  if (!size || size.width === 0 || size.height === 0) return null;
  return {
    id: nextId++,
    data: Buffer.from(bytes).toString("base64"),
    pixelWidth: size.width,
    pixelHeight: size.height,
  };
}

/** The most rows an image takes on a screen of `height` rows. */
export function maxImageRows(height: number): number {
  return Math.max(4, Math.floor(height * SCREEN_SHARE));
}

/**
 * The cells an image fills: as wide as it is, up to `columns`, and no taller
 * than the media allows, keeping its shape. Never wider than it is, so a small
 * image stays small.
 */
export function fit(
  image: Pick<Picture, "pixelWidth" | "pixelHeight">,
  columns: number,
  media: MediaContext,
): { columns: number; rows: number } {
  const { cell } = media;
  let scale = Math.min(1, (columns * cell.width) / image.pixelWidth);
  scale = Math.min(scale, (media.maxRows * cell.height) / image.pixelHeight);
  // Placeholders name rows and columns up to their table's length.
  return {
    columns: Math.min(297, Math.max(1, Math.round((image.pixelWidth * scale) / cell.width))),
    rows: Math.min(297, Math.max(1, Math.round((image.pixelHeight * scale) / cell.height))),
  };
}

/** Bytes of base64 per chunk the protocol takes. */
const CHUNK = 4096;

/** Sends a picture to the terminal by its ID, in chunks, to place later; asks for no reply. */
export function transmit(image: Picture): string {
  let out = "";
  for (let at = 0; at < image.data.length; at += CHUNK) {
    const more = at + CHUNK < image.data.length ? 1 : 0;
    const keys = at === 0 ? `a=t,f=100,t=d,i=${image.id},q=2,m=${more}` : `m=${more}`;
    out += `\x1b_G${keys};${image.data.slice(at, at + CHUNK)}\x1b\\`;
  }
  return out;
}

/**
 * Kitty's marks for a placeholder's row and column, in order: the 297
 * combining characters of rowcolumn-diacritics.txt, as hex code points.
 */
const DIACRITICS = `
  0305 030d 030e 0310 0312 033d 033e 033f 0346 034a 034b 034c 0350 0351 0352 0357
  035b 0363 0364 0365 0366 0367 0368 0369 036a 036b 036c 036d 036e 036f 0483 0484
  0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059c 059d 059e 059f 05a0 05a1
  05a8 05a9 05ab 05ac 05af 05c4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658
  0659 065a 065b 065d 065e 06d6 06d7 06d8 06d9 06da 06db 06dc 06df 06e0 06e1 06e2
  06e4 06e7 06e8 06eb 06ec 0730 0732 0733 0735 0736 073a 073d 073f 0740 0741 0743
  0745 0747 0749 074a 07eb 07ec 07ed 07ee 07ef 07f0 07f1 07f3 0816 0817 0818 0819
  081b 081c 081d 081e 081f 0820 0821 0822 0823 0825 0826 0827 0829 082a 082b 082c
  082d 0951 0953 0954 0f82 0f83 0f86 0f87 135d 135e 135f 17dd 193a 1a17 1a75 1a76
  1a77 1a78 1a79 1a7a 1a7b 1a7c 1b6b 1b6d 1b6e 1b6f 1b70 1b71 1b72 1b73 1cd0 1cd1
  1cd2 1cda 1cdb 1ce0 1dc0 1dc1 1dc3 1dc4 1dc5 1dc6 1dc7 1dc8 1dc9 1dcb 1dcc 1dd1
  1dd2 1dd3 1dd4 1dd5 1dd6 1dd7 1dd8 1dd9 1dda 1ddb 1ddc 1ddd 1dde 1ddf 1de0 1de1
  1de2 1de3 1de4 1de5 1de6 1dfe 20d0 20d1 20d4 20d5 20d6 20d7 20db 20dc 20e1 20e7
  20e9 20f0 2cef 2cf0 2cf1 2de0 2de1 2de2 2de3 2de4 2de5 2de6 2de7 2de8 2de9 2dea
  2deb 2dec 2ded 2dee 2def 2df0 2df1 2df2 2df3 2df4 2df5 2df6 2df7 2df8 2df9 2dfa
  2dfb 2dfc 2dfd 2dfe 2dff a66f a67c a67d a6f0 a6f1 a8e0 a8e1 a8e2 a8e3 a8e4 a8e5
  a8e6 a8e7 a8e8 a8e9 a8ea a8eb a8ec a8ed a8ee a8ef a8f0 a8f1 aab0 aab2 aab3 aab7
  aab8 aabe aabf aac1 fe20 fe21 fe22 fe23 fe24 fe25 fe26 10a0f 10a38 1d185 1d186 1d187
  1d188 1d189 1d1aa 1d1ab 1d1ac 1d1ad 1d242 1d243 1d244
`
  .trim()
  .split(/\s+/)
  .map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)));

/** The most rows or columns a placeholder can name. */
export const PLACEHOLDER_LIMIT = DIACRITICS.length;

/** The character a Kitty placeholder cell is drawn with, in the private use plane. */
export const PLACEHOLDER = "\u{10EEEE}";

/**
 * Tells the terminal where a picture goes: a virtual placement of `columns`
 * by `rows` cells, which placeholder characters in the text then show. The
 * picture lives in the text, so it scrolls and redraws as text does.
 */
export function placeVirtually(shown: Shown): string {
  const { picture: image, columns, rows } = shown;
  return `\x1b_Ga=p,U=1,i=${image.id},p=1,c=${columns},r=${rows},q=2\x1b\\`;
}

/**
 * One row of a picture as placeholder characters: each cell marked with its
 * row and column, in the foreground color that names the picture's ID.
 */
export function placeholderRow(image: Picture, row: number, columns: number): string {
  const id = image.id;
  const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  let cells = "";
  const rowMark = DIACRITICS[Math.min(row, PLACEHOLDER_LIMIT - 1)] ?? "";
  for (let column = 0; column < columns; column++)
    cells += PLACEHOLDER + rowMark + (DIACRITICS[Math.min(column, PLACEHOLDER_LIMIT - 1)] ?? "");
  return `${color}${cells}\x1b[39m`;
}

/** Drops every picture the terminal keeps, with what shows them. */
/** Deletes one picture from the terminal, its data with it. */
export function deleteImage(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

export function clearImages(): string {
  return `\x1b_Ga=d,d=A,q=2\x1b\\`;
}

/** The query that asks whether the terminal speaks the Kitty graphics protocol. */
export const GRAPHICS_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";

/** The query that asks a terminal for its cell size in pixels. */
export const CELL_QUERY = "\x1b[16t";
