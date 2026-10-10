import { describe, expect, it } from "vitest";
import { isVoice, voiceOfIdea } from "@/lib/voice";

describe("voiceOfIdea", () => {
  it("defaults by origin: the owner's note is theirs, anything else is a reaction", () => {
    expect(voiceOfIdea({ kind: "note", meta: {} })).toBe("mine");
    expect(voiceOfIdea({ kind: "hackernews", meta: {} })).toBe("reaction");
    expect(voiceOfIdea(null)).toBe("reaction");
    // A video's ready post is written as the owner's own idea (2026-09-27); a topic from before is a reaction.
    expect(voiceOfIdea({ kind: "video_idea", meta: { format: "post" } })).toBe("mine");
    expect(voiceOfIdea({ kind: "video_idea", meta: {} })).toBe("reaction");
    // A post from the owner's own repo is theirs (2026-10-10).
    expect(voiceOfIdea({ kind: "repo_post", meta: { format: "x" } })).toBe("mine");
  });

  it("a voice chosen on the idea wins, then the version's", () => {
    expect(voiceOfIdea({ kind: "hackernews", meta: { voice: "mine" } })).toBe("mine");
    expect(voiceOfIdea({ kind: "note", meta: {} }, "reaction")).toBe("reaction");
    expect(voiceOfIdea({ kind: "note", meta: { voice: "bogus" } }, "bogus")).toBe("mine");
    expect(isVoice("mine")).toBe(true);
    expect(isVoice("first")).toBe(false);
  });
});
