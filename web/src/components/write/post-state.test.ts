import { describe, expect, it } from "vitest";
import {
  AGENT_OFFLINE_AFTER_MS, agentLooksOffline, agentOfflineHint, chosenOf, formatElapsed, humanizeInstruction, ideaLabel, isInFlight,
  generationSteps, jobError, looksLikeTranscriptError, nextSlopCheck, persistedSlop, slopCheckTarget, slopFor, slopOf, takeCountOf,
  takesOf, versionChain,
} from "@/components/write/post-state";
import type { Draft } from "@/components/write/types";

function draft(over: Partial<Draft> & { id: string }): Draft {
  return {
    ideaId: "idea", xText: null, linkedinText: null, status: "candidate", favorite: false,
    parentId: null, imagePrompt: null, jobId: null, meta: {},
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    idea: null, latestJobStatus: null,
    ...over,
  };
}

describe("takesOf", () => {
  it("keeps candidate and kept drafts only, newest first while none is scored", () => {
    const takes = takesOf([
      draft({ id: "newer", createdAt: "2020-01-03T00:00:00.000Z" }),
      draft({ id: "binned", status: "discarded" }),
      draft({ id: "published", status: "used" }),
      draft({ id: "picked", status: "kept", createdAt: "2020-01-02T00:00:00.000Z" }),
      draft({ id: "oldest", createdAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(takes.map((t) => t.id)).toEqual(["newer", "picked", "oldest"]);
  });

  it("never more than three: the chosen take, plus the most human others, best first (2026-09-24)", () => {
    const scored = (id: string, slopScore: number, over: Partial<Draft> = {}) =>
      draft({ id, xText: `take ${id}`, meta: { slop: { platform: "x", slopScore, verdict: "v" } }, ...over });
    const takes = takesOf([
      scored("ai", 90, { status: "kept" }),
      scored("human", 10),
      scored("mixed", 45),
      scored("meh", 60),
      scored("worst", 95),
    ]);
    expect(takes.map((t) => t.id)).toEqual(["human", "mixed", "ai"]);
  });

  it("one card per take: an edited take shows its chosen version, not every version", () => {
    const takes = takesOf([
      draft({ id: "v1", createdAt: "2020-01-01T00:00:00.000Z" }),
      draft({ id: "v2", parentId: "v1", status: "kept", createdAt: "2020-01-02T00:00:00.000Z" }),
      draft({ id: "other", createdAt: "2020-01-01T12:00:00.000Z" }),
    ]);
    expect(takes.map((t) => t.id).sort()).toEqual(["other", "v2"]);
  });
});

describe("chosenOf", () => {
  it("is null while nothing is kept", () => {
    expect(chosenOf([draft({ id: "a" }), draft({ id: "b", status: "discarded" })])).toBeNull();
  });

  it("is the kept draft", () => {
    expect(chosenOf([draft({ id: "a" }), draft({ id: "k", status: "kept" })])?.id).toBe("k");
  });

  it("prefers the most recently updated kept draft — the one picked last — over a newer-created one", () => {
    // Mirrors lib/drafts.ts's chosenDraftId rule (see its test of the same name).
    const chosen = chosenOf([
      draft({ id: "created-later", status: "kept", createdAt: "2020-01-02T00:00:00.000Z", updatedAt: "2020-01-02T00:00:00.000Z" }),
      draft({ id: "picked-later", status: "kept", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-03T00:00:00.000Z" }),
    ]);
    expect(chosen?.id).toBe("picked-later");
  });
});

describe("versionChain", () => {
  it("walks parentId from the root to the given draft", () => {
    const v1 = draft({ id: "v1" });
    const v2 = draft({ id: "v2", parentId: "v1" });
    const v3 = draft({ id: "v3", parentId: "v2", status: "kept" });
    expect(versionChain(v3, [v1, v2, v3, draft({ id: "other" })]).map((d) => d.id)).toEqual(["v1", "v2", "v3"]);
  });

  it("stops at a parent that isn't loaded and survives a cycle", () => {
    const orphan = draft({ id: "v2", parentId: "missing" });
    expect(versionChain(orphan, [orphan]).map((d) => d.id)).toEqual(["v2"]);

    const a = draft({ id: "a", parentId: "b" });
    const b = draft({ id: "b", parentId: "a" });
    expect(versionChain(a, [a, b]).map((d) => d.id)).toEqual(["b", "a"]);
  });
});

describe("job helpers", () => {
  it("isInFlight is true for queued/claimed only", () => {
    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("claimed")).toBe(true);
    expect(isInFlight("done")).toBe(false);
    expect(isInFlight("failed")).toBe(false);
    expect(isInFlight(null)).toBe(false);
    expect(isInFlight(undefined)).toBe(false);
  });

  it("jobError reads a string result.error, nothing else", () => {
    expect(jobError({ id: "j", kind: "generate_from_idea", status: "failed", result: { error: "boom" } })).toBe("boom");
    expect(jobError({ id: "j", kind: "generate_from_idea", status: "failed", result: { error: 42 } })).toBeUndefined();
    expect(jobError({ id: "j", kind: "generate_from_idea", status: "done", result: null })).toBeUndefined();
    expect(jobError(null)).toBeUndefined();
  });

  it("looksLikeTranscriptError matches the agent's transcript failure loosely", () => {
    expect(looksLikeTranscriptError("Transcript unavailable for this video")).toBe(true);
    expect(looksLikeTranscriptError("rate limited")).toBe(false);
    expect(looksLikeTranscriptError(undefined)).toBe(false);
  });
});

describe("ideaLabel", () => {
  it("prefers the title, then a one-line content excerpt, then the url", () => {
    expect(ideaLabel({ title: "A talk", url: "https://youtu.be/x", content: "ignored" })).toBe("A talk");
    expect(ideaLabel({ title: null, url: "https://bsky.app/p/1", content: "first line\nsecond   line" })).toBe("first line second line");
    expect(ideaLabel({ title: null, url: "https://example.com/a", content: null })).toBe("https://example.com/a");
    expect(ideaLabel({ title: "  ", url: null, content: "" })).toBe("Untitled");
    expect(ideaLabel(null)).toBe("Untitled");
  });

  it("clamps long labels with an ellipsis", () => {
    const label = ideaLabel({ title: "x".repeat(200), url: null });
    expect(label.length).toBe(70);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats m:ss, flooring to whole seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(999)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(125_400)).toBe("2:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
  });

  it("reads 0:00 for a negative span (clock skew between browser and server)", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("generationSteps (2026-09-27: \"lo dividerei a step quando questi succedono\")", () => {
  const job = (over: { kind?: string; status: string; payload?: Record<string, unknown> | null }) =>
    ({ kind: "generate_from_idea", payload: null, ...over });

  it("waiting for the Mac while queued, whatever the kind; nothing once settled", () => {
    expect(generationSteps(job({ status: "queued" }))).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(generationSteps(job({ status: "queued", kind: "generate_from_video" }))).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(generationSteps(job({ status: "done" }))).toEqual([]);
  });

  it("then writing the takes, from the whole video for a video", () => {
    expect(generationSteps(job({ status: "claimed" }))).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Writing 3 takes", done: false },
    ]);
    expect(generationSteps(job({ status: "claimed", kind: "generate_from_video" }))[1]).toEqual({ label: "Writing 3 takes from the whole video", done: false });
  });

  it("then keeping the most human, once the agent says so (2026-09-24)", () => {
    expect(generationSteps({ ...job({ status: "claimed" }), result: { progress: { kind: "generate", phase: "checking" } } })).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Wrote the takes", done: true },
      { label: "Checking how human each one reads, to keep the 3 best", done: false },
    ]);
  });

  it("counts the takes the job asked for, singular included", () => {
    expect(generationSteps(job({ status: "claimed", payload: { count: 1 } }))[1]!.label).toBe("Writing 1 take");
    expect(takeCountOf({ kind: "generate_from_idea", payload: { count: "4" } })).toBe(3);
    expect(takeCountOf({ kind: "generate_from_idea", payload: { count: 0 } })).toBe(3);
  });

  it("is empty once the job failed too", () => {
    expect(generationSteps(job({ status: "failed" }))).toEqual([]);
  });
});

describe("agentLooksOffline", () => {
  const now = Date.parse("2026-09-23T10:00:00.000Z");

  it("is not a verdict before the settings loaded", () => {
    expect(agentLooksOffline(undefined, now)).toBe(false);
  });

  it("is offline when the agent never connected", () => {
    expect(agentLooksOffline(null, now)).toBe(true);
  });

  it("is offline once the last heartbeat is older than 3 minutes, online before", () => {
    expect(AGENT_OFFLINE_AFTER_MS).toBe(180_000);
    expect(agentLooksOffline(new Date(now - 45_000).toISOString(), now)).toBe(false);
    expect(agentLooksOffline(new Date(now - AGENT_OFFLINE_AFTER_MS).toISOString(), now)).toBe(false);
    expect(agentLooksOffline(new Date(now - AGENT_OFFLINE_AFTER_MS - 1000).toISOString(), now)).toBe(true);
    expect(agentLooksOffline("2026-09-23T09:00:00.000Z", now)).toBe(true);
  });
});

describe("agentOfflineHint", () => {
  it("says the job waits for the agent", () => {
    expect(agentOfflineHint(false)).toBe("Your Mac agent looks offline — the job starts when it comes back.");
  });

  it("adds where to open PostEcho only when the page couldn't reach the agent", () => {
    expect(agentOfflineHint(true)).toBe(
      "Your Mac agent looks offline — the job starts when it comes back. Open PostEcho in Chrome on the computer where the agent runs.",
    );
  });
});

describe("persisted slop", () => {
  const scored = draft({ id: "s", xText: "hi", meta: { slop: { platform: "x", verdict: "human", slopScore: 12.4, at: "2026-09-23T00:00:00Z" } } });

  it("slopOf reads meta.slop with its platform, generic when none was recorded", () => {
    expect(slopOf(scored)).toEqual({ verdict: "human", slopScore: 12.4, platform: "x" });
    expect(slopOf(draft({ id: "g", meta: { slop: { verdict: "slop", slopScore: 80 } } }))?.platform).toBe("generic");
    expect(slopOf(draft({ id: "n" }))).toBeNull();
    expect(slopOf(draft({ id: "b", meta: { slop: { verdict: "human" } } }))).toBeNull();
  });

  it("persistedSlop only matches the platform it was scored for", () => {
    expect(persistedSlop(scored, "x")).toEqual({ verdict: "human", slopScore: 12.4 });
    expect(persistedSlop(scored, "linkedin")).toBeNull();
  });

  it("slopFor reads meta.slopByPlatform first, so an X check never hides LinkedIn's score (M3.7)", () => {
    const both = draft({ id: "b2", meta: {
      slop: { platform: "x", verdict: "human", slopScore: 10 },
      slopByPlatform: { x: { verdict: "human", slopScore: 10 }, linkedin: { verdict: "slop", slopScore: 70 } },
    } });
    expect(slopFor(both, "linkedin")).toEqual({ verdict: "slop", slopScore: 70 });
    expect(slopFor(both, "x")).toEqual({ verdict: "human", slopScore: 10 });
    expect(slopFor(scored, "x")).toEqual({ verdict: "human", slopScore: 12.4 });
    expect(slopFor(draft({ id: "bad", meta: { slopByPlatform: { x: { verdict: 1 } } } }), "x")).toBeNull();
  });
});

describe("slop-check queue", () => {
  it("slopCheckTarget scores the X text, the LinkedIn text when X is missing, nothing for an empty take", () => {
    expect(slopCheckTarget(draft({ id: "a", xText: "short", linkedinText: "long" }))).toEqual({ draftId: "a", platform: "x", text: "short" });
    expect(slopCheckTarget(draft({ id: "b", xText: "  ", linkedinText: "long" }))).toEqual({ draftId: "b", platform: "linkedin", text: "long" });
    expect(slopCheckTarget(draft({ id: "c" }))).toBeNull();
  });

  it("nextSlopCheck picks the first take in row order without a persisted result", () => {
    const takes = [
      draft({ id: "t1", xText: "one", meta: { slop: { platform: "x", verdict: "human", slopScore: 10 } } }),
      draft({ id: "t2", xText: "two" }),
      draft({ id: "t3", xText: "three" }),
    ];
    expect(nextSlopCheck(takes, new Set())).toEqual({ draftId: "t2", platform: "x", text: "two" });
  });

  it("never re-checks a take that already carries meta.slop, whichever platform it was scored for", () => {
    const linkedinScored = draft({ id: "t1", xText: "one", linkedinText: "uno", meta: { slop: { platform: "linkedin", verdict: "borderline", slopScore: 40 } } });
    expect(nextSlopCheck([linkedinScored], new Set())).toBeNull();
  });

  it("skips takes already attempted this session and empty takes, one at a time", () => {
    const takes = [draft({ id: "t1", xText: "one" }), draft({ id: "empty" }), draft({ id: "t2", linkedinText: "two" })];
    expect(nextSlopCheck(takes, new Set(["t1"]))?.draftId).toBe("t2");
    expect(nextSlopCheck(takes, new Set(["t1", "t2"]))).toBeNull();
    expect(nextSlopCheck([], new Set())).toBeNull();
  });
});

describe("humanizeInstruction", () => {
  it("substitutes the platform and stays under the revise route's 500-character cap", () => {
    const x = humanizeInstruction("x");
    expect(x.startsWith("Rewrite the X text so it reads like a specific person wrote it:")).toBe(true);
    expect(x.endsWith("Change only the X text.")).toBe(true);
    expect(x).toContain('no "not X, but Y"');
    expect(x.length).toBeLessThanOrEqual(500);

    const linkedin = humanizeInstruction("linkedin");
    expect(linkedin.startsWith("Rewrite the LinkedIn text")).toBe(true);
    expect(linkedin.endsWith("Change only the LinkedIn text.")).toBe(true);
    expect(linkedin.length).toBeLessThanOrEqual(500);
  });
});
