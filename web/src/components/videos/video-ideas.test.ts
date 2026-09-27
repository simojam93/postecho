import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Idea } from "@/components/idea-card";
import { VideoIdeas } from "./video-ideas";

const video: Idea = {
  id: "v1", url: "https://www.youtube.com/watch?v=abc", kind: "youtube", title: "Intervista a Alberto Dalmasso", content: null,
  author: "Mr. RIP", status: "new", source: "manual", createdAt: "2026-09-27T10:00:00.000Z", meta: { thumbnailUrl: "https://i.ytimg.com/t.jpg" },
};
const ideaOf = (i: number): Idea => ({
  id: `i${i}`, url: null, kind: "video_idea", title: `Idea ${i + 1}`, content: `Angle ${i + 1}`, author: "Mr. RIP", status: "new",
  source: "manual", createdAt: "2026-09-27T10:01:00.000Z", meta: { videoId: "v1", order: i, sourceName: "youtube" },
});
const render = (ideas: Idea[]) => renderToStaticMarkup(createElement(VideoIdeas, {
  video, ideas, onStatus: async () => {}, onUse: async () => {}, onChanged: () => {},
}));

describe("a pasted video and its post ideas (2026-09-27: \"at least 6 best and 6 more that I can open if I click show more\")", () => {
  it("six ideas best first, and Show more for the rest", () => {
    const html = render(Array.from({ length: 12 }, (_, i) => ideaOf(i)));
    for (let i = 1; i <= 6; i++) expect(html).toContain(`>Idea ${i}<`);
    expect(html).not.toContain(">Idea 7<");
    expect(html).toContain("Show more · 6 left");
    expect(html.match(/>Use</g)).toHaveLength(6);
  });

  it("nothing before the first answer; ideas from the description say so", () => {
    expect(render([])).not.toContain("Show more");
    const fromDescription = render([{ ...ideaOf(0), meta: { ...ideaOf(0).meta, fromDescription: true } }]);
    expect(fromDescription).toContain("these ideas come from its description");
  });
});
