import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StyleSuggestionView } from "./style-learning";
import type { StyleLearningStatus } from "@/lib/style-learning";

const idle: StyleLearningStatus = { proposal: null, running: false, choices: 12, newChoices: 7, learnedAt: null, needed: 15 };
const proposal = {
  guide: "Short sentences.\nOpen with a number.",
  changes: [{ summary: "Open with a number", reason: "7 of 10 posts you kept do, 1 of 9 you dropped." }],
  lessons: [{ trait: "numbers", value: "yes", direction: "more" as const, lift: 4.5, text: "Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped." }],
  basedOn: 19,
  createdAt: "2026-09-27T09:00:00.000Z",
};

function view(status: StyleLearningStatus, showGuide = false) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(StyleSuggestionView, {
    status, savedGuide: "Short sentences.\nNo emoji.", showGuide, busy: false, error: null, onToggleGuide: noop, onApply: noop, onDismiss: noop,
  }));
}

describe("StyleSuggestionView", () => {
  it("without a suggestion, nothing (2026-09-27: \"viene già detto da altre parti\")", () => {
    expect(view(idle)).toBe("");
    expect(view({ ...idle, running: true })).toBe("");
  });

  it("the changes with their reasons, the evidence, Apply and Dismiss; the new guide line by line when opened", () => {
    const closed = view({ ...idle, proposal });
    expect(closed).toContain("Suggested update");
    expect(closed).toContain("From 19 takes you picked and dropped.");
    expect(closed).toContain("Open with a number");
    expect(closed).toContain("7 of 10 posts you kept do, 1 of 9 you dropped.");
    expect(closed).toContain("Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped.");
    expect(closed).toContain(">Apply</button>");
    expect(closed).toContain(">Dismiss</button>");
    expect(closed).toContain("See the new guide");
    expect(closed).not.toContain("line-through");

    const open = view({ ...idle, proposal }, true);
    expect(open).toContain("Hide the new guide");
    expect(open).toMatch(/line-through[^>]*>.*No emoji\./);
    expect(open).toMatch(/bg-ok\/10[^>]*>.*Open with a number\./);
  });
});
