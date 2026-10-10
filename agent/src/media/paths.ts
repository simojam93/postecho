import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

/**
 * Where a post's media live (media from a repo, 2026-10-11): `~/.postecho/media/<draftId>/`. Nothing is
 * uploaded; the wake server serves the files to the page (wake-server.ts).
 */
export const MEDIA_DIR = join(homedir(), ".postecho", "media");

const DRAFT_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A plain file name: starts with a letter or digit, then letters, digits, dots, dashes and underscores. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The draft's media folder, or null for an id that isn't one (anything that could leave `base`). */
export function mediaDirFor(base: string, draftId: string): string | null {
  return DRAFT_ID.test(draftId) ? join(base, draftId) : null;
}

/**
 * The file's path in the draft's media folder, or null when the name isn't a plain file name: no
 * slash, no `..`, nothing absolute or hidden. The result is checked to sit inside the folder too.
 */
export function mediaFilePath(base: string, draftId: string, file: string): string | null {
  const dir = mediaDirFor(base, draftId);
  if (!dir || !FILE_NAME.test(file) || file.includes("..")) return null;
  const path = resolve(dir, file);
  return path.startsWith(resolve(dir) + sep) ? path : null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

/** The content type the wake server sends a media file with; null for anything it doesn't serve. */
export function contentTypeOf(file: string): string | null {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? null;
}

/** An image a post can carry as it is: PNG, JPEG, GIF or WebP (no SVG, which X and LinkedIn don't take). */
export function isImageFile(file: string): boolean {
  return contentTypeOf(file)?.startsWith("image/") ?? false;
}
