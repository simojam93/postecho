import { describe, expect, it } from "vitest";
import type { Profile } from "./postecho.js";
import {
  generatePrompt,
  imagePrompt,
  revisePrompt,
  styleGuidePrompt,
  systemPrompt,
} from "./prompts.js";
import { AI_STYLE_FINGERPRINTS } from "jev-judge";
import { editPrompt, HUMAN_WRITING_RULES, humanizePrompt, JEV_FINGERPRINTS } from "./prompts.js";

function emptyProfile(): Profile {
  return {
    identityName: "",
    identityHandle: "",
    toneExamplesX: "",
    toneExamplesLinkedin: "",
    toneForm: {},
    styleGuide: "",
    topics: [],
    imageSpecs: "",
    references: [],
  };
}

describe("systemPrompt", () => {
  it("is safe on a completely empty profile — no throw, still states the hard rules", () => {
    const prompt = systemPrompt(emptyProfile());
    expect(prompt).toContain("at most 280 characters");
    expect(prompt).toContain("no links in the body");
    expect(prompt).toContain("600");
    expect(prompt).toContain("1200");
    expect(prompt).toContain("first person");
    expect(prompt).toContain("JSON only");
  });

  it("does not mention identity, style guide, or examples when the profile is empty", () => {
    const prompt = systemPrompt(emptyProfile());
    expect(prompt).not.toContain("Style guide:");
    expect(prompt).not.toContain("examples");
  });

  it("states the exact X hard-rule line", () => {
    expect(systemPrompt(emptyProfile())).toContain("X posts: at most 280 characters, no links in the body.");
  });

  it("states the exact LinkedIn hard-rule line", () => {
    expect(systemPrompt(emptyProfile())).toContain(
      "LinkedIn posts: 600-1200 characters, with a strong, scroll-stopping first line.",
    );
  });

  it("states first-person and concrete/no-filler rules", () => {
    const prompt = systemPrompt(emptyProfile());
    expect(prompt).toContain("Always write in first person.");
    expect(prompt).toContain("Be concrete and specific: no filler, no generic platitudes, no corporate voice.");
  });

  it("requires JSON-only output matching the schema", () => {
    expect(systemPrompt(emptyProfile())).toContain(
      "Respond with JSON only, matching the schema exactly — no prose, no markdown code fences, no explanation.",
    );
  });

  it("forbids hashtags by default", () => {
    expect(systemPrompt(emptyProfile())).toContain("Never use hashtags.");
  });

  it("allows hashtags only when toneForm.hashtags is exactly 'yes'", () => {
    const allowed = systemPrompt({ ...emptyProfile(), toneForm: { hashtags: "yes" } });
    expect(allowed).toContain("Hashtags are fine on X when they fit naturally.");
    expect(allowed).not.toContain("Never use hashtags.");

    const stillForbidden = systemPrompt({ ...emptyProfile(), toneForm: { hashtags: "sometimes" } });
    expect(stillForbidden).toContain("Never use hashtags.");
  });

  it("includes identity name and handle when present", () => {
    const prompt = systemPrompt({ ...emptyProfile(), identityName: "Simone", identityHandle: "@simone" });
    expect(prompt).toContain("Simone");
    expect(prompt).toContain("@simone");
  });

  it("includes the style guide verbatim when present", () => {
    const prompt = systemPrompt({ ...emptyProfile(), styleGuide: "Keep it punchy and short." });
    expect(prompt).toContain("Style guide:");
    expect(prompt).toContain("Keep it punchy and short.");
  });

  it("includes at most the first 3 non-empty example blocks per platform", () => {
    const blocks = ["first post", "second post", "third post", "fourth post", "fifth post"];
    const prompt = systemPrompt({ ...emptyProfile(), toneExamplesX: blocks.join("\n\n") });
    expect(prompt).toContain("first post");
    expect(prompt).toContain("second post");
    expect(prompt).toContain("third post");
    expect(prompt).not.toContain("fourth post");
    expect(prompt).not.toContain("fifth post");
  });

  it("ignores blank blocks when picking the first 3 examples", () => {
    const raw = "\n\n  \n\nfirst post\n\n\n\nsecond post\n\n   \n\nthird post";
    const prompt = systemPrompt({ ...emptyProfile(), toneExamplesLinkedin: raw });
    expect(prompt).toContain("first post");
    expect(prompt).toContain("second post");
    expect(prompt).toContain("third post");
  });
});

