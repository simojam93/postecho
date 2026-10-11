import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Idea } from "@/components/idea-card";
import { RepoForm, repoPayload, repoSource } from "./repo-form";

const repo = (over: Partial<Idea>): Idea => ({
  id: "r1", url: "file:///Users/me/dev/postecho", kind: "repo", title: "postecho", content: null, author: null,
  status: "new", source: "manual", createdAt: "2026-10-10T10:00:00.000Z", meta: { sourceType: "folder", path: "/Users/me/dev/postecho" }, ...over,
});

const base = { path: "", githubUrl: "", brief: "", format: "x" as const };

describe("From a repo's form: what Create sends (posts from a repo, 2026-10-10)", () => {
  it("a folder, with its path trimmed and the brief trimmed", () => {
    expect(repoPayload({ ...base, path: "  /Users/me/dev/app  ", brief: "  the launch  " })).toEqual({
      ok: true, body: { source: { type: "folder", path: "/Users/me/dev/app" }, brief: "the launch", format: "x", count: 6 },
    });
  });

  it("six posts each time, two for articles: no count to pick (owner, 2026-10-10)", () => {
    expect(repoPayload({ ...base, githubUrl: "https://github.com/a/b.git", format: "article" })).toEqual({
      ok: true, body: { source: { type: "github", url: "https://github.com/a/b.git" }, brief: "", format: "article", count: 2 },
    });
  });

  it("no source, or a link that isn't a GitHub repository", () => {
    expect(repoPayload(base)).toEqual({ ok: false, error: "Choose a folder, or paste a GitHub link." });
    expect(repoPayload({ ...base, githubUrl: "https://gitlab.com/a/b" })).toEqual({
      ok: false, error: "Paste a public GitHub link, like https://github.com/owner/name.",
    });
    expect(repoPayload({ ...base, path: "/a", format: "linkedin" })).toMatchObject({ ok: true, body: { count: 6 } });
  });

  it("a chip's source: its folder or its link, with the new brief and format, whatever the inputs hold", () => {
    const folder = repoSource(repo({}));
    expect(folder).toEqual({ type: "folder", path: "/Users/me/dev/postecho" });
    expect(repoPayload({ ...base, path: "/elsewhere", githubUrl: "nope", brief: " pricing ", format: "article", source: folder })).toEqual({
      ok: true, body: { source: { type: "folder", path: "/Users/me/dev/postecho" }, brief: "pricing", format: "article", count: 2 },
    });
    expect(repoSource(repo({ url: "https://github.com/a/b", title: "a/b", meta: { sourceType: "github" } }))).toEqual({ type: "github", url: "https://github.com/a/b" });
    // An older folder source without meta.path: its file:// url says it.
    expect(repoSource(repo({ meta: { sourceType: "folder" } }))).toEqual({ type: "folder", path: "/Users/me/dev/postecho" });
  });

  it("a chip selected: its name as the source, × to clear it, no folder or link to fill", () => {
    const html = renderToStaticMarkup(createElement(RepoForm, { onCreated: () => {}, repo: repo({}), onClear: () => {}, onFavorite: () => {} }));
    expect(html).toContain(">postecho<");
    expect(html).toContain('aria-label="Clear postecho"');
    expect(html).not.toContain("Choose a folder");
    expect(html).not.toContain('aria-label="GitHub link"');
    expect(html).toContain(">Create<");
    // ☆ pins it, so it heads the folder chip's menu (2026-10-11).
    expect(html).toContain('aria-label="Pin postecho"');
    const pinned = renderToStaticMarkup(createElement(RepoForm, { onCreated: () => {}, repo: repo({ meta: { sourceType: "folder", favorite: true } }), onFavorite: () => {} }));
    expect(pinned).toContain('aria-label="Unpin postecho"');
  });

  it("renders the two sources, the formats, no count and the note said once", () => {
    const html = renderToStaticMarkup(createElement(RepoForm, { onCreated: () => {} }));
    expect(html).toContain("Choose a folder");
    expect(html).toContain("GitHub link");
    // With sources used before, the folder chip opens a menu of them.
    expect(html).not.toContain('aria-haspopup="menu"');
    const withRepos = renderToStaticMarkup(createElement(RepoForm, { onCreated: () => {}, repos: [repo({})] }));
    expect(withRepos).toContain('aria-haspopup="menu"');
    for (const format of ["6 X posts", "2 X articles"]) expect(html).toContain(`>${format}<`);
    // LinkedIn versions come in Compose (2026-10-11).
    expect(html).not.toContain("LinkedIn");
    expect(html).not.toContain('aria-label="How many"');
    expect(html.match(/goes to Claude to write the posts/g)).toHaveLength(1);
    expect(html).toContain(">Create<");
  });
});
