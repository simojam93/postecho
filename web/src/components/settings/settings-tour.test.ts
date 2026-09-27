import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TABS } from "./settings-panel";
import { TOUR_PAGES, TourPage } from "./settings-tour";

describe("the Settings tour (2026-09-27: \"pagine che mi spiegano tab per tab cosa fa\")", () => {
  it("a page for each tab that needs it, in the tabs' order: not Profile (2026-09-27)", () => {
    expect(TOUR_PAGES.map((page) => page.tab)).toEqual(["voice", "references", "sources", "agent"]);
    const order = TABS.map((tab) => tab.id);
    expect(TOUR_PAGES.map((page) => order.indexOf(page.tab))).toEqual([...TOUR_PAGES.map((page) => order.indexOf(page.tab))].sort((a, b) => a - b));
  });

  it("each page: the tab's icon, what it's for, what to do there", () => {
    const html = renderToStaticMarkup(createElement(TourPage, { index: 0, titleId: "t" }));
    expect(html).toContain('<h2 id="t" class="text-lg font-semibold">Voice: how you write</h2>');
    expect(html).toContain("suggests updates to it from the takes you keep");
    expect(html).toContain("<svg");
  });
});
