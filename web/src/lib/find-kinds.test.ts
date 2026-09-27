import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_ORDER, FIND_KINDS, jevKinds, moveKind, normalizeOrder, weightAt } from "@/lib/find-kinds";
import { SETTING_DEFAULTS } from "@/lib/settings";

describe("the kinds Find Ideas tells apart (2026-09-26)", () => {
  it("defaults to the owner's order: stories, opinions, problems, news, tools", () => {
    expect(DEFAULT_FIND_ORDER).toEqual(["story", "opinion", "problem", "news", "tool"]);
    expect(SETTING_DEFAULTS.findOrder).toEqual(DEFAULT_FIND_ORDER);
    expect(FIND_KINDS.map((k) => k.name)).toEqual([
      "Real stories with numbers", "Strong opinions", "Practical problems", "News and launches", "Tools and guides",
    ]);
  });

  it("weighs each position: the first three close, the last two well below", () => {
    expect([0, 1, 2, 3, 4].map(weightAt)).toEqual([1, 0.9, 0.8, 0.5, 0.3]);
  });

  it("normalizes any stored order into a valid one", () => {
    expect(normalizeOrder(["news", "story", "opinion", "problem", "tool"])).toEqual(["news", "story", "opinion", "problem", "tool"]);
    // Unknown ids and repeats drop out; the missing ones follow in default order.
    expect(normalizeOrder(["tool", "poems", "tool", "story"])).toEqual(["tool", "story", "opinion", "problem", "news"]);
    expect(normalizeOrder(null)).toEqual(DEFAULT_FIND_ORDER);
    expect(normalizeOrder("story")).toEqual(DEFAULT_FIND_ORDER);
  });

  it("turns an order into Jev's kinds, the catch-all last", () => {
    const kinds = jevKinds(["opinion", "story", "problem", "news", "tool"]);
    expect(kinds.map((k) => [k.label, k.weight])).toEqual([
      ["opinion", 1], ["story", 0.9], ["problem", 0.8], ["news", 0.5], ["tool", 0.3], ["other", 0.15],
    ]);
    expect(kinds[0].description).toMatch(/opinion/);
  });

  it("moves a kind up or down, within the list, without touching the original", () => {
    const order = [...DEFAULT_FIND_ORDER];
    expect(moveKind(order, 2, 0)).toEqual(["problem", "story", "opinion", "news", "tool"]);
    expect(moveKind(order, 0, 1)).toEqual(["opinion", "story", "problem", "news", "tool"]);
    expect(moveKind(order, 4, 9)).toEqual(order);
    expect(moveKind(order, 0, -1)).toEqual(order);
    expect(moveKind(order, 7, 0)).toEqual(order);
    expect(order).toEqual(DEFAULT_FIND_ORDER);
  });
});
