import { describe, expect, it } from "vitest";
import { ALL_ADAPTERS } from "@/lib/sources/all";
import { SOURCE_LABEL_ORDER, SOURCE_LABELS, sourceLabel, type SourceLabelInfo } from "@/lib/sources/labels";

describe("SOURCE_LABELS", () => {
  it("has a non-empty label and tag for every adapter in ALL_ADAPTERS (every SourceName)", () => {
    for (const adapter of ALL_ADAPTERS) {
      const entry: SourceLabelInfo | undefined = (SOURCE_LABELS as Record<string, SourceLabelInfo>)[adapter.name];
      expect(entry, `missing label for adapter "${adapter.name}"`).toBeDefined();
      expect(entry!.label.length).toBeGreaterThan(0);
      expect(entry!.tag.length).toBeGreaterThan(0);
    }
  });

  it("also covers the three manually-captured idea kinds (x_post, note, article)", () => {
    expect(SOURCE_LABELS.x_post).toEqual({ label: "X", tag: "X" });
    expect(SOURCE_LABELS.note).toEqual({ label: "Note", tag: "NOTE" });
    expect(SOURCE_LABELS.article).toEqual({ label: "Article", tag: "WEB" });
    expect(SOURCE_LABELS.repo_post).toEqual({ label: "Repo post", tag: "REPO" });
  });

  it("matches the documented label/tag pairs for each of the eleven discovery sources", () => {
    expect(SOURCE_LABELS.hackernews).toEqual({ label: "Hacker News", tag: "HN" });
    expect(SOURCE_LABELS.bluesky).toEqual({ label: "Bluesky", tag: "BSKY" });
    expect(SOURCE_LABELS.arxiv).toEqual({ label: "arXiv", tag: "AX" });
    expect(SOURCE_LABELS.github).toEqual({ label: "GitHub", tag: "GH" });
    expect(SOURCE_LABELS.devto).toEqual({ label: "Dev.to", tag: "DEV" });
    expect(SOURCE_LABELS.mastodon).toEqual({ label: "Mastodon", tag: "MAST" });
    expect(SOURCE_LABELS.lobsters).toEqual({ label: "Lobsters", tag: "LOB" });
    expect(SOURCE_LABELS.lemmy).toEqual({ label: "Lemmy", tag: "LEM" });
    expect(SOURCE_LABELS.youtube).toEqual({ label: "YouTube", tag: "YT" });
    expect(SOURCE_LABELS.producthunt).toEqual({ label: "Product Hunt", tag: "PH" });
  });

  it("gives every entry a unique tag", () => {
    const tags = Object.values(SOURCE_LABELS).map((v) => v.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("has exactly fifteen entries: the adapters plus note/article/video_idea/repo_post (Reddit taken out, 2026-09-25; video ideas 2026-09-27; repo posts 2026-10-10)", () => {
    expect(Object.keys(SOURCE_LABELS)).toHaveLength(15);
  });

  it("orders the filter row like ALL_ADAPTERS (lobsters/lemmy right after mastodon, before the keyed sources), then the manual kinds", () => {
    // X is both: a pasted X post and a searched one (with the owner's key) share the x_post kind.
    expect(SOURCE_LABEL_ORDER).toEqual([...ALL_ADAPTERS.map((a) => a.name), "note", "article", "video_idea", "repo_post"]);
  });
});

describe("sourceLabel", () => {
  it("returns the mapped entry for a known name", () => {
    expect(sourceLabel("arxiv")).toEqual({ label: "arXiv", tag: "AX" });
    expect(sourceLabel("producthunt")).toEqual({ label: "Product Hunt", tag: "PH" });
  });

  it("falls back to a derived label/tag for an unknown name instead of throwing", () => {
    const r = sourceLabel("mystery-source");
    expect(r.label).toBe("mystery-source");
    expect(r.tag).toBe("MYST");
  });
});
