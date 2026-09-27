import { describe, expect, it } from "vitest";
import { inspirationForAnalysis, inspirationSinceAnalysis, referencesForAgent, type ReferenceItem, type StyleInspirationItem } from "@/lib/library";

const ref = (id: string, text: string, enabled = true): ReferenceItem => ({ id, name: id, text, enabled, addedAt: "2026-09-24T00:00:00Z" });
const insp = (id: string, addedAt: string, text = `post ${id}`): StyleInspirationItem =>
  ({ id, ideaId: id, text, author: null, url: null, kind: "bluesky", slopScore: null, addedAt });

describe("referencesForAgent", () => {
  it("enabled items in order, whole while they fit, the last one cut at the budget", () => {
    const out = referencesForAgent([ref("a", "aaaa"), ref("off", "zzzz", false), ref("b", "bbbbbbbb"), ref("c", "cc")], 8);
    expect(out).toEqual([{ name: "a", text: "aaaa" }, { name: "b", text: "bbbb …" }]);
  });

  it("skips blank items", () => {
    expect(referencesForAgent([ref("blank", "   "), ref("a", "text")])).toEqual([{ name: "a", text: "text" }]);
  });
});

describe("style inspiration for the analysis", () => {
  it("the newest twelve, each bounded", () => {
    const items = Array.from({ length: 15 }, (_, i) => insp(String(i), "2026-09-24T00:00:00Z", i === 0 ? "x".repeat(900) : `post ${i}`));
    const texts = inspirationForAnalysis(items);
    expect(texts).toHaveLength(12);
    expect(texts[0]).toBe(`${"x".repeat(800)} …`);
  });

  it("counts what was added after the last analysis, everything when never analyzed", () => {
    const items = [insp("new", "2026-09-24T10:00:00Z"), insp("old", "2026-09-20T10:00:00Z")];
    expect(inspirationSinceAnalysis(items, "2026-09-22T00:00:00Z")).toBe(1);
    expect(inspirationSinceAnalysis(items, null)).toBe(2);
  });
});
