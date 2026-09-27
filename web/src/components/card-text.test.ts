import { describe, expect, it } from "vitest";
import { cardText } from "./card-text";

describe("a card's text (2026-09-27: \"Show HN:\" — \"questo toglilo\")", () => {
  it("drops Hacker News's Show/Launch tag and decodes entities; Ask HN stays a question", () => {
    expect(cardText("Show HN: A teleprompter for Mac — it follows your voice")).toBe("A teleprompter for Mac — it follows your voice");
    expect(cardText("Launch HN: Acme (YC W25) &amp; friends")).toBe("Acme (YC W25) & friends");
    expect(cardText("Ask HN: How do you price a dev tool?")).toBe("Ask HN: How do you price a dev tool?");
    expect(cardText("A post that shows HN: in the middle")).toBe("A post that shows HN: in the middle");
  });
});
