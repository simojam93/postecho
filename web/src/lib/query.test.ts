import { describe, expect, it } from "vitest";
import { deriveQuery, queryFromUrlSlug, queryVariants, seedTextFromEnriched } from "@/lib/query";
import type { Enriched } from "@/lib/enrich";

describe("deriveQuery", () => {
  it("strips a link, a mention, and turns a hashtag into a plain word, then ranks by frequency", () => {
    const seed =
      "Check out #voicecloning voicecloning voicecloning! Amazing results from @jevmodel http://example.com/post/1";
    // voicecloning appears 3x (highest frequency, plus the hashtag bonus);
    // "out", "check" and "from" are stopwords, and so is the hype word
    // "amazing" (2026-09-24); the url and mention are gone entirely.
    expect(deriveQuery(seed)).toBe("voicecloning results");
  });

  it("handles an Italian idea sentence (embedded IT stopword list)", () => {
    const seed =
      "Sto pensando a una strategia di marketing digitale per aumentare le vendite online, marketing e crescita";
    // "pensando" is a stopword as of review round 2 (generic "thinking about
    // it" filler, not a topic) — "vendite" takes its place in the top 5. The
    // five are written in the sentence's own order (2026-09-24).
    expect(deriveQuery(seed)).toBe("strategia marketing digitale aumentare vendite");
  });

  it("handles an article title", () => {
    const seed = "The Future of Remote Work: How Companies Are Rethinking Office Culture in 2026";
    expect(deriveQuery(seed)).toBe("future remote work companies rethinking");
  });

  it("falls back to the first 5 raw non-URL words when everything is a stopword", () => {
    expect(deriveQuery("The And For That With This")).toBe("the and for that with");
  });

  it("falls back to raw words dropping an embedded url even when all remaining words are stopwords", () => {
    expect(deriveQuery("The and for http://example.com/x that with this")).toBe("the and for that with");
  });

  it("is deterministic — same input always yields the same output", () => {
    const seed = "Check out #voicecloning voicecloning voicecloning! Amazing results from @jevmodel";
    expect(deriveQuery(seed)).toBe(deriveQuery(seed));
  });

  it("caps the result at 80 characters", () => {
    const words = [
      "internationalization",
      "characterization",
      "professionalization",
      "conceptualization",
      "institutionalization",
    ];
    const seed = words.join(" ");
    expect(seed.length).toBeGreaterThan(80);
    const result = deriveQuery(seed);
    expect(result.length).toBeLessThanOrEqual(80);
    // Capped output is a trimmed prefix of the uncapped join — pins the
    // slice(0, 80).trim() semantics without hand-computing the exact cut.
    expect(seed.startsWith(result)).toBe(true);
  });

  it("drops a short token that ISN'T a recognized acronym (general length rule still applies)", () => {
    expect(deriveQuery("xy xy xy podcast growth strategy launch")).toBe("podcast growth strategy launch");
  });

  it("returns an empty string for a bare url with nothing else to fall back to", () => {
    expect(deriveQuery("https://example.com/some/post")).toBe("");
  });

  describe("elisions and contractions (review round 2)", () => {
    it("drops Italian elision lead-ins as a unit, not as stray 'sull'/'dell' fragments", () => {
      const seed = "Un'idea sull'automazione e sull'intelligenza artificiale per le aziende";
      const result = deriveQuery(seed);
      expect(result).not.toMatch(/\bsull\b/);
      expect(result).not.toMatch(/\bdell\b/);
      for (const word of ["automazione", "intelligenza", "artificiale", "aziende"]) {
        expect(result).toContain(word);
      }
    });

    it("drops a mapped English contraction entirely, leaving no 'don'/'t' fragment", () => {
      const result = deriveQuery("I don't think this startup idea will work");
      expect(result).not.toMatch(/\bdon\b/);
      expect(result).not.toMatch(/\bt\b/);
    });

    it("keeps the base of an unmapped English contraction, dropping only the tail", () => {
      // "creator's" isn't in the drop-map, so the tail is stripped and the
      // base survives as a candidate.
      const result = deriveQuery("Every creator's worst enemy is inconsistency");
      expect(result).toContain("creator");
      expect(result).not.toMatch(/\bcreator's\b/);
    });
  });

  describe("short acronym allow-list (review round 2)", () => {
    it("keeps 'ai' from a hyphenated compound, splitting it into both parts", () => {
      const result = deriveQuery("How to Build an AI-Native Services Company");
      expect(result).toContain("ai");
      expect(result).toContain("native");
    });

    it("keeps a 2-letter acronym that came from a hashtag", () => {
      const result = deriveQuery("#AI #voicecloning");
      expect(result).toContain("ai");
      expect(result).toContain("voicecloning");
    });
  });

  describe("salience bonuses (review round 2)", () => {
    it("ranks a hashtagged word first even against a longer plain-text tail", () => {
      const result = deriveQuery("#voicecloning shipped today, check it out");
      expect(result.split(" ")[0]).toBe("voicecloning");
    });

    it("ranks acronyms/compound nouns from a real paragraph into the top 5", () => {
      const seed =
        "I've spent the last five years scaling B2B SaaS companies. The lesson: distribution beats product. " +
        "Your go-to-market strategy matters more than features.";
      const result = deriveQuery(seed).split(" ");
      const required = ["b2b", "saas", "distribution", "product", "strategy"];
      const hits = required.filter((w) => result.includes(w));
      expect(hits.length).toBeGreaterThanOrEqual(3);
    });

    it("ranks a word Capitalized mid-sentence above one merely sentence-initial, at equal frequency", () => {
      // "Honestly" is sentence-initial (no bonus); "Marketing"/"Advertising"
      // are Capitalized mid-sentence (+2 bonus) — every content word occurs
      // once, so the bonus alone decides who makes the five when there are
      // more candidates than that: the two capitalized ones get in, the last
      // plain words fall out. The five are then written in the sentence's order.
      const seed = "Honestly Marketing and Advertising and Pricing and Branding and Sales win";
      // Five capitalized mid-sentence words outrank the sentence-initial one, so it is the one left out.
      expect(deriveQuery(seed)).toBe("marketing advertising pricing branding sales");
    });

    it("writes the chosen words in the order they were typed, and drops instruction and hype words (2026-09-24)", () => {
      expect(deriveQuery("find interesting viral computer use agents and how people use them")).toBe("computer use agents");
      expect(deriveQuery("find viral computer use agents posts")).toBe("computer use agents");
      expect(deriveQuery("cerca post virali e interessanti su pricing SaaS")).toBe("pricing saas");
      // Still a fixed point on its own output (the chips' ↻ Search again relies on it).
      expect(deriveQuery(deriveQuery("find interesting viral computer use agents"))).toBe("computer use agents");
    });
  });
});

describe("queryVariants", () => {
  it("builds full/top-3/top-2/single-term variants, ordered and deduped, from a 5-term derived query", () => {
    const seed = "The Future of Remote Work: How Companies Are Rethinking Office Culture in 2026";
    // deriveQuery(seed) is pinned to "future remote work companies rethinking" by
    // the deriveQuery test above — reused here so this test doesn't have to
    // re-derive the ranking itself, just the variant expansion on top of it.
    expect(deriveQuery(seed)).toBe("future remote work companies rethinking");
    expect(queryVariants(seed)).toEqual([
      "future remote work companies rethinking",
      "future remote work",
      "future remote",
      "future",
      "remote",
      "work",
    ]);
  });

  it("collapses to a single variant when the derived query is already one term", () => {
    expect(deriveQuery("voicecloning")).toBe("voicecloning");
    expect(queryVariants("voicecloning")).toEqual(["voicecloning"]);
  });

  it("dedupes full/top-3/top-2 when they coincide, and drops a single-term variant under 3 chars", () => {
    // "ai" is 2-letter acronym-allowlisted so deriveQuery keeps it, but alone
    // it's too short/broad to search a source with — see MIN length skip below.
    expect(deriveQuery("ai audio")).toBe("ai audio");
    expect(queryVariants("ai audio")).toEqual(["ai audio", "audio"]);
  });

  it("returns [] when the derived query is empty (nothing left to search with)", () => {
    expect(queryVariants("")).toEqual([]);
    expect(queryVariants("https://example.com/some/post")).toEqual([]);
  });

  it("is deterministic", () => {
    const seed = "Check out #voicecloning voicecloning voicecloning! Amazing results from @jevmodel";
    expect(queryVariants(seed)).toEqual(queryVariants(seed));
  });
});

describe("queryFromUrlSlug", () => {
  it("drops a file extension from the slug and gives up on a slug that is only an id-like stub", () => {
    expect(queryFromUrlSlug("https://example.com/blog/remote-work.html")).toBe("remote work");
    expect(queryFromUrlSlug("https://www.paulgraham.com/ds.html")).toBe("");
  });

  it("mines the last path segment, dropping stopwords", () => {
    expect(queryFromUrlSlug("https://example.com/blog/the-future-of-remote-work")).toBe("future remote work");
  });

  it("walks back past a trailing numeric id to find the real slug", () => {
    expect(queryFromUrlSlug("https://example.com/blog/the-future-of-remote-work/48213")).toBe("future remote work");
  });

  it("returns an empty string when every path segment is id-like", () => {
    expect(queryFromUrlSlug("https://example.com/12345/67890")).toBe("");
  });

  it("returns an empty string for a root url with no path", () => {
    expect(queryFromUrlSlug("https://example.com")).toBe("");
  });

  it("returns an empty string for an unparsable url", () => {
    expect(queryFromUrlSlug("not a url")).toBe("");
  });
});

describe("seedTextFromEnriched", () => {
  const url = "https://x.com/a/status/1";

  it("x_post: uses content when present", () => {
    const e: Enriched = { kind: "x_post", title: "t", content: "the actual post text", author: "a", meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe("the actual post text");
  });

  it("x_post: falls back to the url when content is missing", () => {
    const e: Enriched = { kind: "x_post", title: null, content: null, author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe(url);
  });

  it("youtube: joins title and author with an em dash", () => {
    const e: Enriched = { kind: "youtube", title: "How to build a scout", content: null, author: "Jev Channel", meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe("How to build a scout — Jev Channel");
  });

  it("youtube: uses title alone when author is missing", () => {
    const e: Enriched = { kind: "youtube", title: "How to build a scout", content: null, author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe("How to build a scout");
  });

  it("youtube: falls back to the url when both title and author are missing", () => {
    const e: Enriched = { kind: "youtube", title: null, content: null, author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe(url);
  });

  it("article: joins title and content with an em dash", () => {
    const e: Enriched = { kind: "article", title: "Remote work is dead", content: "long live async", author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe("Remote work is dead — long live async");
  });

  it("article: uses content alone when title is missing", () => {
    const e: Enriched = { kind: "article", title: null, content: "long live async", author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe("long live async");
  });

  it("article: falls back to the url when both title and content are missing", () => {
    const e: Enriched = { kind: "article", title: null, content: null, author: null, meta: {} };
    expect(seedTextFromEnriched(e, url)).toBe(url);
  });
});

describe("short acronyms are search terms (2026-09-27: \"harness batch YC\" lost its YC)", () => {
  it("keeps a word typed in capitals, and YC even in lowercase", () => {
    expect(deriveQuery("harness batch YC")).toBe("harness batch yc");
    expect(deriveQuery("harness batch yc")).toBe("harness batch yc");
    expect(deriveQuery("pricing in the EU")).toBe("pricing eu");
  });
});
