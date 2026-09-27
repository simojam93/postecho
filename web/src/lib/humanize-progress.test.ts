import { describe, expect, it } from "vitest";
import { humanizePhaseText, humanizeProgressOf, scoreTrail } from "@/lib/humanize-progress";

const claimed = (progress: Record<string, unknown> | null) => ({ status: "claimed", result: progress ? { progress } : null });
const progress = (over: Record<string, unknown> = {}) => ({
  kind: "humanize", round: 1, maxRounds: 3, phase: "rewriting", rounds: [], ...over,
});

describe("humanizeProgressOf", () => {
  it("reads the agent's progress off a claimed job", () => {
    expect(humanizeProgressOf(claimed(progress({ round: 2, phase: "checking", rounds: [{ round: 1, slopScore: 58, verdict: "borderline" }] })))).toEqual({
      round: 2, maxRounds: 3, phase: "checking",
      rounds: [{ round: 1, slopScore: 58, verdict: "borderline" }], platform: null,
    });
  });

  it("null for queued/settled jobs, missing or foreign progress", () => {
    expect(humanizeProgressOf({ status: "queued", result: { progress: progress() } })).toBeNull();
    expect(humanizeProgressOf({ status: "done", result: { text: "x" } })).toBeNull();
    expect(humanizeProgressOf(claimed(null))).toBeNull();
    expect(humanizeProgressOf(claimed({ kind: "something-else", round: 1, maxRounds: 3 }))).toBeNull();
  });

  it("drops malformed rounds", () => {
    const p = humanizeProgressOf(claimed(progress({ rounds: [null, { round: 1, slopScore: "x" }, { nope: 1 }] })))!;
    expect(p.rounds).toEqual([{ round: 1, slopScore: null, verdict: null }]);
  });
});

describe("humanizePhaseText", () => {
  it("queued, claimed without progress, round 1, a retry, and checking", () => {
    expect(humanizePhaseText({ status: "queued", result: null })).toBe("Waiting for your Mac agent to pick this up…");
    expect(humanizePhaseText(claimed(null), "the X text")).toBe("PostEcho is rewriting the X text to sound like a person…");
    expect(humanizePhaseText(claimed(progress()))).toBe("Round 1 of 3 · PostEcho is rewriting it…");
    expect(humanizePhaseText(claimed(progress({ round: 2, rounds: [{ round: 1, slopScore: 58, verdict: "borderline" }] }))))
      .toBe("Round 2 of 3 · The last try read Mixed 4/10, so PostEcho is trying again…");
    expect(humanizePhaseText(claimed(progress({ platform: "linkedin" }))))
      .toBe("LinkedIn · Round 1 of 3 · PostEcho is rewriting it…");
    expect(humanizePhaseText(claimed(progress({ phase: "checking" })))).toBe("Round 1 of 3 · PostEcho is checking the rewrite…");
  });

  it("null once the job has settled", () => {
    expect(humanizePhaseText({ status: "done", result: { text: "x" } })).toBeNull();
    expect(humanizePhaseText({ status: "failed", result: { error: "x" } })).toBeNull();
  });
});

describe("scoreTrail / a chat edit's phase", () => {
  it("each round as a human score out of 10, unscored rounds as ?", () => {
    expect(scoreTrail([{ round: 1, slopScore: 48.4, verdict: "borderline" }, { round: 2, slopScore: 22, verdict: "human" }])).toBe("5 → 8");
    expect(scoreTrail([{ round: 1, slopScore: null, verdict: null }])).toBe("?");
    expect(scoreTrail([])).toBe("");
  });

  it("a chat edit's progress reads as its mode", () => {
    expect(humanizePhaseText(claimed({ kind: "edit", mode: "sync_linkedin", phase: "rewriting" })))
      .toBe("PostEcho is rewriting LinkedIn from your X, with the source for detail…");
    expect(humanizePhaseText(claimed({ kind: "edit", mode: "custom", phase: "checking" }))).toBe("PostEcho is checking the new version…");
  });
});
