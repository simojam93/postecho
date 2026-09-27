import { describe, expect, it } from "vitest";
import { videoPostSteps } from "./video-steps";

const at = (phase: string, read: Record<string, unknown>) =>
  videoPostSteps({ status: "claimed", payload: { count: 12 }, result: { progress: { kind: "video_ideas", phase, ...read } } });

describe("videoPostSteps (2026-09-27: \"1. extracting script in english 2. analysing script\")", () => {
  it("waiting for the Mac, extracting the script, writing the posts, Jev's check", () => {
    expect(videoPostSteps({ status: "queued", payload: { count: 12 } })).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(videoPostSteps({ status: "claimed", payload: { count: 12 } })).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Extracting the script", done: false },
    ]);
    expect(at("writing", { source: "transcript", lang: "en" })).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Extracted the script in English", done: true },
      { label: "Writing the 12 best posts from the script", done: false },
    ]);
    expect(at("checking", { source: "transcript", lang: "en" })).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Extracted the script in English", done: true },
      { label: "Wrote the posts", done: true },
      { label: "Checking how human each one reads, to keep the 12 best", done: false },
    ]);
  });

  it("says what it read: the language, a pasted script, the description", () => {
    expect(at("writing", { source: "transcript", lang: "it" })[1]!.label).toBe("Extracted the script in Italian");
    expect(at("writing", { source: "transcript", lang: null })[1]!.label).toBe("Extracted the script");
    expect(at("writing", { source: "transcript", pasted: true })[1]!.label).toBe("Read the script you pasted");
    const described = at("writing", { source: "description" });
    expect(described[1]!.label).toBe("No script on YouTube, so it read the description");
    expect(described[2]!.label).toBe("Writing the 12 best posts from the description");
    expect(videoPostSteps({ status: "done", payload: {} })).toEqual([]);
  });
});
