import { describe, expect, it } from "vitest";
import { humanLabel, humanScore, humanText, humanTrail } from "@/lib/human-score";

describe("human score (0-10, higher is more human)", () => {
  it("inverts and rescales Jev's slopScore", () => {
    expect(humanScore(16)).toBe(8);
    expect(humanScore(0)).toBe(10);
    expect(humanScore(100)).toBe(0);
    expect(humanScore(35)).toBe(7);
    expect(humanScore(64)).toBe(4);
    expect(humanScore(-5)).toBe(10);
    expect(humanScore(130)).toBe(0);
  });

  it("the label follows the number", () => {
    expect([10, 7, 6, 4, 3, 0].map(humanLabel)).toEqual(["Human", "Human", "Mixed", "Mixed", "AI", "AI"]);
    expect(humanText(16)).toBe("Human 8/10");
    expect(humanText(55)).toBe("Mixed 5/10");
    expect(humanText(98)).toBe("AI 0/10");
  });

  it("trails read as human scores", () => {
    expect(humanTrail([72, 58, 22])).toBe("3 → 4 → 8");
    expect(humanTrail([100, null])).toBe("0 → ?");
  });
});
