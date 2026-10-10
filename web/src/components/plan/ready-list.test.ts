import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadyList, type ReadyPost } from "./ready-list";
import { toDatetimeLocal } from "@/components/write/schedule-format";

const posts: ReadyPost[] = [
  { draftId: "a", ideaId: "idea-a", xText: "First post made ready.\nIts second line.", linkedinText: null, platforms: ["x"], readyAt: "2026-10-10T09:00:00.000Z" },
  { draftId: "b", ideaId: "idea-b", xText: "Second on X", linkedinText: "Second on LinkedIn", platforms: ["x", "linkedin"], readyAt: "2026-10-10T10:00:00.000Z" },
  { draftId: "c", ideaId: null, xText: null, linkedinText: "Only on LinkedIn", platforms: ["linkedin"], readyAt: "2026-10-10T11:00:00.000Z" },
];
const times = { a: "2026-10-13T15:00:00.000Z", b: "2026-10-12T15:00:00.000Z", c: null };
const render = (over: Partial<Parameters<typeof ReadyList>[0]> = {}) => renderToStaticMarkup(createElement(ReadyList, {
  posts, times, onChangeTime: () => {}, onScheduleAll: () => {}, ...over,
}));

describe("Ready to schedule, at the top of Schedule (2026-10-10)", () => {
  it("is hidden when nothing is ready", () => {
    expect(render({ posts: [] })).toBe("");
  });

  it("its title and count, and Schedule all", () => {
    const html = render();
    expect(html).toContain('aria-label="Ready to schedule"');
    expect(html).toContain(">Ready to schedule<");
    expect(html).toContain("(3)");
    expect(html).toMatch(/<button[^>]*>Schedule all<\/button>/);
  });

  it("each row: the post's start opening it in Compose, its platforms and its time to change", () => {
    const html = render();
    expect(html).toContain('href="/create?ideaId=idea-a"');
    expect(html).toContain("First post made ready.");
    expect(html).not.toContain("Its second line.");
    // The LinkedIn text when there's no X one.
    expect(html).toContain("Only on LinkedIn");
    expect(html).toMatch(/>X<\/span><span[^>]*>LI<\/span>/);
    expect(html).toContain(`value="${toDatetimeLocal(times.a)}"`);
    expect(html).toContain('aria-label="Time for First post made ready."');
  });

  it("rows in the order of their times; one with no free time last, its time to pick", () => {
    const html = render();
    expect(html.indexOf("Second on X")).toBeLessThan(html.indexOf("First post made ready."));
    expect(html.indexOf("First post made ready.")).toBeLessThan(html.indexOf("Only on LinkedIn"));
  });
});
