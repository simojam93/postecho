import { describe, expect, it } from "vitest";
import { keptTakes, MAX_TAKES, takeLines, takeSlopScore, type TakeDraftLike } from "@/lib/takes";

let clock = 0;
function draft(id: string, extra: Partial<TakeDraftLike> & { score?: number } = {}): TakeDraftLike {
  const { score, ...rest } = extra;
  clock += 1000;
  return {
    id,
    parentId: null,
    status: "candidate",
    xText: `take ${id}`,
    linkedinText: null,
    meta: score === undefined ? {} : { slop: { platform: "x", slopScore: score, verdict: "x" } },
    createdAt: new Date(Date.UTC(2026, 8, 24) + clock).toISOString(),
    ...rest,
  };
}

describe("takeSlopScore", () => {
  it("reads the previewed platform's own score, else the draft's single one", () => {
    expect(takeSlopScore(draft("a", { meta: { slopByPlatform: { x: { slopScore: 20 } }, slop: { slopScore: 70 } } }))).toBe(20);
    expect(takeSlopScore(draft("b", { meta: { slop: { platform: "linkedin", slopScore: 40 } } }))).toBe(40);
    expect(takeSlopScore(draft("c", { xText: null, linkedinText: "li", meta: { slopByPlatform: { linkedin: { slopScore: 35 } } } }))).toBe(35);
    expect(takeSlopScore(draft("d"))).toBeNull();
  });
});

describe("takeLines", () => {
  it("groups each take with its versions and shows the chosen one, else the newest", () => {
    const root = draft("r");
    const v2 = draft("v2", { parentId: "r", status: "candidate" });
    const v3 = draft("v3", { parentId: "v2", status: "kept" });
    const other = draft("o");
    const lines = takeLines([root, v2, v3, other], "v3");
    expect(lines.map((l) => [l.rootId, l.drafts.map((d) => d.id), l.shown.id])).toEqual([
      ["r", ["r", "v2", "v3"], "v3"],
      ["o", ["o"], "o"],
    ]);
    // Not chosen: the newest version.
    expect(takeLines([root, v2, other], null)[0].shown.id).toBe("v2");
  });

  it("follows a line through a discarded version, and leaves discarded and used drafts out", () => {
    const root = draft("r", { status: "discarded" });
    const v2 = draft("v2", { parentId: "r" });
    const used = draft("u", { status: "used" });
    expect(takeLines([root, v2, used], null).map((l) => [l.rootId, l.shown.id])).toEqual([["r", "v2"]]);
  });
});

describe("keptTakes", () => {
  it("keeps the most human three, best first, and drops the rest", () => {
    const drafts = [draft("a", { score: 70 }), draft("b", { score: 10 }), draft("c", { score: 40 }), draft("d", { score: 25 }), draft("e", { score: 90 })];
    const { keep, drop } = keptTakes(drafts, null);
    expect(keep.map((l) => l.rootId)).toEqual(["b", "d", "c"]);
    expect(drop.map((l) => l.rootId).sort()).toEqual(["a", "e"]);
    expect(MAX_TAKES).toBe(3);
  });

  it("always keeps the chosen take, whatever its score, and fills the rest with the best others", () => {
    const chosenRoot = draft("chosen", { score: 95 });
    const edit = draft("edit", { parentId: "chosen", status: "kept", score: 80 });
    const drafts = [chosenRoot, edit, draft("a", { score: 10 }), draft("b", { score: 20 }), draft("c", { score: 30 })];
    const { keep, drop } = keptTakes(drafts, "edit");
    expect(keep.map((l) => l.rootId)).toEqual(["a", "b", "chosen"]);
    expect(keep.find((l) => l.rootId === "chosen")!.shown.id).toBe("edit");
    expect(drop.map((l) => l.rootId)).toEqual(["c"]);
  });

  it("ranks an unscored take as middling, and the newer first on a tie", () => {
    const drafts = [draft("good", { score: 30 }), draft("old", { score: 50 }), draft("unscored"), draft("bad", { score: 80 })];
    expect(keptTakes(drafts, null).keep.map((l) => l.rootId)).toEqual(["good", "unscored", "old"]);
  });
});
