import type { SourceName } from "./types";

export type SourceLabelInfo = { label: string; tag: string };

/** Every idea "source" a card/pill can show, beyond the eleven discovery adapters. */
export type ManualIdeaSource = "x_post" | "note" | "article" | "video_idea";

/**
 * name -> { label, tag } for every value `idea.kind`/`idea.meta.sourceName`
 * can take: the eleven discovery-source adapters (sources/all.ts's
 * ALL_ADAPTERS — `label`/`tag` here are this app's own UI copy, independent
 * of each adapter's own `.label`/`.tag` fields, which are only informational
 * metadata on the adapter object itself) plus the three manually-captured
 * idea kinds. One place so idea-card.tsx's source pill and the Trends filter
 * row (app/(authed)/page.tsx) never drift apart — see docs/sources.md.
 */
export const SOURCE_LABELS: Record<SourceName | ManualIdeaSource, SourceLabelInfo> = {
  hackernews: { label: "Hacker News", tag: "HN" },
  bluesky: { label: "Bluesky", tag: "BSKY" },
  arxiv: { label: "arXiv", tag: "AX" },
  github: { label: "GitHub", tag: "GH" },
  devto: { label: "Dev.to", tag: "DEV" },
  mastodon: { label: "Mastodon", tag: "MAST" },
  lobsters: { label: "Lobsters", tag: "LOB" },
  lemmy: { label: "Lemmy", tag: "LEM" },
  youtube: { label: "YouTube", tag: "YT" },
  producthunt: { label: "Product Hunt", tag: "PH" },
  x_post: { label: "X", tag: "X" },
  note: { label: "Note", tag: "NOTE" },
  article: { label: "Article", tag: "WEB" },
  video_idea: { label: "Video idea", tag: "IDEA" },
};

/**
 * Sources the owner turns on deliberately, with a paid key of their own (X):
 * not "off" in the sense search-box.tsx's "(add keys)" line means.
 */
export const OPT_IN_SOURCES: ReadonlySet<string> = new Set(["x_post"]);

/** Lookup order for the Trends filter row: discovery sources (ALL_ADAPTERS' order), then the manual kinds. */
export const SOURCE_LABEL_ORDER: (SourceName | ManualIdeaSource)[] = Object.keys(SOURCE_LABELS) as (SourceName | ManualIdeaSource)[];

/**
 * Looks up `name`'s `{ label, tag }`, falling back to a derived one (the
 * name itself as the label, its first 4 chars upper-cased as the tag)
 * instead of throwing — defensive only: every real idea kind/source name is
 * listed above, but idea.kind is just a `string` by the time it reaches a
 * client component, so this stays total over any input.
 */
export function sourceLabel(name: string): SourceLabelInfo {
  return (SOURCE_LABELS as Record<string, SourceLabelInfo>)[name] ?? { label: name, tag: name.slice(0, 4).toUpperCase() };
}
