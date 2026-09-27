/**
 * A Video posts card (owner, 2026-09-27: "penso che semplicemente andrebbero
 * creati già dei post X pronti all'attacco senza titolo"): a video_idea row
 * whose content is a ready X post, marked meta.format "post" by
 * lib/materialize.ts. Use makes it the post's chosen version as it is, and
 * Write opens on the editor with no takes ("non penso servano i tre takes se
 * ne ho già scelto uno"). Its voice is the owner's own (lib/voice.ts):
 * "come se fossero idee mie". Rows from before are a topic, a title and a
 * summary, and Use still writes takes from them. Pure: the cards use it too.
 */
export const VIDEO_POST_FORMAT = "post";

export function isVideoPost(idea: { kind: string; meta: { format?: unknown } } | null | undefined): boolean {
  return idea?.kind === "video_idea" && idea.meta.format === VIDEO_POST_FORMAT;
}
