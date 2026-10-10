/**
 * Media from a repo (docs/specs/2026-10-11-media-from-a-repo-design.md): a post's images, card,
 * screenshots or video, made by the agent on the owner's computer and listed in the draft's
 * `meta.media`. Since 2026-10-11 a card for every post, and the source's preview image when it has
 * one. Pure: the page uses it too.
 */

/** What the owner can ask for, and what an item is. */
export const MEDIA_KINDS = ["images", "card", "screenshots", "video", "source_image"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaItemKind = "image" | "card" | "screenshot" | "video";

/** One file in `drafts.meta.media`. */
export type MediaItem = { file: string; kind: MediaItemKind; caption?: string; kept: boolean; jobId: string };

/**
 * What a post can ask for. A card for every post. Images come from a post's repository. Screenshots and
 * a video run the project's code: only for a folder on this computer, never a stranger's repository.
 * The source's image when the post's source has one.
 */
export function mediaKindsFor({ repo, sourceImage }: { repo: "folder" | "github" | null; sourceImage: boolean }): MediaKind[] {
  const kinds: MediaKind[] = repo === "folder" ? ["images", "card", "screenshots", "video"] : repo === "github" ? ["images", "card"] : ["card"];
  return sourceImage ? [...kinds, "source_image"] : kinds;
}

/** The draft's media list, whatever `meta.media` holds: anything that isn't an item is left out. */
export function mediaOf(meta: Record<string, unknown> | null | undefined): MediaItem[] {
  const list = meta?.media;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): MediaItem[] => {
    if (!item || typeof item !== "object") return [];
    const { file, kind, caption, kept, jobId } = item as Record<string, unknown>;
    if (typeof file !== "string" || !["image", "card", "screenshot", "video"].includes(kind as string)) return [];
    return [{
      file,
      kind: kind as MediaItemKind,
      ...(typeof caption === "string" && caption ? { caption } : {}),
      kept: kept === true,
      jobId: typeof jobId === "string" ? jobId : "",
    }];
  });
}

/** A claimed job is put back in the queue after this (api/agent/jobs). */
export const STALE_CLAIM_MS = 10 * 60 * 1000;
/** Screenshots and videos run for up to 40 minutes on the agent (its worker.ts's budget): they get 45. */
export const LONG_STALE_CLAIM_MS = 45 * 60 * 1000;
/** The post_media kinds that take that long. */
export const LONG_MEDIA_KINDS: MediaKind[] = ["screenshots", "video"];
