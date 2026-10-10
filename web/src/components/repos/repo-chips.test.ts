import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Idea } from "@/components/idea-card";
import { RepoChips } from "./repo-chips";

const repo = (i: number): Idea => ({
  id: `r${i}`, url: `file:///Users/me/dev/app${i}`, kind: "repo", title: `app${i}`, content: null, author: null,
  status: "new", source: "manual", createdAt: "2026-10-10T10:00:00.000Z", meta: { sourceType: "folder" },
});

describe("From a repo's source chips (spec 2026-10-10: \"like the videos today\")", () => {
  it("one per source by name, unquoted, its posts counted, ↻ to write again and × to hide", () => {
    const html = renderToStaticMarkup(createElement(RepoChips, {
      repos: [0, 1].map(repo), counts: { r0: 3 }, selectedId: "r0",
      onSelect: () => {}, onAgain: () => {}, onRemove: () => {}, againId: null,
    }));
    expect(html).toContain(">app0<");
    expect(html).not.toContain("“app0”");
    expect(html).toContain(" · 3");
    expect(html).toContain("Write new posts from it, as last time");
    expect(html).toContain("Hide it; Liked posts stay");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
