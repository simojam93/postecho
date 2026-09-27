import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CARDS_PER_PAGE, ShowMoreButton, shownCount } from "./show-more";

describe("six cards at a time (2026-09-26)", () => {
  it("shows six, more after each press, and six again in a new view", () => {
    expect(CARDS_PER_PAGE).toBe(6);
    expect(shownCount({ view: "trends||", count: 12 }, "trends||")).toBe(12);
    expect(shownCount({ view: "trends||", count: 12 }, "trends|yc|")).toBe(6);
  });

  it("offers more only while cards are hidden", () => {
    expect(renderToStaticMarkup(createElement(ShowMoreButton, { hidden: 14, onClick: () => {} }))).toContain("Show more · 14 left");
    expect(renderToStaticMarkup(createElement(ShowMoreButton, { hidden: 0, onClick: () => {} }))).toBe("");
  });
});
