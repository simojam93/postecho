import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Idea } from "@/components/idea-card";
import { RepoChips, sortRepos } from "./repo-chips";

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

  it("a ☆ on each to pin it, a ★ to unpin it (owner, 2026-10-10: favorite repos)", () => {
    const pinned = { ...repo(1), meta: { sourceType: "folder", favorite: true } };
    const html = renderToStaticMarkup(createElement(RepoChips, {
      repos: [pinned, repo(0)], counts: {}, selectedId: null,
      onSelect: () => {}, onAgain: () => {}, onRemove: () => {}, onFavorite: () => {}, againId: null,
    }));
    expect(html.match(/★/g)).toHaveLength(1);
    expect(html.match(/☆/g)).toHaveLength(1);
    expect(html).toContain('data-tip="Unpin it"');
    expect(html).toContain('data-tip="Keep it at the start"');
    expect(html.indexOf("★")).toBeLessThan(html.indexOf(">app1<"));
  });

  it("the pinned first by name, then the rest by when they were used last", () => {
    const at = (i: number, usedAt: string, favorite?: boolean): Idea => ({ ...repo(i), title: ["zeta", "alpha", "mid", "old", "new"][i], meta: { sourceType: "folder", usedAt, ...(favorite ? { favorite } : {}) } });
    const sorted = sortRepos([
      at(3, "2026-10-01T00:00:00.000Z"),
      at(0, "2026-10-09T00:00:00.000Z", true),
      at(4, "2026-10-10T00:00:00.000Z"),
      at(1, "2026-10-02T00:00:00.000Z", true),
      at(2, "2026-10-05T00:00:00.000Z"),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(["alpha", "zeta", "new", "mid", "old"]);
  });
});
