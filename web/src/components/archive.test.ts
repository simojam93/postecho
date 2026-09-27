import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveList, ArchiveWindow, type ArchivedPost } from "./archive";

const post: ArchivedPost = {
  draftId: "d1", ideaId: "i1", idea: { id: "i1", title: "Jet HR's founder", url: null, kind: "note" },
  xText: "Jet HR is 350 people and the founder still does the first interview.", linkedinText: "The LinkedIn version.",
  schedules: [{ platform: "x", publishAt: "2026-09-28T15:30:00.000Z", status: "posted_manually" }],
  updatedAt: "2026-09-27T10:00:00.000Z",
};

describe("the Archive, Write's and Calendar's alike (2026-09-27)", () => {
  it("each post: where and when, its text, a copy for each platform, its day in Calendar", () => {
    const html = renderToStaticMarkup(createElement(ArchiveList, { posts: [post], now: "2026-09-27T10:00:00.000Z" }));
    expect(html).toContain("✓ X · ");
    expect(html).toContain("Jet HR is 350 people");
    expect(html).toContain(">Copy X<");
    expect(html).toContain(">Copy LinkedIn<");
    expect(html).toContain('href="/calendar?day=2026-09-28"');
    expect(html).toContain("Jet HR&#x27;s founder");
  });

  it("in Calendar, See in Calendar shows the day there instead of following the link", () => {
    const html = renderToStaticMarkup(createElement(ArchiveList, { posts: [post], now: "2026-09-27T10:00:00.000Z", onSeeDay: () => {} }));
    expect(html).toContain('<button type="button" class="ml-auto text-xs text-text-dim underline hover:text-text">See in Calendar</button>');
    expect(html).not.toContain('href="/calendar');
  });

  it("opens as a window like Settings: its title, × to close, Esc (the native dialog)", () => {
    const html = renderToStaticMarkup(createElement(ArchiveWindow, { posts: [post], now: "2026-09-27T10:00:00.000Z", onClose: () => {} }));
    expect(html).toMatch(/^<dialog[^>]*aria-labelledby=/);
    expect(html).toMatch(/<h2 id="[^"]+" class="text-base font-semibold">Archive<\/h2>/);
    expect(html).toContain('aria-label="Close archive"');
    expect(html).toContain("Jet HR is 350 people");
  });
});
