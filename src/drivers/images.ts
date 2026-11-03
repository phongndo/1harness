import { readFileSync } from "node:fs";
import { extname } from "node:path";

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const IMAGE_TYPES: Record<string, ImageType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A local image to send, with its type by its extension. Read before a turn
 * begins, so an image that cannot be read fails the send, not the turn.
 */
export function readImage(path: string): { type: ImageType; data: string } {
  return {
    type: IMAGE_TYPES[extname(path).toLowerCase()] ?? "image/png",
    data: readFileSync(path).toString("base64"),
  };
}
