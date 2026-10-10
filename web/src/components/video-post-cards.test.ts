import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaCard, type Idea } from "./idea-card";
import { SourceCard } from "./write/source-card";
import { isVideoPost } from "@/lib/video-post";

// A video's ready post (2026-09-27: "post X pronti all'attacco senza titolo, 6+6 vanno bene").
const post: Idea = {
  id: "i1", url: null, kind: "video_idea", title: null, author: "Chan", status: "new", createdAt: "2026-09-27T10:00:00.000Z",
  content: "Cole reused one sentence for ten years.\nThat's the whole trick.",
  meta: { videoId: "v", order: 0, format: "post", rank: 82, aiStyle: { slopScore: 18, verdict: "human" } },
};
const video = { videoTitle: "The talk", articleUrl: "https://youtu.be/v" };

describe("a video's ready post", () => {
  it("is told apart from a topic from before", () => {
    expect(isVideoPost(post)).toBe(true);
    expect(isVideoPost({ ...post, meta: { ...post.meta, format: undefined } })).toBe(false);
    expect(isVideoPost({ ...post, kind: "x_post" })).toBe(false);
    expect(isVideoPost(null)).toBe(false);
  });

  it("its card is the post itself, no title, with its ✦ and human score; Use opens it in Compose", () => {
    const html = renderToStaticMarkup(createElement(IdeaCard, { idea: post, onStatus: async () => {}, onUse: async () => {} }));
    expect(html).toContain("Cole reused one sentence for ten years.\nThat&#x27;s the whole trick.");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain("font-semibold");
    expect(html).toContain(">✦ 82</span>");
    expect(html).toContain("How human it reads");
    expect(html).toContain('data-tip="Edit and schedule it in Compose"');
  });

  it("in Write its source is the video, not the post again", () => {
    const html = renderToStaticMarkup(createElement(SourceCard, { idea: { ...post, meta: { ...post.meta, ...video } } }));
    expect(html).toContain("The talk");
    expect(html).toContain('href="https://youtu.be/v"');
    expect(html).toContain('data-tip="Open the video"');
    expect(html).not.toContain("Cole reused one sentence");
  });
});
