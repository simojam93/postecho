import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaCard, type Idea } from "./idea-card";

describe("a Find Ideas card", () => {
  it("never says it fits your taste (2026-09-27: \"toglilo dappertutto, perché non mi voglio far condizionare\")", () => {
    const idea: Idea = {
      id: "i1", url: "https://x.com/a/status/1", kind: "x_post", title: null, author: "@a", status: "new", createdAt: "2026-09-27T10:00:00.000Z",
      content: "A post", meta: { sourceName: "x_post", rank: 80, tasteFit: 0.95 },
    };
    const html = renderToStaticMarkup(createElement(IdeaCard, { idea, onStatus: async () => {}, onUse: async () => {} }));
    expect(html).toContain("✦ 80");
    expect(html).not.toContain("Matches what you usually keep");
    expect(html).not.toContain("bg-ok");
  });
});
