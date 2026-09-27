import { describe, expect, it } from "vitest";
import { handlesIn, isXHandle, splitHandles, tagSearchUrl, withXAuthor, xAuthorHandle, xProfileUrl } from "@/lib/x-handles";

describe("handlesIn / splitHandles", () => {
  it("finds the tagged handles, each once, and leaves emails and paths alone", () => {
    const text = "Loved @karpathy's point (cc @AnthropicAI, @karpathy). Mail me@site.com or see x.com/@nope — @toolonghandle_12345 too.";
    expect(handlesIn(text)).toEqual(["karpathy", "AnthropicAI"]);
    expect(handlesIn("@start works")).toEqual(["start"]);
  });

  it("splits a text into plain runs and handles, losing nothing", () => {
    const parts = splitHandles("Hi @a_b, and @C.");
    expect(parts).toEqual([{ text: "Hi " }, { handle: "a_b" }, { text: ", and " }, { handle: "C" }, { text: "." }]);
    const joined = parts.map((p) => ("handle" in p ? `@${p.handle}` : p.text)).join("");
    expect(joined).toBe("Hi @a_b, and @C.");
    expect(splitHandles("no tags")).toEqual([{ text: "no tags" }]);
  });
});

describe("links", () => {
  it("links a profile, and searches a name on X or LinkedIn through Google", () => {
    expect(xProfileUrl("karpathy")).toBe("https://x.com/karpathy");
    expect(decodeURIComponent(tagSearchUrl("Andrej Karpathy", "x"))).toBe('https://www.google.com/search?q="Andrej Karpathy" site:x.com');
    expect(decodeURIComponent(tagSearchUrl('Plausible "Analytics"', "linkedin"))).toBe('https://www.google.com/search?q="Plausible Analytics" site:linkedin.com');
    expect(isXHandle("good_1")).toBe(true);
    expect(isXHandle("bad handle")).toBe(false);
  });
});

describe("xAuthorHandle / withXAuthor", () => {
  it("reads an X post's author from its link, else from an @author", () => {
    expect(xAuthorHandle({ kind: "x_post", url: "https://x.com/levelsio/status/123", author: "Pieter Levels" })).toBe("levelsio");
    expect(xAuthorHandle({ kind: "x_post", url: "https://twitter.com/levelsio/status/123", author: null })).toBe("levelsio");
    expect(xAuthorHandle({ kind: "x_post", url: "https://x.com/i/status/123", author: "@karpathy" })).toBe("karpathy");
    expect(xAuthorHandle({ kind: "x_post", url: "https://x.com/i/status/123", author: "Someone" })).toBeNull();
    expect(xAuthorHandle({ kind: "bluesky", url: "https://bsky.app/profile/a.bsky.social/post/1", author: "@a" })).toBeNull();
  });

  it("names the author above the source text, for X posts only", () => {
    const idea = { kind: "x_post", url: "https://x.com/levelsio/status/123", author: null };
    expect(withXAuthor("Shipped it.", idea)).toBe("Post on X by @levelsio:\nShipped it.");
    expect(withXAuthor("Shipped it.", { ...idea, kind: "hackernews" })).toBe("Shipped it.");
  });
});
