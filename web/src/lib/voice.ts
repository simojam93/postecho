import { isVideoPost } from "@/lib/video-post";

/**
 * A post's voice (Write's voice switch, M3.7 — owner, 2026-09-24: "puoi
 * scrivere qualsiasi post in prima o terza persona in stile reazione… dipende
 * dalla provenienza come consigli tu"). "mine": the owner's own text, first
 * person. "reaction": someone else's post, which the owner reacts to and
 * never claims as theirs. Every post can switch; the starting point depends
 * on where the idea came from: the owner's own note (Write's + New, or a
 * search typed as an idea) starts as "mine", and so does a video's ready
 * post, written as the owner's own idea (lib/video-post.ts; owner,
 * 2026-09-27: "come se fossero idee mie"); anything scouted or pasted from
 * someone else starts as "reaction".
 */
export type Voice = "mine" | "reaction";

export function isVoice(value: unknown): value is Voice {
  return value === "mine" || value === "reaction";
}

/** The idea's chosen voice, else the version's, else the default for where the idea came from. */
export function voiceOfIdea(
  idea: { kind: string; source?: string | null; meta: Record<string, unknown> } | null,
  fallback?: unknown,
): Voice {
  if (idea && isVoice(idea.meta.voice)) return idea.meta.voice;
  if (isVoice(fallback)) return fallback;
  return idea?.kind === "note" || isVideoPost(idea) ? "mine" : "reaction";
}