describe("generatePrompt", () => {
  it("includes the source text and plumbs the count through", () => {
    const prompt = generatePrompt({ sourceKind: "video", sourceText: "transcript text here", instructions: "", count: 5 });
    expect(prompt).toContain("transcript text here");
    expect(prompt).toContain("5");
  });

  it("plumbs the language through only when given", () => {
    const withLang = generatePrompt({ sourceKind: "video", sourceText: "t", instructions: "", count: 1, language: "Italian" });
    expect(withLang).toContain("Italian");

    const withoutLang = generatePrompt({ sourceKind: "idea", sourceText: "t", instructions: "", count: 1 });
    expect(withoutLang.toLowerCase()).not.toContain("write in this language");
  });

  it("asks for the source's own language when keepSourceLanguage is set, overriding a named language", () => {
    const prompt = generatePrompt({
      sourceKind: "video", sourceText: "t", instructions: "", count: 1, language: "English", keepSourceLanguage: true,
    });
    expect(prompt.toLowerCase()).toContain("same language as the source");
    expect(prompt.toLowerCase()).not.toContain("write in this language");
  });

  it("includes owner instructions when given, and omits the line when blank", () => {
    const withInstructions = generatePrompt({
      sourceKind: "idea", sourceText: "t", instructions: "make it punchy", count: 1,
    });
    expect(withInstructions).toContain("make it punchy");

    const withoutInstructions = generatePrompt({ sourceKind: "idea", sourceText: "t", instructions: "", count: 1 });
    expect(withoutInstructions.toLowerCase()).not.toContain("instructions from the owner");
  });

  it("tells Claude an idea source is someone else's work, never the owner's", () => {
    const idea = generatePrompt({ sourceKind: "idea", sourceText: "Show HN: I built X", instructions: "", count: 3 });
    expect(idea).toContain("written by someone else");
    expect(idea).toContain("Never present the source's product");
    const video = generatePrompt({ sourceKind: "video", sourceText: "transcript", instructions: "", count: 3 });
    expect(video).not.toContain("written by someone else");
  });

  it("distinguishes a video source from an idea source", () => {
    const video = generatePrompt({ sourceKind: "video", sourceText: "t", instructions: "", count: 1 });
    const idea = generatePrompt({ sourceKind: "idea", sourceText: "t", instructions: "", count: 1 });
    expect(video).not.toBe(idea);
  });
});

describe("revisePrompt", () => {
  it("includes the instruction and only the platform field(s) provided", () => {
    const xOnly = revisePrompt({ xText: "old x text", instruction: "make it punchier" });
    expect(xOnly).toContain("old x text");
    expect(xOnly).toContain("make it punchier");
    expect(xOnly).not.toContain("LinkedIn:");

    const linkedinOnly = revisePrompt({ linkedinText: "old linkedin text", instruction: "shorten it" });
    expect(linkedinOnly).toContain("old linkedin text");
    expect(linkedinOnly).not.toContain("X:");
  });
});

describe("imagePrompt", () => {
  it("includes the post text and image specs when given", () => {
    const withSpecs = imagePrompt({ text: "the post text", imageSpecs: "16:9, minimalist" });
    expect(withSpecs).toContain("the post text");
    expect(withSpecs).toContain("16:9, minimalist");
  });

  it("omits the specs line when there are none", () => {
    const withoutSpecs = imagePrompt({ text: "the post text", imageSpecs: "" });
    expect(withoutSpecs).toContain("the post text");
    expect(withoutSpecs.toLowerCase()).not.toContain("image style/specs");
  });
});

describe("styleGuidePrompt", () => {
  it("includes both example sets and the tone form", () => {
    const prompt = styleGuidePrompt({
      examplesX: "x example",
      examplesLinkedin: "linkedin example",
      toneForm: { hashtags: "no", emoji: "rare" },
    });
    expect(prompt).toContain("x example");
    expect(prompt).toContain("linkedin example");
    expect(prompt).toContain("hashtags");
  });
});

describe("humanizePrompt", () => {
  it("round 1: the original, Jev's rubric in jev-judge's own words, the rules", () => {
    const p = humanizePrompt({ original: "Here's the thing.", maxChars: 280 });
    expect(p.startsWith("Original text:\n<<<\nHere's the thing.\n>>>")).toBe(true);
    expect(JEV_FINGERPRINTS).toBe(AI_STYLE_FINGERPRINTS);
    expect(p).toContain(`Jev looks for: ${JEV_FINGERPRINTS}.`);
    expect(p).toContain("No em-dashes");
    expect(p).toContain("Break the parallelism");
    expect(p).toContain("Keep: the language it is written in");
    expect(p).toContain("Drop: the original's structure, rhythm and slogans.");
    expect(p).toContain("It must stay within 280 characters.");
    expect(p).toContain('Return a JSON object: { "rewrite": "..." }.');
    expect(p).not.toContain("previous rewrite");
  });

  it("round 2+: the previous rewrite and Jev's score on it; a platform label names the post", () => {
    const p = humanizePrompt({ original: "orig", previous: { text: "try 1", slopScore: 52, verdict: "borderline" }, maxChars: 900, platformLabel: "LinkedIn" });
    expect(p).toContain("Original LinkedIn post:");
    expect(p).toContain("Your previous rewrite:\n<<<\ntry 1\n>>>");
    expect(p).toContain("still rates that rewrite 52/100 for LLM style (borderline)");
    expect(p).toContain("Rewrite the original LinkedIn post again and go much further than last time");
    expect(p).toContain("At most 900 characters.");
  });
});

