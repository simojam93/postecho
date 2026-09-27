import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClampedText } from "./clamped-text";

// A server render can't measure: it shows the guess. The browser measures on attach (see the component).
describe("ClampedText", () => {
  it("clamps to the lines asked for, and shows more only when the text is (likely) cut", () => {
    const cut = renderToStaticMarkup(createElement(ClampedText, { lines: 5, text: "a long text", likely: true, className: "text-sm" }));
    expect(cut).toContain('class="text-sm line-clamp-5"');
    expect(cut).toContain(">more</button>");
    const fits = renderToStaticMarkup(createElement(ClampedText, { lines: 3, text: "short" }));
    expect(fits).toContain("line-clamp-3");
    expect(fits).not.toContain("<button");
  });

  it("renders what it's given in place of the plain text", () => {
    const html = renderToStaticMarkup(createElement(ClampedText, { lines: 8, text: "hi @a" }, createElement("a", { href: "https://x.com/a" }, "@a")));
    expect(html).toContain('<a href="https://x.com/a">@a</a>');
  });
});
