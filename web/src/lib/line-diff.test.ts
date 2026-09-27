import { describe, expect, it } from "vitest";
import { lineDiff } from "@/lib/line-diff";

describe("lineDiff", () => {
  it("keeps what's in both, and marks what went and what came, in reading order", () => {
    expect(lineDiff("Short sentences.\nNo emoji.\nEnd plainly.", "Short sentences.\nOpen with a number.\nEnd plainly.")).toEqual([
      { kind: "same", text: "Short sentences." },
      { kind: "removed", text: "No emoji." },
      { kind: "added", text: "Open with a number." },
      { kind: "same", text: "End plainly." },
    ]);
  });

  it("a first guide is all new; trailing spaces and Windows line ends aren't changes", () => {
    expect(lineDiff("", "One.\nTwo.")).toEqual([{ kind: "added", text: "One." }, { kind: "added", text: "Two." }]);
    expect(lineDiff("One.  \r\nTwo.", "One.\nTwo.")).toEqual([{ kind: "same", text: "One." }, { kind: "same", text: "Two." }]);
    expect(lineDiff("Gone.", " ")).toEqual([{ kind: "removed", text: "Gone." }]);
  });
});