describe("generatePrompt — the owner's own text (Write's + New)", () => {
  it("labels the source as the owner's notes and writes it as theirs, not as a reaction", () => {
    const p = generatePrompt({ sourceKind: "idea", sourceText: "I rebuilt our onboarding in a weekend", count: 3, ownText: true });
    expect(p.startsWith("Source (the owner's own notes):")).toBe(true);
    expect(p).toContain("The source is the owner's own text");
    expect(p).toContain("theirs to state in the first person");
    expect(p).not.toContain("The source was written by someone else");
  });

  it("an idea without ownText keeps the someone-else rule", () => {
    const p = generatePrompt({ sourceKind: "idea", sourceText: "Show HN: TeardownHQ", count: 3 });
    expect(p).toContain("The source was written by someone else");
    expect(p).not.toContain("The source is the owner's own text");
  });
});

describe("editPrompt (Edit with Claude)", () => {
  it("clamps a very long source and omits the history block when empty", () => {
    const p = editPrompt({ mode: "custom", xText: "x", sourceText: "s".repeat(9000), voice: "reaction", history: [], instruction: "shorter" });
    expect(p).toContain(`${"s".repeat(8000)} …`);
    expect(p).not.toContain("Earlier requests");
    expect(p).toContain("Request: shorter");
  });

  it("without a source there is no source block", () => {
    expect(editPrompt({ mode: "voice", xText: "x", voice: "mine", instruction: "" })).not.toContain("Source the post was written from");
  });
});

describe("human writing rules in every generation and edit", () => {
  it("generatePrompt and every editPrompt mode carry them", () => {
    expect(generatePrompt({ sourceKind: "idea", sourceText: "s", count: 3 })).toContain(HUMAN_WRITING_RULES);
    for (const mode of ["custom", "sync_linkedin", "sync_x", "voice"] as const) {
      expect(editPrompt({ mode, xText: "x", linkedinText: "l", voice: "mine", instruction: "i" })).toContain(HUMAN_WRITING_RULES);
    }
  });
});

describe("the owner's library in the prompts (2026-09-24)", () => {
  const base = { identityName: "", identityHandle: "", toneExamplesX: "", toneExamplesLinkedin: "", toneForm: {}, styleGuide: "", topics: [], imageSpecs: "" };

  it("systemPrompt carries the enabled references with the privacy rule; none, no block", () => {
    const withRefs = systemPrompt({ ...base, references: [{ name: "Bio", text: "Product designer, building PostEcho." }] });
    expect(withRefs).toContain("Reference material about the owner and their work");
    expect(withRefs).toContain("Keep private details");
    expect(withRefs).toContain("--- Bio\nProduct designer, building PostEcho.");
    expect(systemPrompt({ ...base, references: [] })).not.toContain("Reference material");
  });

  it("styleGuidePrompt borrows structure from inspiration posts, never the voice; without own posts it says so", () => {
    const p = styleGuidePrompt({ examplesX: "", examplesLinkedin: "", toneForm: {}, inspiration: ["A post I like.", "Another."] });
    expect(p).toContain("Borrow their structural moves");
    expect(p).toContain("Never copy their wording");
    expect(p).toContain("--- inspiration 2\nAnother.");
    expect(p).toContain("There are no examples of the owner's own posts yet");
    const own = styleGuidePrompt({ examplesX: "mine", examplesLinkedin: "", toneForm: {}, inspiration: ["theirs"] });
    expect(own).not.toContain("There are no examples");
    expect(styleGuidePrompt({ examplesX: "mine", examplesLinkedin: "", toneForm: {} })).not.toContain("inspiration");
  });
});

