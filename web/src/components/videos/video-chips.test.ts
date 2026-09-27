import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Idea } from "@/components/idea-card";
import { VideoChips } from "./video-chips";

const video = (i: number): Idea => ({
  id: `v${i}`, url: `https://youtu.be/v${i}`, kind: "youtube", title: `Video ${i}`, content: null, author: null,
  status: "new", source: "manual", createdAt: "2026-09-27T10:00:00.000Z", meta: {},
});

describe("the Videos chips (2026-09-27: \"come per le ricerche in trends\")", () => {
  it("one per pasted video by title, three at most, the selected one pressed, Show more for the rest", () => {
    const html = renderToStaticMarkup(createElement(VideoChips, {
      videos: [0, 1, 2, 3, 4].map(video), counts: { v0: 12 }, selectedId: "v0",
      onSelect: () => {}, onAgain: () => {}, onRemove: () => {}, againId: null,
    }));
    expect(html).toContain("“Video 0”");
    expect(html).toContain(" · 12");
    expect(html).not.toContain("Video 3");
    expect(html).toContain("Show more (2)");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
