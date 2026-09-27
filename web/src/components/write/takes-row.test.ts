import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TakesRow } from "./takes-row";
import type { Draft } from "./types";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
function take(over: Partial<Draft> & { id: string }): Draft {
  return {
    ideaId: "idea", xText: null, linkedinText: null, status: "candidate", favorite: false, parentId: null, imagePrompt: null,
    jobId: null, meta: {}, createdAt: "2026-09-25T08:00:00.000Z", updatedAt: "2026-09-25T08:00:00.000Z", idea: null, latestJobStatus: null,
    ...over,
  };
}
const render = (takes: Draft[]) => renderToStaticMarkup(createElement(TakesRow, {
  takes, chosenId: null, identity: { name: "Simone Lovera", handle: "lovera_simone", avatarUrl: "" }, job: null,
  transcriptFallback: false, pickBusy: false, moreBusy: false, moreDisabled: false, checkingId: null,
  onPick: () => {}, onMoreTakes: () => {}, onSubmitTranscript: async () => {},
}));

describe("take cards (2026-09-25: an X post is read whole)", () => {
  const X = "Someone tested six AI memory systems with one question: does a bad outcome actually change what the model does next.\nFour of the other five actually publish that signal.\nExplains a lot about why my vibe coding sessions forget the same staging db warning.";

  it("show an X take whole: no clamp, no dots, every word there", () => {
    const html = render([take({ id: "t1", xText: X })]);
    expect(html).not.toContain("line-clamp");
    expect(html).toContain("forget the same staging db warning.");
    expect(html).not.toContain(">more</button>");
  });

  it("clamp a long LinkedIn-only take instead, with more once it's cut", () => {
    const html = render([take({ id: "t2", linkedinText: "l".repeat(1200) })]);
    expect(html).toContain("line-clamp-8");
  });
});
