import { describe, expect, it } from "vitest";
import { scoutResultMessage, xSearchLine } from "./search-box";
import type { PerSourceSummary } from "@/lib/scout-run";

const summary = (over: Partial<PerSourceSummary>): PerSourceSummary => ({
  status: "ok", candidates: 0, judged: 0, strong: 0, inserted: 0, skippedDuplicates: 0, ...over,
});

describe("the lines under a search (2026-09-24)", () => {
  it("says nothing once it found posts, only what needs doing (2026-09-27: \"questo non mi serve vederlo\")", () => {
    const scout = { candidates: 90, judged: 90, inserted: 13, skippedDuplicates: 0 };
    expect(scoutResultMessage("q", scout)).toBeNull();
    expect(scoutResultMessage("q", { ...scout, candidates: 0 })?.text).toBe("No posts found for “q” — try different words.");
    // Without Jev the posts are saved unranked, and the line says what a key adds (2026-09-27: "ok jev opzionale").
    expect(scoutResultMessage("q", { ...scout, judged: 0, note: "unranked: TYPESAFE_API_KEY not set" }))
      .toEqual({ kind: "info", text: "Unranked: add a Jev key in Settings › AI tools to rank them and filter spam." });
  });

  it("says what X read and about what it costs, or why it failed", () => {
    expect(xSearchLine({ x_post: summary({ billed: { posts: 20, users: 3 } }) })).toEqual({ kind: "info", text: "X: read 20 posts and 3 authors, about $0.13" });
    expect(xSearchLine({ x_post: summary({ billed: { posts: 1, users: 0 } }) })).toEqual({ kind: "info", text: "X: read 1 post, about $0.01" });
    expect(xSearchLine({ x_post: summary({ status: "error", note: "X rejected the key (401): check the bearer token in Settings" }) }))
      .toEqual({ kind: "error", text: "X rejected the key (401): check the bearer token in Settings" });
    expect(xSearchLine({ x_post: summary({ status: "disabled" }) })).toBeNull();
    expect(xSearchLine({ hackernews: summary({}) })).toBeNull();
  });
});
