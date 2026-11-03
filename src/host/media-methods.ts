import { errorMessage } from "../core/errors.ts";
import { RpcError } from "../protocol.ts";
import type { Handlers } from "./clients.ts";
import type { LivePages } from "./live.ts";
import { fileImage, type Media } from "./media.ts";

type MediaMethod =
  | "files.image"
  | "page.open"
  | "page.frame"
  | "page.input"
  | "page.resize"
  | "page.close"
  | "media.html";

/** What a page or picture drew, or why it could not, as the client is told. */
async function rendered<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new RpcError("render_failed", errorMessage(error));
  }
}

/** The requests that draw images and pages for clients, and run pages kept live for them. */
export function mediaMethods(media: Media, live: LivePages): Pick<Handlers, MediaMethod> {
  return {
    "files.image": async (_client, { path, width, height }) =>
      fileImage(media, path, width, height),
    "page.open": async (client, { html, width, height, scale, dark }) =>
      rendered(() =>
        live.open(client.id, html, {
          width,
          ...(height ? { height } : {}),
          scale,
          dark,
        }),
      ),
    "page.frame": async (_client, { id }) => rendered(() => live.frame(id)),
    "page.input": async (_client, { id, event }) => rendered(() => live.input(id, event)),
    "page.resize": async (_client, { id, width, height, scale }) =>
      rendered(() => live.resize(id, width, height, scale)),
    "page.close": async (_client, { id }) => {
      await live.close(id);
      return null;
    },
    "media.html": async (_client, { html, width, scale, dark, transparent }) =>
      rendered(async () => {
        const png = await media.html(html, {
          width,
          scale,
          dark,
          transparent: transparent === true,
        });
        return { data: png.toString("base64") };
      }),
  };
}
