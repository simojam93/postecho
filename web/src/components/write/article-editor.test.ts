import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArticleEditor, articleClipboard, isArticle, X_ARTICLES_URL } from "./article-editor";
import type { Draft } from "./types";

function draft(over: Partial<Draft>): Draft {
  return {
    id: "v1", ideaId: "idea", xText: null, linkedinText: null, articleTitle: null, articleText: null, status: "kept", favorite: false,
    parentId: null, imagePrompt: null, jobId: null, meta: {}, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    idea: null, latestJobStatus: null, ...over,
  };
}

describe("an X article in Write (posts from a repo, 2026-10-10)", () => {
  it("a draft with an article title is an article; an X or LinkedIn post isn't", () => {
    expect(isArticle(draft({ articleTitle: "What we shipped", articleText: "Body" }))).toBe(true);
    expect(isArticle(draft({ articleTitle: "", articleText: "Body" }))).toBe(true);
    expect(isArticle(draft({ xText: "An X post" }))).toBe(false);
    expect(isArticle(draft({ linkedinText: "A LinkedIn post", articleTitle: null }))).toBe(false);
  });

  it("Copy puts the title, a blank line and the body", () => {
    expect(articleClipboard("What we shipped", "First paragraph.\n\nSecond.")).toBe("What we shipped\n\nFirst paragraph.\n\nSecond.");
  });

  it("a title field and a long text area, Copy and Open X Articles, no X or LinkedIn boxes", () => {
    const html = renderToStaticMarkup(createElement(ArticleEditor, {
      draft: draft({ articleTitle: "What we shipped", articleText: "The body" }), onMutated: () => {},
    }));
    expect(html).toContain('aria-label="Article title"');
    expect(html).toContain('value="What we shipped"');
    expect(html).toContain('aria-label="Article text"');
    expect(html).toContain(">The body</textarea>");
    expect(html).toContain(">Copy<");
    expect(html).toContain(`href="${X_ARTICLES_URL}"`);
    expect(X_ARTICLES_URL).toBe("https://x.com/compose/articles");
    expect(html).toContain('target="_blank"');
    expect(html).toContain(">Open X Articles<");
    for (const gone of ['aria-label="X text"', 'aria-label="LinkedIn text"', "Create LinkedIn post", ">Schedule<"]) expect(html).not.toContain(gone);
  });
});
