import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  fit,
  picture,
  pictureLater,
  placeVirtually,
  placeholderRow,
  pngSize,
  transmit,
} from "./images.ts";
import { InputDecoder } from "./input.ts";
import { Screen } from "./screen.ts";
import { visibleWidth } from "./text.ts";
import { Transcript } from "./transcript.ts";

/** A solid-color PNG of a size, as the tests need one. */
/** A PNG chunk; the CRC is left zero, which the size reader does not check. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

export function solidPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const media = { graphics: true, cell: { width: 8, height: 16 }, maxRows: 20 };

describe("images", () => {
  it("draws a picture laid out ahead only once it is read, and once", () => {
    let drawn = 0;
    const later = pictureLater(40, 30, () => {
      drawn++;
      return solidPng(40, 30);
    });
    assert.equal(drawn, 0);
    assert.notEqual(later.id, picture(solidPng(1, 1))?.id);
    assert.ok(transmit(later).startsWith("\x1b_Ga=t"));
    assert.equal(later.data, Buffer.from(solidPng(40, 30)).toString("base64"));
    assert.equal(drawn, 1);
  });

  it("reads a PNG's size and turns anything else away", () => {
    assert.deepEqual(pngSize(solidPng(40, 30)), { width: 40, height: 30 });
    assert.equal(picture(Buffer.from("GIF89a not a png at all")), null);
  });

  it("fits an image to the column and the rows allowed, keeping its shape", () => {
    // Small: as it is, 40 by 32 pixels in 8 by 16 cells.
    assert.deepEqual(fit({ pixelWidth: 40, pixelHeight: 32 }, 96, media), { columns: 5, rows: 2 });
    // Wide: the column's width, and shorter in proportion.
    assert.deepEqual(fit({ pixelWidth: 1600, pixelHeight: 400 }, 96, media), {
      columns: 96,
      rows: 12,
    });
    // Tall: the rows allowed, and narrower in proportion.
    assert.deepEqual(fit({ pixelWidth: 400, pixelHeight: 1600 }, 96, media), {
      columns: 10,
      rows: 20,
    });
  });

  it("sends a picture in chunks, and shows it in placeholder cells", () => {
    const shown = picture(solidPng(300, 300))!;
    const sent = transmit(shown);
    assert.match(sent, new RegExp(`^\\x1b_Ga=t,f=100,t=d,i=${shown.id},q=2,m=`));
    assert.ok(sent.endsWith("\x1b\\"));
    assert.equal(
      placeVirtually({ picture: shown, columns: 10, rows: 5 }),
      `\x1b_Ga=p,U=1,i=${shown.id},p=1,c=10,r=5,q=2\x1b\\`,
    );
    // A row of placeholders: one column a cell, in the color naming the picture.
    const row = placeholderRow(shown, 3, 10);
    assert.equal(visibleWidth(row), 10);
    assert.ok(row.startsWith(`\x1b[38;2;0;0;${shown.id}m\u{10EEEE}`));
    assert.equal(row.split("\u{10EEEE}").length - 1, 10);
  });

  it("decodes the terminal's answers about graphics and cell size", () => {
    const events = new InputDecoder().feed("\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t");
    assert.deepEqual(events, [
      { type: "graphics", ok: true },
      { type: "cellSize", width: 8, height: 16 },
    ]);
  });

  it("keeps an image's rows in the transcript as placeholders, and lists it while in view", () => {
    const transcript = new Transcript();
    const shown = picture(solidPng(160, 160))!;
    transcript.add({ kind: "assistant", text: "Here it is." });
    transcript.add({ kind: "image", picture: shown, title: "square.png" });
    transcript.add({ kind: "assistant", text: "After it." });
    const context = { width: 60, cwd: "/", blink: true, now: 0, media };
    const whole = transcript.view(context, 40, 0);
    // The reply, a blank row, ten rows of picture, its caption, a blank row, and the next reply.
    assert.equal(whole.total, 1 + 1 + 10 + 1 + 1 + 1);
    for (const row of whole.rows.slice(2, 12)) assert.equal(visibleWidth(row), 2 + 20);
    assert.equal(stripVTControlCharacters(whole.rows[12] ?? ""), "  square.png · 160×160");
    assert.deepEqual(whole.pictures, [{ picture: shown, columns: 20, rows: 10 }]);
    // Scrolled so only its lower rows show, it is still in view.
    assert.equal(transcript.view(context, 6, 0).pictures.length, 1);
    // Out of view, nothing of it needs sending.
    assert.equal(transcript.view(context, 2, 0).pictures.length, 0);
    // A terminal without graphics shows the caption alone.
    const text = transcript.view({ ...context, media: { ...media, graphics: false } }, 40, 0);
    assert.equal(text.pictures.length, 0);
    assert.match(stripVTControlCharacters(text.rows[2] ?? ""), /this terminal shows no images/);
  });

  it("shows an image file drawn for the cells it fills, and its first picture until that comes", () => {
    const transcript = new Transcript();
    const first = picture(solidPng(160, 160))!;
    const sharper = picture(solidPng(320, 320))!;
    transcript.add({ kind: "image", picture: first, path: "/w/square.png", title: "square.png" });
    let fetched: typeof sharper | undefined;
    const context = {
      width: 60,
      cwd: "/",
      blink: true,
      now: 0,
      media,
      image: (path: string) => (path === "/w/square.png" ? fetched : null),
    };
    assert.deepEqual(transcript.view(context, 40, 0).pictures[0]?.picture, first);
    fetched = sharper;
    const bigger = { ...context, media: { ...media, cell: { width: 16, height: 32 } } };
    assert.deepEqual(transcript.view(bigger, 40, 0).pictures[0]?.picture, sharper);
  });

  it("sends a picture's new frame under its ID, and places it again", () => {
    let written = "";
    const out = { columns: 80, rows: 24, write: (data: string) => (written += data) };
    const screen = new Screen(out as unknown as NodeJS.WriteStream);
    screen.enter();
    const live = picture(solidPng(80, 80))!;
    const count = (pattern: string) => written.split(pattern).length - 1;
    screen.render(["a"], null, [{ picture: live, columns: 10, rows: 5 }]);
    screen.render(["a"], null, [{ picture: live, columns: 10, rows: 5 }]);
    assert.equal(count("a=t,"), 1, "the same frame goes once");
    live.version = 1;
    screen.render(["a"], null, [{ picture: live, columns: 10, rows: 5 }]);
    assert.equal(count("a=t,"), 2, "the new frame is sent");
    assert.equal(count("a=p,U=1"), 2, "and placed");
  });

  it("deletes the pictures shown longest ago past its budget, and sends one again when shown", () => {
    let written = "";
    const out = { columns: 80, rows: 24, write: (data: string) => (written += data) };
    // Room for two 10×10 pictures, decoded.
    const screen = new Screen(out as unknown as NodeJS.WriteStream, 800);
    screen.enter();
    const [a, b, c] = [1, 2, 3].map(() => picture(solidPng(10, 10))!);
    const show = (one: typeof a) =>
      screen.render([`${one!.id}`], null, [{ picture: one!, columns: 2, rows: 1 }]);
    show(a);
    show(b);
    assert.doesNotMatch(written, /a=d,d=I/);
    show(c);
    assert.match(written, new RegExp(`a=d,d=I,i=${a!.id},`), "the oldest goes");
    written = "";
    show(a);
    assert.match(written, new RegExp(`a=t,f=100,t=d,i=${a!.id},`), "and comes back when shown");
  });

  it("sends a picture once, and places it again only at a new size", () => {
    let written = "";
    const out = { columns: 80, rows: 24, write: (data: string) => (written += data) };
    const screen = new Screen(out as unknown as NodeJS.WriteStream);
    screen.enter();
    const shown = picture(solidPng(80, 80))!;
    const count = (pattern: string) => written.split(pattern).length - 1;
    screen.render(["a"], null, [{ picture: shown, columns: 10, rows: 5 }]);
    screen.render(["b"], null, [{ picture: shown, columns: 10, rows: 5 }]);
    assert.equal(count("a=t,"), 1, "sent once");
    assert.equal(count("a=p,U=1"), 1, "placed once at that size");
    screen.render(["c"], null, [{ picture: shown, columns: 12, rows: 6 }]);
    assert.equal(count("a=t,"), 1, "not sent again");
    assert.equal(count("a=p,U=1"), 2, "placed again at the new size");
    // Sent ahead of the text that shows it.
    assert.ok(written.indexOf("a=t,") < written.indexOf("a\x1b[0m"));
  });
});