describe("@tags on X (2026-09-24)", () => {
  it("generation tags who the X text names, only when sure, never first; LinkedIn keeps names", async () => {
    const { generatePrompt, X_TAGS_RULE, LINKEDIN_NAMES_RULE } = await import("./prompts.js");
    const xOnly = generatePrompt({ sourceKind: "idea", sourceText: "s", count: 3 });
    expect(xOnly).toContain(X_TAGS_RULE);
    expect(X_TAGS_RULE).toMatch(/only when you are sure/);
    expect(X_TAGS_RULE).toMatch(/never start the post with an @handle/);
    expect(xOnly).not.toContain(LINKEDIN_NAMES_RULE);
    expect(generatePrompt({ sourceKind: "idea", sourceText: "s", count: 3, withLinkedin: true })).toContain(LINKEDIN_NAMES_RULE);
  });

  it("edits keep the handles; LinkedIn from X turns them into names; X from LinkedIn tags", async () => {
    const { editPrompt, humanizePrompt, KEEP_TAGS_RULE, LINKEDIN_NAMES_RULE, X_TAGS_RULE } = await import("./prompts.js");
    const base = { xText: "Loved @karpathy's take", linkedinText: "li", voice: "reaction" as const, instruction: "shorter" };
    expect(editPrompt({ ...base, mode: "custom" })).toContain(KEEP_TAGS_RULE);
    expect(editPrompt({ ...base, mode: "voice" })).toContain(KEEP_TAGS_RULE);
    expect(editPrompt({ ...base, mode: "sync_linkedin" })).toContain(LINKEDIN_NAMES_RULE);
    expect(editPrompt({ ...base, mode: "sync_x" })).toContain(X_TAGS_RULE);
    expect(humanizePrompt({ original: "Loved @karpathy's take", maxChars: 280, platformLabel: "X" })).toContain('every @handle and every "(to tag on LinkedIn)" note exactly as written');
  });
});

describe("LinkedIn tags as a note in the text (2026-09-25)", () => {
  it("LinkedIn writes names, each worth tagging followed by the note; edits keep the notes", async () => {
    const { editPrompt, LINKEDIN_NAMES_RULE, KEEP_TAGS_RULE, LINKEDIN_TAG_NOTE } = await import("./prompts.js");
    expect(LINKEDIN_TAG_NOTE).toBe("(to tag on LinkedIn)");
    expect(LINKEDIN_NAMES_RULE).toContain('add "(to tag on LinkedIn)"');
    expect(KEEP_TAGS_RULE).toContain('"(to tag on LinkedIn)" note');
    const base = { xText: "Loved @karpathy's take", linkedinText: "li", voice: "reaction" as const, instruction: "" };
    expect(editPrompt({ ...base, mode: "sync_linkedin" })).toContain("The X post's @handles become the names they stand for, each with that note.");
  });
});

describe("repoPostsPrompt (posts from a repo, 2026-10-10)", () => {
  it("names the repo, carries the brief, and says to explore it with the read tools from the README and docs", async () => {
    const { repoPostsPrompt } = await import("./prompts.js");
    const p = repoPostsPrompt({ repoName: "postecho", brief: "the launch of tier gating", format: "x", count: 3 });
    expect(p).toContain("postecho");
    expect(p).toContain("the launch of tier gating");
    expect(p).toMatch(/Read, Glob and Grep/);
    expect(p).toMatch(/README/);
    expect(p).toMatch(/docs/);
    expect(p).toMatch(/exactly 3 /);
  });

  it("lists what's already written from the repo and asks for new angles (owner, 2026-10-10)", async () => {
    const { repoPostsPrompt } = await import("./prompts.js");
    const p = repoPostsPrompt({ repoName: "postecho", brief: "", format: "x", count: 2, previous: ["We split the judge out.", "Tier gating shipped."] });
    expect(p).toMatch(/Already written from this repository/);
    expect(p).toContain("- We split the judge out.");
    expect(p).toContain("- Tier gating shipped.");
    expect(p).toMatch(/don't repeat/i);
    expect(repoPostsPrompt({ repoName: "postecho", brief: "", format: "x", count: 2 })).not.toMatch(/Already written/);
  });

  it("with no brief, asks for the most interesting recent work", async () => {
    const { repoPostsPrompt } = await import("./prompts.js");
    const p = repoPostsPrompt({ repoName: "a/b", brief: "  ", format: "x", count: 2 });
    expect(p).toMatch(/most interesting recent work/);
    expect(p).not.toMatch(/The posts are about/);
  });

  it("states each format's limits", async () => {
    const { repoPostsPrompt } = await import("./prompts.js");
    const base = { repoName: "a/b", brief: "", count: 1 };
    expect(repoPostsPrompt({ ...base, format: "x" })).toMatch(/at most 280 characters/);
    expect(repoPostsPrompt({ ...base, format: "linkedin" })).toMatch(/600-1,200 characters/);
    const article = repoPostsPrompt({ ...base, format: "article" });
    expect(article).toMatch(/title of up to 100 characters/);
    expect(article).toMatch(/600-1,500 words/);
    expect(article).toMatch(/short section headings as plain lines/);
  });
});
