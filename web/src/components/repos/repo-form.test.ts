import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoForm, repoPayload } from "./repo-form";

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

  it("renders the two sources, the formats, no count and the note said once", () => {
    const html = renderToStaticMarkup(createElement(RepoForm, { onCreated: () => {} }));
    expect(html).toContain(">Choose a folder<");
    expect(html).toContain("GitHub");
    for (const format of ["X post", "LinkedIn post", "X article"]) expect(html).toContain(`>${format}<`);
    expect(html).not.toContain('aria-label="How many"');
    expect(html.match(/goes to Claude to write the posts/g)).toHaveLength(1);
    expect(html).toContain(">Create<");
  });
});
