import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditChat, humanizeChoices } from "./edit-chat";
import type { Draft } from "./types";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
function draft(over: Partial<Draft> & { id: string }): Draft {
  return {
    ideaId: "idea", xText: null, linkedinText: null, status: "kept", favorite: false, parentId: null, imagePrompt: null,
    jobId: null, meta: {}, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z", idea: null, latestJobStatus: null,
    ...over,
  };
}
const idleChat = { send: async () => true, job: null, runningMode: null, pendingLabel: null, error: null, busy: false };
const render = (props: Partial<Parameters<typeof EditChat>[0]> & { draft: Draft; chain: Draft[] }) =>
  renderToStaticMarkup(createElement(EditChat, {
    voice: "reaction", xText: props.draft.xText ?? "", linkedinText: props.draft.linkedinText ?? "",
    scores: { x: null, linkedin: null }, chat: idleChat, onRestore: () => {}, ...props,
  }));

describe("Edit with AI", () => {
  it("one quiet bar (2026-09-27: \"in casinato\"): Humanize, the voice as a small menu, examples in the field's own text", () => {
    const v1 = draft({ id: "v1", xText: "x", linkedinText: "l", meta: { xAtLinkedin: "x" } });
    const html = render({ draft: v1, chain: [v1] });
    for (const label of ["Humanize", "Send", "Voice: reaction ▾"]) expect(html).toContain(label);
    expect(html).toContain('placeholder="Tell the AI what to change: shorter, a stronger hook, more personal…"');
    // Gone: the heading, the one-off chips, the versions line, and the sync chips (the editor's LinkedIn tab has them).
    for (const gone of [">Edit with AI<", ">Shorter<", ">Stronger hook<", "Every reply is a new version", "LinkedIn from X"]) expect(html).not.toContain(gone);
  });

  it("lights Humanize when a platform is below Human 7/10; the voice reads yours when it's the owner's", () => {
    const xOnly = draft({ id: "v1", xText: "x" });
    const html = render({ draft: xOnly, chain: [xOnly], voice: "mine", scores: { x: { verdict: "slop", slopScore: 90 }, linkedin: null } });
    expect(html).toMatch(/<button[^>]*border-accent[^>]*>Humanize<\/button>/);
    expect(html).toContain("Voice: yours ▾");
  });

  it("the thread: each request above the version it produced, what changed, its human score, Restore for older ones", () => {
    const v1 = draft({ id: "v1", xText: "x1", linkedinText: "l1", status: "candidate" });
    const v2 = draft({ id: "v2", parentId: "v1", xText: "x2", linkedinText: "l1", status: "candidate", meta: { instruction: "Shorter", slopByPlatform: { x: { verdict: "human", slopScore: 20 } } } });
    const v3 = draft({ id: "v3", parentId: "v2", xText: "x2", linkedinText: "l3", meta: { instruction: "Update LinkedIn from X" } });
    const html = render({ draft: v3, chain: [v1, v2, v3] });
    expect(html.indexOf("Shorter")).toBeLessThan(html.indexOf("AI · v2"));
    expect(html).toContain("changed X");
    expect(html).toContain("Human 8/10");
    expect(html).toContain("Restore v2");
    expect(html).toContain("changed LinkedIn");
    expect(html).toContain(">current<");
  });
});

describe("Humanize (2026-09-25: a menu of X, LinkedIn or Both when the post has both)", () => {
  const chip = (label: string, html: string) => {
    const m = new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`).exec(html);
    return m ? (m[1].includes("border-accent") ? "lit" : "idle") : "absent";
  };

  it("both platforms: one Humanize ▾ that opens a menu, lit when either text is below Human 7/10", () => {
    const v1 = draft({ id: "v1", xText: "x", linkedinText: "l" });
    const bothHuman = render({ draft: v1, chain: [v1], scores: { x: { verdict: "human", slopScore: 20 }, linkedin: { verdict: "human", slopScore: 25 } } });
    expect(bothHuman).toContain("Humanize ▾");
    expect(chip("Humanize ▾", bothHuman)).toBe("idle");
    expect(chip("Humanize", bothHuman)).toBe("absent");
    const linkedinMixed = render({ draft: v1, chain: [v1], scores: { x: { verdict: "human", slopScore: 20 }, linkedin: { verdict: "borderline", slopScore: 45 } } });
    expect(chip("Humanize ▾", linkedinMixed)).toBe("lit");
  });

  it("the menu offers X, LinkedIn and Both — one platform at a time, or the loop on each", () => {
    const choices = humanizeChoices(["x", "linkedin"], { x: { verdict: "human", slopScore: 20 }, linkedin: { verdict: "borderline", slopScore: 45 } });
    expect(choices.map((c) => [c.choice, c.request.humanize ?? null, c.request.label, c.lit])).toEqual([
      ["X", "x", "Humanize X", false],
      ["LinkedIn", "linkedin", "Humanize LinkedIn", true],
      ["Both", null, "Humanize both", true],
    ]);
    expect(choices.every((c) => c.request.mode === "humanize")).toBe(true);
  });

  it("a post with only X keeps a plain Humanize, no X in its name (2026-09-27: \"è scontato\")", () => {
    const xOnly = draft({ id: "v1", xText: "x" });
    const html = render({ draft: xOnly, chain: [xOnly], scores: { x: { verdict: "borderline", slopScore: 45 }, linkedin: null } });
    expect(chip("Humanize", html)).toBe("lit");
    expect(html).not.toContain("Humanize X");
    expect(html).not.toContain("Humanize ▾");
    expect(humanizeChoices(["x"], { x: null, linkedin: null }).map((c) => c.choice)).toEqual(["X"]);
  });
});
