import { describe, expect, it } from "vitest";
import { clampText } from "@/lib/sources/adapter";

describe("clampText cuts where a reader would (2026-09-27)", () => {
  it("after the last whole sentence that fits, else at a word with …", () => {
    const cut = clampText("One short sentence. ".repeat(40), 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("sentence.")).toBe(true);
    expect(clampText("word ".repeat(30), 50)).toBe(`${"word ".repeat(10).trim()}…`);
    expect(clampText("  short  ", 50)).toBe("short");
  });

  it("a text with no break in it is cut at the cap, still with …", () => {
    expect(clampText("d".repeat(700))).toBe(`${"d".repeat(599)}…`);
  });
});
