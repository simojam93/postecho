import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkedHandles, selectedName, TagTools, tagSelection } from "./tag-tools";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
const TEXT = "Loved what Andrej Karpathy said about agents, @AnthropicAI take note.";
const at = (name: string) => ({ start: TEXT.indexOf(name), end: TEXT.indexOf(name) + name.length });

describe("selectedName / tagSelection", () => {
  it("takes a one-line selection of 2–60 characters, trimmed", () => {
    expect(selectedName(TEXT, { start: at("Andrej Karpathy").start - 1, end: at("Andrej Karpathy").end + 1 }))
      .toEqual({ ...at("Andrej Karpathy"), name: "Andrej Karpathy" });
    expect(selectedName(TEXT, { start: 3, end: 3 })).toBeNull();
    expect(selectedName(TEXT, { start: 0, end: 1 })).toBeNull();
    expect(selectedName("one\ntwo", { start: 0, end: 7 })).toBeNull();
  });

  it("puts the @handle in the name's place", () => {
    expect(tagSelection(TEXT, at("Andrej Karpathy"), "karpathy")).toBe("Loved what @karpathy said about agents, @AnthropicAI take note.");
  });
});

describe("TagTools", () => {
  it("links every tagged handle to its X profile; nothing at all with no handle and no selection (2026-09-27)", () => {
    const html = renderToStaticMarkup(createElement(TagTools, { platform: "x", text: TEXT, selection: null, onTag: () => {} }));
    expect(html).toContain('href="https://x.com/AnthropicAI"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("Select a name");
    expect(renderToStaticMarkup(createElement(TagTools, { platform: "x", text: "No handles here.", selection: null, onTag: () => {} }))).toBe("");
  });

  it("a selected name gets a Google search on X and LinkedIn, and on X a field for its handle", () => {
    const html = renderToStaticMarkup(createElement(TagTools, { platform: "x", text: TEXT, selection: at("Andrej Karpathy"), onTag: () => {} }));
    expect(html).toContain("Find “Andrej Karpathy” on");
    expect(html).toContain(`href="https://www.google.com/search?q=${encodeURIComponent('"Andrej Karpathy" site:x.com').replace(/"/g, "%22")}"`.replace(/&/g, "&amp;"));
    expect(html).toContain("site%3Alinkedin.com");
    expect(html).toContain('placeholder="@handle"');
    expect(html).toContain(">Tag</button>");
  });

  it("LinkedIn: search links only, no tag field, and nothing at all without a selection", () => {
    const li = "A long LinkedIn post about Plausible Analytics and what they did.";
    const start = li.indexOf("Plausible Analytics");
    const html = renderToStaticMarkup(createElement(TagTools, { platform: "linkedin", text: li, selection: { start, end: start + 19 } }));
    expect(html).toContain("Find “Plausible Analytics” on");
    expect(html).not.toContain('placeholder="@handle"');
    expect(renderToStaticMarkup(createElement(TagTools, { platform: "linkedin", text: li, selection: null }))).toBe("");
  });
});

describe("LinkedHandles", () => {
  it("renders the text with each handle as a profile link", () => {
    const html = renderToStaticMarkup(createElement(LinkedHandles, { text: "cc @karpathy and me" }));
    expect(html).toContain('<a href="https://x.com/karpathy"');
    expect(html).toContain(">@karpathy</a>");
    expect(html).toContain("<span>cc </span>");
  });
});
