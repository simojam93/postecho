import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostEditor } from "./post-editor";
import type { Draft, Platform } from "./types";

function draft(over: Partial<Draft>): Draft {
  return {
    id: "v1", ideaId: "idea", xText: "An X post", linkedinText: null, status: "kept", favorite: false, parentId: null, imagePrompt: null,
    jobId: null, meta: {}, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", idea: null, latestJobStatus: null,
    ...over,
  };
}
const render = (d: Draft, tab: Platform = "x") => renderToStaticMarkup(createElement(PostEditor, {
  draft: d, chain: [d], voice: "reaction", tab, onTab: () => {}, onMutated: () => {}, onRefined: async () => {}, onPickVersion: () => {},
}));

describe("Your post, one card (2026-09-27: \"lo vedo in casinato… il create linkedin post forse meno visibile\")", () => {
  it("an X post: its text and counter, + Create LinkedIn post beside it (no tabs yet), one row of actions", () => {
    const html = render(draft({}));
    expect(html).not.toContain('role="tab"');
    expect(html).toContain(">+ Create LinkedIn post<");
    expect(html).toContain("9/280");
    expect(html).toContain(">Discard<");
    expect(html).toContain(">Schedule<");
    // A tab asked for before LinkedIn exists still shows X.
    expect(render(draft({}), "linkedin")).toContain('aria-label="X text"');
    for (const gone of ["Write it yourself", "No LinkedIn version yet", "Select a name", "back to v", "Discard take"]) expect(html).not.toContain(gone);
  });

  it("with a LinkedIn version, X and LinkedIn are tabs; behind the X, a dot on its tab and Update from X inside it", () => {
    const behind = draft({ xText: "A newer X post", linkedinText: "The LinkedIn post", meta: { xAtLinkedin: "The older X post" } });
    expect(render(behind)).toMatch(/role="tab" aria-selected="true"[^>]*>X<\/button>/);
    expect(render(behind)).toContain('aria-label="behind your X"');
    expect(render(behind)).not.toContain("Create LinkedIn post");
    const html = render(behind, "linkedin");
    expect(html).toContain('aria-label="LinkedIn text"');
    expect(html).toContain("Your X changed since this was written.");
    expect(html).toContain(">Update from X<");
    expect(html).toContain("Remove LinkedIn");
    const inStep = draft({ xText: "Same", linkedinText: "L", meta: { xAtLinkedin: "Same" } });
    expect(render(inStep, "linkedin")).not.toContain("Update from X");
  });
});
