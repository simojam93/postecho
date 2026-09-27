import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InProgressStrip } from "./in-progress-strip";
import { NewPostComposer } from "./new-post-composer";

// Static renders (react-dom/server, node environment) — createElement rather
// than JSX because vitest.config.ts includes *.test.ts only.
const noop = () => {};
const chip = { ideaId: "i1", label: "An HN story", inFlight: false, takeCount: 3, chosen: false };

describe("Write's + New (2026-09-24)", () => {
  it("the strip opens with + New, before the chips, even when there are none", () => {
    const withChips = renderToStaticMarkup(createElement(InProgressStrip, {
      chips: [chip], currentIdeaId: "i1", removingIdeaId: null, onSelect: noop, onRemove: noop, onNew: noop, newOpen: false,
    }));
    expect(withChips.indexOf("+ New")).toBeGreaterThan(-1);
    expect(withChips.indexOf("+ New")).toBeLessThan(withChips.indexOf("An HN story"));
    expect(withChips).toContain('aria-expanded="false"');

    const empty = renderToStaticMarkup(createElement(InProgressStrip, {
      chips: [], currentIdeaId: null, removingIdeaId: null, onSelect: noop, onRemove: noop, onNew: noop, newOpen: true,
    }));
    expect(empty).toContain("+ New");
    expect(empty).toContain('aria-expanded="true"');
  });

  it("without onNew and without chips the strip renders nothing, as before", () => {
    expect(renderToStaticMarkup(createElement(InProgressStrip, {
      chips: [], currentIdeaId: null, removingIdeaId: null, onSelect: noop, onRemove: noop,
    }))).toBe("");
  });

  it("the composer: your text, an optional angle, Write takes disabled until there is text; Cancel only when closable", () => {
    const html = renderToStaticMarkup(createElement(NewPostComposer, { onCreated: noop, onCancel: noop }));
    expect(html).toContain("New post from your text");
    expect(html).toContain('aria-label="Your text"');
    expect(html).toContain('maxLength="8000"');
    expect(html).toContain('aria-label="Angle or instructions (optional)"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Write takes<\/button>/);
    expect(html).toContain(">Cancel<");
    // It says what pasting does, and nothing the tour or the button already say (2026-09-27).
    expect(html).toContain("you&#x27;ll see right away how human it reads");
    expect(html).not.toContain("as your own post");

    expect(renderToStaticMarkup(createElement(NewPostComposer, { onCreated: noop }))).not.toContain(">Cancel<");
  });
});
