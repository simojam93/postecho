import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostingTimes } from "./posting-times";

describe("Posting times, in Calendar since the Publishing tab went (2026-09-27)", () => {
  it("each platform's times, to add to or take away from", () => {
    const html = renderToStaticMarkup(createElement(PostingTimes, { slots: { x: ["10:00", "17:00"], linkedin: ["09:00"] }, onSaved: () => {}, onClose: () => {} }));
    expect(html).toContain(">Posting times</h2>");
    expect(html).toContain(">X</span>");
    expect(html).toContain(">LinkedIn</span>");
    expect(html).toContain("10:00");
    expect(html).toContain("09:00");
  });
});
