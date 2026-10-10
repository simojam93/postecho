import { describe, expect, it, vi } from "vitest";
import type { Job, Profile } from "./postecho.js";
import {
  DRAFTS_SCHEMA,
  IMAGE_PROMPT_SCHEMA,
  REPO_ARTICLE_SCHEMA,
  REPO_LINKEDIN_SCHEMA,
  REPO_X_SCHEMA,
  REVISE_SCHEMA,
  STYLE_GUIDE_SCHEMA,
  X_DRAFTS_SCHEMA,
} from "./schemas.js";
import { TranscriptUnavailable } from "./transcript.js";
import {
  HANDLERS,
  handleAnalyzeStyle,
  handleGenerateFromIdea,
  handleGenerateFromVideo,
  handleImagePrompt,
  handleLearnStyle,
  handlePickFolder,
  handleRepoPosts,
  handleReviseDraft,
  handleVideoIdeas,
  HUMANIZE_MAX_ROUNDS,
  humanizeLoop,
  runHandler,
  SERVED_KINDS,
  stripHashtagLines,
  type HandlerDeps,
} from "./handlers.js";

const LI_OK = "l".repeat(700);

function emptyProfile(overrides: Partial<Profile> = {}): Profile {
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
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    kind: "generate_from_video",
    payload: {},
    createdAt: "2026-09-22T00:00:00.000Z",
    claimedAt: "2026-09-22T00:00:01.000Z",
    ...overrides,
  };
}

/**
 * A runClaudeJson fake that just runs `fixture` through the real `parse`,
 * capturing every call's opts for assertions — no actual CLI involved.
 * Deliberately a plain generic function (not vi.fn(...)) — vi.fn infers one
 * concrete signature from its callback, which can't satisfy RunClaudeJsonFn's
 * genuinely generic `<T>` call signature (the same reason handlers.ts itself
 * can't be typed with a non-generic dependency here).
 */
function fakeRunClaudeJson(fixture: unknown) {
  const calls: Array<{ prompt: string; system: string; schema: object; cwd?: string; readOnlyTools?: boolean; long?: boolean }> = [];
  async function fn<T>(opts: {
    prompt: string;
    system: string;
    schema: object;
    parse: (value: unknown) => T;
    cwd?: string;
    readOnlyTools?: boolean;
    long?: boolean;
  }): Promise<T> {
    calls.push({
      prompt: opts.prompt,
      system: opts.system,
      schema: opts.schema,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.readOnlyTools !== undefined ? { readOnlyTools: opts.readOnlyTools } : {}),
      ...(opts.long !== undefined ? { long: opts.long } : {}),
    });
    return opts.parse(fixture);
  }
  return { fn, calls };
}

describe("HANDLERS / SERVED_KINDS", () => {
  it("serves exactly the nine agent kinds", () => {
    expect(SERVED_KINDS.sort()).toEqual(
      [
        "analyze_style", "generate_from_idea", "generate_from_video", "image_prompt", "learn_style", "pick_folder",
        "repo_posts", "revise_draft", "video_ideas",
      ].sort(),
    );
    for (const kind of SERVED_KINDS) expect(typeof HANDLERS[kind]).toBe("function");
  });
});

describe("handleVideoIdeas (2026-09-27: \"post X pronti all'attacco senza titolo, 6+6\"; \"come se fossero idee mie\")", () => {
  const post = (i: number) => ({ xText: `Post ${i}: what the video says about point ${i}.` });

  it("reads the whole transcript and writes a dozen ready X posts, each on a different point, best first; says each phase; hands back what it read", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: Array.from({ length: 12 }, (_, i) => post(i)) });
    const fetchTranscript = vi.fn(async () => ({ text: "the whole interview", truncated: false, lang: "en" }));
    const progress: Array<Record<string, unknown>> = [];
    const result = await handleVideoIdeas(
      { url: "https://youtu.be/v", title: "Intervista a Alberto Dalmasso", count: 12 },
      { getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript, reportProgress: async (p) => { progress.push(p); } },
    );
    expect(fetchTranscript).toHaveBeenCalledWith("https://youtu.be/v", {});
    expect(result.posts).toEqual(Array.from({ length: 12 }, (_, i) => post(i)));
    expect(result.source).toBe("transcript");
    expect(result.text).toBe("the whole interview");
    expect(progress).toEqual([{ kind: "video_ideas", phase: "reading" }, { kind: "video_ideas", phase: "writing", source: "transcript", lang: "en" }]);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("the whole interview");
    expect(prompt).toContain("write the 12 best X posts the owner could publish, each built on a different idea from it");
    expect(prompt).toContain("never two about the same one");
    expect(prompt).toContain("ready to publish as it is: at most 280 characters");
    expect(prompt).toContain("worth reposting");
    expect(prompt).toContain("best first");
    // The owner's own ideas: no pointer to the video, nothing copied, no borrowed experience.
    expect(prompt).toContain("Write each post as the owner's own idea");
    expect(prompt).toContain("Never mention or point to the video, the talk, its speaker or the interview");
    expect(prompt).toContain("never sentences copied from the source");
    expect(prompt).toContain("Don't give the owner experiences they didn't have");
    expect(prompt).not.toContain("reaction");
    expect(prompt).toContain("Tags on X:");
    expect(prompt).toContain("Never invent numbers, names or claims the source doesn't support.");
    expect(prompt).toContain("Write like one specific person");
    expect(prompt).toContain("“Intervista a Alberto Dalmasso”");
    expect(prompt).toContain("Write the posts in English.");
    expect(prompt).not.toContain("title");
    expect(calls[0]!.schema).toBe(X_DRAFTS_SCHEMA);
  });

  it("with Jev, writes two more and keeps the most human, in the order Claude wrote them, each with its score", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [post(0), post(1), post(2), post(3)] });
    const progress: Array<Record<string, unknown>> = [];
    const result = await handleVideoIdeas(
      { url: "https://youtu.be/v", transcript: "pasted words", count: 2 },
      {
        getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript: vi.fn(),
        checkSlop: jevScores([70, 20, 90, 10]), reportProgress: async (p) => { progress.push(p); },
      },
    );
    expect(calls[0]!.prompt).toContain("write the 4 best X posts");
    expect(result.posts).toEqual([
      { ...post(1), slop: { platform: "x", slopScore: 20, verdict: "human" } },
      { ...post(3), slop: { platform: "x", slopScore: 10, verdict: "human" } },
    ]);
    expect(progress.at(-1)).toEqual({ kind: "video_ideas", phase: "checking", source: "transcript", pasted: true });
  });

  it("uses a transcript pasted by hand, and keeps at most the posts asked for", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [post(0), post(1), post(2)] });
    const fetchTranscript = vi.fn();
    const result = await handleVideoIdeas(
      { url: "https://youtu.be/v", transcript: "pasted words", count: 2 },
      { getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript },
    );
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(result.posts).toEqual([post(0), post(1)]);
  });

  it("without a transcript in any language, reads the description and chapters instead, and says so (2026-09-27)", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [post(0)] });
    const fetchTranscript = vi.fn(async () => { throw new TranscriptUnavailable(); });
    const description = "In this interview Alberto Dalmasso tells how Satispay grew to millions of users. ".repeat(4);
    const result = await handleVideoIdeas({ url: "https://youtu.be/v", description }, { getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript });
    expect(result.source).toBe("description");
    expect(result.text).toBe(description.trim());
    expect(calls[0]!.prompt).toContain("description and chapters (the video has no transcript)");
    expect(calls[0]!.prompt).toContain(description.trim());
  });

  it("says the transcript is unavailable in the owner's words, so the Videos tab offers to paste it", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [post(0)] });
    const fetchTranscript = vi.fn(async () => { throw new TranscriptUnavailable(); });
    await expect(handleVideoIdeas({ url: "https://youtu.be/v" }, { getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript }))
      .rejects.toThrow("transcript unavailable");
  });
});

describe("handleGenerateFromVideo", () => {
  it("Use on a Videos topic: writes about that topic from the whole transcript it's handed", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "hi" }] });
    const fetchTranscript = vi.fn();
    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "the whole interview", topic: { title: "Repetition beats novelty", summary: "Cole reused one sentence for ten years." } },
      { getProfile: async () => emptyProfile(), runClaudeJson, fetchTranscript },
    );
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(calls[0]!.prompt).toContain("the whole interview");
    expect(calls[0]!.prompt).toContain("The posts are about one topic from it: “Repetition beats novelty”. Cole reused one sentence for ten years.");
    expect(calls[0]!.prompt).toContain("the rest is context");
  });

  it("uses payload.transcript verbatim and never calls fetchTranscript when it's present", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const fetchTranscript = vi.fn();
    const getProfile = vi.fn(async () => emptyProfile());

    const result = await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "a pasted transcript" },
      { getProfile, runClaudeJson, fetchTranscript },
    );

    // X only by default (2026-09-24): a LinkedIn text the model adds anyway is dropped.
    expect(result).toEqual({ drafts: [{ xText: "hi" }] });
    expect(fetchTranscript).not.toHaveBeenCalled();
  });

  it("fetches the transcript when payload.transcript is absent, and uses the DRAFTS_SCHEMA", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const fetchTranscript = vi.fn(async () => ({ text: "a fetched transcript", truncated: false }));
    const getProfile = vi.fn(async () => emptyProfile());

    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", count: 5, instructions: "be punchy", originalLanguage: "Italian" },
      { getProfile, runClaudeJson, fetchTranscript },
    );

    expect(fetchTranscript).toHaveBeenCalledWith("https://youtu.be/abc", {});
    expect(calls[0]?.schema).toBe(X_DRAFTS_SCHEMA);
    expect(calls[0]?.prompt).toContain("a fetched transcript");
    expect(calls[0]?.prompt).toContain("5");
    expect(calls[0]?.prompt).toContain("be punchy");
    expect(calls[0]?.prompt).toContain("Italian");
  });

  it("maps web's boolean originalLanguage toggle: false -> English, true -> the video's own language", async () => {
    const english = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "t", originalLanguage: false },
      { getProfile: async () => emptyProfile(), runClaudeJson: english.fn },
    );
    expect(english.calls[0]?.prompt).toContain("Write in this language: English.");

    const original = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "t", originalLanguage: true },
      { getProfile: async () => emptyProfile(), runClaudeJson: original.fn },
    );
    expect(original.calls[0]?.prompt.toLowerCase()).toContain("same language as the source");
    expect(original.calls[0]?.prompt).not.toContain("Write in this language");
  });

  it("defaults to English when originalLanguage is absent or null", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "t", originalLanguage: null },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(calls[0]?.prompt).toContain("Write in this language: English.");
  });

  it("propagates TranscriptUnavailable's exact message when the transcript can't be fetched", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const fetchTranscript = vi.fn(async () => {
      throw new TranscriptUnavailable();
    });
    const getProfile = vi.fn(async () => emptyProfile());

    await expect(
      handleGenerateFromVideo({ url: "https://youtu.be/abc" }, { getProfile, runClaudeJson, fetchTranscript }),
    ).rejects.toThrow("transcript unavailable — paste it in the app");
  });

  it("loads a fresh profile for this job", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const getProfile = vi.fn(async () => emptyProfile());
    await handleGenerateFromVideo(
      { url: "https://youtu.be/abc", transcript: "t" },
      { getProfile, runClaudeJson },
    );
    expect(getProfile).toHaveBeenCalledTimes(1);
  });
});

describe("handleGenerateFromIdea", () => {
  it("builds the source text from seedText and seedUrl", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await handleGenerateFromIdea(
      { seedText: "an interesting idea", seedUrl: "https://example.com/post", count: 2 },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(calls[0]?.schema).toBe(X_DRAFTS_SCHEMA);
    expect(calls[0]?.prompt).toContain("an interesting idea");
    expect(calls[0]?.prompt).toContain("https://example.com/post");
  });

  it("accepts a null seedUrl (web sends ideas.url verbatim, which is nullable)", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await handleGenerateFromIdea(
      { ideaId: "i1", seedText: "a pasted note", seedUrl: null, instructions: "", count: 3 },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(calls[0]?.prompt).toContain("a pasted note");
    expect(calls[0]?.prompt).not.toContain("null");
  });

  it("throws a clear error when there is no seedText or seedUrl", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    await expect(
      handleGenerateFromIdea({}, { getProfile: async () => emptyProfile(), runClaudeJson }),
    ).rejects.toThrow(/seedText|seedUrl/);
  });
});

describe("handleReviseDraft", () => {
  it("passes xText/linkedinText/instruction through and validates with REVISE_SCHEMA", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ xText: "revised" });
    const result = await handleReviseDraft(
      { draftId: "d1", xText: "old text", instruction: "make it punchier" },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(result).toEqual({ xText: "revised" });
    expect(calls[0]?.schema).toBe(REVISE_SCHEMA);
    expect(calls[0]?.prompt).toContain("old text");
    expect(calls[0]?.prompt).toContain("make it punchier");
  });
});

describe("handleReviseDraft — a post from a repo (2026-10-10)", () => {
  it("writes the LinkedIn version reading the whole repository, not only the X post", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ linkedinText: "l".repeat(700) });
    const resolveRepo = vi.fn(async () => ({ dir: "/repos/a__b", name: "a/b" }));
    await handleReviseDraft(
      { draftId: "d1", xText: "the X post", instruction: "Write the LinkedIn version", mode: "sync_linkedin", repo: { type: "github", url: "https://github.com/a/b" } },
      { getProfile: async () => emptyProfile(), runClaudeJson, resolveRepo },
    );
    expect(resolveRepo).toHaveBeenCalledWith({ type: "github", url: "https://github.com/a/b" });
    expect(calls[0]!.cwd).toBe("/repos/a__b");
    expect(calls[0]!.readOnlyTools).toBe(true);
    expect(calls[0]!.long).toBe(true);
    expect(calls[0]!.prompt).toMatch(/repository/i);
  });

  it("a plain edit of a repo post doesn't read the repository", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ xText: "shorter" });
    const resolveRepo = vi.fn();
    await handleReviseDraft(
      { draftId: "d1", xText: "the X post", instruction: "shorter", mode: "custom", repo: { type: "folder", path: "/x" } },
      { getProfile: async () => emptyProfile(), runClaudeJson, resolveRepo },
    );
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(calls[0]!.cwd).toBeUndefined();
  });
});

describe("handleReviseDraft — web payload shape", () => {
  it("accepts a null linkedinText for an X-only draft (web spreads the nullable draft columns as-is)", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ xText: "revised" });
    await handleReviseDraft(
      { draftId: "d1", xText: "old text", linkedinText: null, instruction: "shorter" },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(calls[0]?.prompt).toContain("X: old text");
    expect(calls[0]?.prompt).not.toContain("LinkedIn:");
  });

  it("rejects a draft whose xText and linkedinText are both null", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ xText: "revised" });
    await expect(
      handleReviseDraft(
        { draftId: "d1", xText: null, linkedinText: null, instruction: "shorter" },
        { getProfile: async () => emptyProfile(), runClaudeJson },
      ),
    ).rejects.toThrow();
  });
});

describe("handleImagePrompt", () => {
  it("accepts the exact payload web's image-prompt route sends (null platform field, blank imageSpecs)", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ imagePrompt: "a prompt" });
    await handleImagePrompt(
      { draftId: "d1", xText: "post text", linkedinText: null, imageSpecs: "" },
      { getProfile: async () => emptyProfile({ imageSpecs: "profile specs" }), runClaudeJson },
    );
    expect(calls[0]?.prompt).toContain("post text");
    expect(calls[0]?.prompt).toContain("profile specs");
    expect(calls[0]?.prompt).not.toContain("null");
  });

  it("prefers payload.imageSpecs over the profile's when both are present", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ imagePrompt: "a prompt" });
    await handleImagePrompt(
      { draftId: "d1", xText: "post text", imageSpecs: "payload specs" },
      { getProfile: async () => emptyProfile({ imageSpecs: "profile specs" }), runClaudeJson },
    );
    expect(calls[0]?.schema).toBe(IMAGE_PROMPT_SCHEMA);
    expect(calls[0]?.prompt).toContain("payload specs");
    expect(calls[0]?.prompt).not.toContain("profile specs");
  });

  it("falls back to the profile's imageSpecs when the payload has none", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ imagePrompt: "a prompt" });
    await handleImagePrompt(
      { draftId: "d1", linkedinText: "post text" },
      { getProfile: async () => emptyProfile({ imageSpecs: "profile specs" }), runClaudeJson },
    );
    expect(calls[0]?.prompt).toContain("profile specs");
  });

  it("rejects a payload with neither xText nor linkedinText", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ imagePrompt: "a prompt" });
    await expect(
      handleImagePrompt({ draftId: "d1" }, { getProfile: async () => emptyProfile(), runClaudeJson }),
    ).rejects.toThrow();
  });
});

describe("handleAnalyzeStyle", () => {
  it("passes examples and toneForm through and validates with STYLE_GUIDE_SCHEMA", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ styleGuide: "# Voice" });
    const result = await handleAnalyzeStyle(
      { toneExamplesX: "x examples", toneExamplesLinkedin: "li examples", toneForm: { hashtags: "no" } },
      { getProfile: async () => emptyProfile(), runClaudeJson },
    );
    expect(result).toEqual({ styleGuide: "# Voice" });
    expect(calls[0]?.schema).toBe(STYLE_GUIDE_SCHEMA);
    expect(calls[0]?.prompt).toContain("x examples");
    expect(calls[0]?.prompt).toContain("li examples");
  });
});

describe("runHandler", () => {
  it("wraps a successful handler into { ok: true, result }", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const outcome = await runHandler(makeJob({ payload: { url: "https://youtu.be/abc", transcript: "t" } }), {
      getProfile: async () => emptyProfile(),
      runClaudeJson,
    });
    expect(outcome).toEqual({ ok: true, result: { drafts: [{ xText: "hi" }] } });
  });

  it("wraps a thrown error into { ok: false, error: message }, verbatim for TranscriptUnavailable", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const fetchTranscript = vi.fn(async () => {
      throw new TranscriptUnavailable();
    });
    const outcome = await runHandler(makeJob({ payload: { url: "https://youtu.be/abc" } }), {
      getProfile: async () => emptyProfile(),
      runClaudeJson,
      fetchTranscript,
    });
    expect(outcome).toEqual({ ok: false, error: "transcript unavailable — paste it in the app" });
  });

  it("never rejects — even a validation error becomes { ok: false }", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson({ drafts: [{ xText: "hi", linkedinText: LI_OK }] });
    const outcome = await runHandler(makeJob({ payload: {} /* missing required url */ }), {
      getProfile: async () => emptyProfile(),
      runClaudeJson,
    });
    expect(outcome.ok).toBe(false);
  });

  it("reports an unknown kind as a clear ok:false, without touching any dependency", async () => {
    const getProfile = vi.fn();
    const runClaudeJson = vi.fn();
    const outcome = await runHandler(makeJob({ kind: "scout" }), { getProfile, runClaudeJson } as unknown as HandlerDeps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("scout");
    expect(getProfile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Humanize — the Claude <-> Jev loop (M3.6)
// ---------------------------------------------------------------------------

/** A runClaudeJson fake that answers each call with the next fixture, through the real `parse`. */
function sequencedClaude(fixtures: Array<unknown | Error>) {
  const calls: Array<{ prompt: string; system: string; schema: object }> = [];
  let i = 0;
  async function fn<T>(opts: { prompt: string; system: string; schema: object; parse: (value: unknown) => T }): Promise<T> {
    calls.push({ prompt: opts.prompt, system: opts.system, schema: opts.schema });
    const next = fixtures[Math.min(i, fixtures.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return opts.parse(next);
  }
  return { fn, calls };
}

function jevScores(scores: Array<number | Error>) {
  let i = 0;
  const checkSlop = vi.fn(async (_text: string, _platform?: "x" | "linkedin") => {
    const next = scores[Math.min(i, scores.length - 1)]!;
    i++;
    if (next instanceof Error) throw next;
    return { slopScore: next, verdict: next < 35 ? "human" : next < 60 ? "borderline" : "slop" };
  });
  return checkSlop;
}

function loopDeps(claude: ReturnType<typeof sequencedClaude>, checkSlop?: HandlerDeps["checkSlop"]) {
  const progress: Array<Record<string, unknown>> = [];
  const deps: HandlerDeps = {
    getProfile: async () => emptyProfile({ identityName: "Simone" }),
    runClaudeJson: claude.fn,
    checkSlop,
    reportProgress: async (p) => { progress.push(p); },
  };
  return { deps, progress };
}

const SLOPPY = "Here's the thing: shipping is not about speed, but about trust. Focus. Iterate. Listen. In the end, consistency wins.";

describe("humanizeLoop", () => {
  it("stops as soon as Jev calls a rewrite human, and returns it with every round's score", async () => {
    const claude = sequencedClaude([{ rewrite: "try one" }, { rewrite: "try two" }, { rewrite: "try three" }]);
    const { deps, progress } = loopDeps(claude, jevScores([58, 22]));
    const out = await humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps);

    expect(out.text).toBe("try two");
    expect(out.slop).toEqual({ slopScore: 22, verdict: "human" });
    expect(out.rounds).toEqual([
      { round: 1, slopScore: 58, verdict: "borderline" },
      { round: 2, slopScore: 22, verdict: "human" },
    ]);
    expect(claude.calls).toHaveLength(2);
    // Round 2 carries round 1's rewrite and Jev's score on it.
    expect(claude.calls[1]!.prompt).toContain("Your previous rewrite:\n<<<\ntry one\n>>>");
    expect(claude.calls[1]!.prompt).toContain("still rates that rewrite 58/100 for LLM style (borderline)");
    expect(claude.calls[0]!.prompt).not.toContain("previous rewrite");
    expect(claude.calls[0]!.system).toBe("SYS");
    // Progress: rewriting then checking, per round, with the rounds so far.
    expect(progress.map((p) => `${p.round}:${p.phase}`)).toEqual(["1:rewriting", "1:checking", "2:rewriting", "2:checking"]);
    expect(progress[2]!).toMatchObject({ kind: "humanize", maxRounds: HUMANIZE_MAX_ROUNDS, rounds: [{ round: 1, slopScore: 58 }] });
  });

  it("gives up after HUMANIZE_MAX_ROUNDS and returns the best-scored rewrite, not the last", async () => {
    const claude = sequencedClaude([{ rewrite: "a" }, { rewrite: "b" }, { rewrite: "c" }, { rewrite: "d" }]);
    const { deps } = loopDeps(claude, jevScores([70, 41, 55]));
    const out = await humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps);
    expect(claude.calls).toHaveLength(HUMANIZE_MAX_ROUNDS);
    expect(out.text).toBe("b");
    expect(out.slop).toEqual({ slopScore: 41, verdict: "borderline" });
    expect(out.rounds.map((r) => r.slopScore)).toEqual([70, 41, 55]);
  });

  it("without a Jev check it rewrites once and returns no score", async () => {
    const claude = sequencedClaude([{ rewrite: "only" }]);
    const { deps } = loopDeps(claude, undefined);
    const out = await humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps);
    expect(out).toEqual({ text: "only", rounds: [{ round: 1, slopScore: null, verdict: null }], slop: null });
  });

  it("a failing Jev check stops the loop after that round", async () => {
    const claude = sequencedClaude([{ rewrite: "first" }, { rewrite: "second" }]);
    const { deps } = loopDeps(claude, jevScores([new Error("503")]));
    const out = await humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps);
    expect(claude.calls).toHaveLength(1);
    expect(out.text).toBe("first");
    expect(out.slop).toBeNull();
  });

  it("a rewrite failing after round 1 keeps the best one so far; failing in round 1 fails", async () => {
    const later = sequencedClaude([{ rewrite: "ok one" }, new Error("claude timed out")]);
    const { deps } = loopDeps(later, jevScores([66]));
    const out = await humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps);
    expect(out.text).toBe("ok one");
    expect(out.rounds).toHaveLength(1);

    const first = sequencedClaude([new Error("claude timed out")]);
    await expect(humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, loopDeps(first, jevScores([10])).deps)).rejects.toThrow("claude timed out");
  });

  it("a failing progress report never fails the rewrite", async () => {
    const claude = sequencedClaude([{ rewrite: "fine" }]);
    const deps: HandlerDeps = {
      getProfile: async () => emptyProfile(),
      runClaudeJson: claude.fn,
      checkSlop: jevScores([12]),
      reportProgress: async () => { throw new Error("404"); },
    };
    await expect(humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps)).resolves.toMatchObject({ text: "fine" });
  });

  it("the schema caps the rewrite at maxChars, and parse rejects a longer reply", async () => {
    const claude = sequencedClaude([{ rewrite: "x".repeat(281) }]);
    const { deps } = loopDeps(claude, jevScores([10]));
    await expect(humanizeLoop({ original: SLOPPY, system: "SYS", maxChars: 280 }, deps)).rejects.toThrow();
    expect(claude.calls[0]!.schema).toMatchObject({ properties: { rewrite: { maxLength: 280 } }, required: ["rewrite"] });
  });
});

describe("handleReviseDraft — humanize mode (Write's Humanize)", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    draftId: "d1", xText: SLOPPY, linkedinText: LI_OK, instruction: "Rewrite the X text so it reads human", humanize: "x", ...over,
  });

  it("runs the loop on that platform's text in the owner's voice, returns only that field plus the rounds and Jev's verdict", async () => {
    const claude = sequencedClaude([{ rewrite: "rough one" }, { rewrite: "rough two" }]);
    const checkSlop = jevScores([62, 30]);
    const { deps } = loopDeps(claude, checkSlop);
    const result = await handleReviseDraft(payload(), deps);

    expect(result).toEqual({
      xText: "rough two",
      humanize: { rounds: [{ round: 1, slopScore: 62, verdict: "slop" }, { round: 2, slopScore: 30, verdict: "human" }] },
      slop: { platform: "x", slopScore: 30, verdict: "human" },
    });
    expect(claude.calls[0]!.system).toContain("ghostwriter");
    expect(claude.calls[0]!.prompt).toContain("Original X post:");
    expect(claude.calls[0]!.schema).toMatchObject({ properties: { rewrite: { maxLength: 280 } } });
    expect(checkSlop).toHaveBeenCalledWith("rough one", "x");
  });

  it("LinkedIn: caps at 40% growth within the revision ceiling; no score means no slop field", async () => {
    const claude = sequencedClaude([{ rewrite: "l".repeat(650) }]);
    const result = await handleReviseDraft(payload({ humanize: "linkedin" }), loopDeps(claude, undefined).deps);
    expect(result).toEqual({ linkedinText: "l".repeat(650), humanize: { rounds: [{ round: 1, slopScore: null, verdict: null }] } });
    expect(claude.calls[0]!.schema).toMatchObject({ properties: { rewrite: { maxLength: Math.ceil(LI_OK.length * 1.4) } } });
  });

  it("fails clearly when the platform to humanize has no text", async () => {
    const claude = sequencedClaude([{ rewrite: "never" }]);
    await expect(handleReviseDraft(payload({ xText: null }), loopDeps(claude).deps)).rejects.toThrow("no X text to humanize");
  });

  it("without the humanize field it is still the one-shot revision", async () => {
    const claude = sequencedClaude([{ xText: "revised" }]);
    const result = await handleReviseDraft(payload({ humanize: null }), loopDeps(claude, jevScores([10])).deps);
    expect(result).toEqual({ xText: "revised" });
    expect(claude.calls[0]!.schema).toEqual(REVISE_SCHEMA);
  });
});

describe("handleGenerateFromIdea — ownText", () => {
  it("passes the owner's-own-text flag through to the prompt", async () => {
    const claude = sequencedClaude([{ drafts: [{ xText: "mine", linkedinText: LI_OK }] }]);
    await handleGenerateFromIdea({ ideaId: "i1", seedText: "My notes on pricing", seedUrl: null, ownText: true }, loopDeps(claude).deps);
    expect(claude.calls[0]!.prompt).toContain("The source is the owner's own text");

    const other = sequencedClaude([{ drafts: [{ xText: "theirs", linkedinText: LI_OK }] }]);
    await handleGenerateFromIdea({ ideaId: "i2", seedText: "Show HN: a thing", seedUrl: null }, loopDeps(other).deps);
    expect(other.calls[0]!.prompt).toContain("The source was written by someone else");
  });
});

describe("handleReviseDraft — Edit with Claude (M3.7)", () => {
  const LONG_LI = "l".repeat(700);
  const base = (over: Record<string, unknown> = {}) => ({
    draftId: "d1", xText: "My short X take", linkedinText: LONG_LI, instruction: "x", sourceText: "A long HN story about pricing", voice: "reaction", history: [], ...over,
  });

  it("custom: the source, the post, the voice and the history go in; only changed fields plus Jev's score per platform come out", async () => {
    const claude = sequencedClaude([{ xText: "shorter X" }]);
    const checkSlop = jevScores([22]);
    const { deps, progress } = loopDeps(claude, checkSlop);
    const result = await handleReviseDraft(base({ mode: "custom", instruction: "Make it shorter", history: ["Stronger hook"] }), deps);
    expect(result).toEqual({ xText: "shorter X", slopByPlatform: { x: { slopScore: 22, verdict: "human" } } });
    const prompt = claude.calls[0]!.prompt;
    expect(prompt).toContain("Source the post was written from (for context and facts):\n<<<\nA long HN story about pricing\n>>>");
    expect(prompt).toContain("X: My short X take");
    expect(prompt).toContain("The source was written by someone else");
    expect(prompt).toContain("Earlier requests on this post, oldest first:\n- Stronger hook");
    expect(prompt).toContain("Request: Make it shorter");
    expect(claude.calls[0]!.schema).toEqual(REVISE_SCHEMA);
    expect(checkSlop).toHaveBeenCalledWith("shorter X", "x");
    expect(progress.map((p) => `${p.kind}:${p.phase}`)).toEqual(["edit:rewriting", "edit:checking"]);
  });

  it("sync_linkedin: LinkedIn rewritten from X with the source for detail — X leads", async () => {
    const claude = sequencedClaude([{ linkedinText: "n".repeat(650) }]);
    const result = await handleReviseDraft(base({ mode: "sync_linkedin", instruction: "Update LinkedIn from X" }), loopDeps(claude, jevScores([30])).deps);
    expect(result).toEqual({ linkedinText: "n".repeat(650), slopByPlatform: { linkedin: { slopScore: 30, verdict: "human" } } });
    const prompt = claude.calls[0]!.prompt;
    expect(prompt).toContain("The owner reworked the X post");
    expect(prompt).toContain("X leads");
    expect(prompt).toContain("Use the source for the supporting facts and detail");
    expect(claude.calls[0]!.schema).toMatchObject({ required: ["linkedinText"], properties: { linkedinText: { minLength: 600, maxLength: 1200 } } });
  });

  it("sync_linkedin without an X text fails clearly; sync_x writes X from LinkedIn", async () => {
    await expect(handleReviseDraft(base({ mode: "sync_linkedin", xText: null }), loopDeps(sequencedClaude([{}])).deps)).rejects.toThrow("no X text");
    const claude = sequencedClaude([{ xText: "from linkedin" }]);
    const result = await handleReviseDraft(base({ mode: "sync_x", xText: null }), loopDeps(claude).deps);
    expect(result).toEqual({ xText: "from linkedin", slopByPlatform: {} });
    expect(claude.calls[0]!.prompt).toContain("Write the X version of this LinkedIn post");
  });

  it("voice: every platform rewritten in the target voice", async () => {
    const claude = sequencedClaude([{ xText: "I noticed…", linkedinText: "m".repeat(640) }]);
    const result = await handleReviseDraft(base({ mode: "voice", voice: "mine" }), loopDeps(claude).deps);
    expect(result).toEqual({ xText: "I noticed…", linkedinText: "m".repeat(640), slopByPlatform: {} });
    expect(claude.calls[0]!.prompt).toContain("The source is the owner's own text");
    expect(claude.calls[0]!.schema).toMatchObject({ required: ["xText", "linkedinText"] });
  });

  it("humanize: the loop on each platform in turn, rounds and scores per platform, progress naming the platform", async () => {
    const claude = sequencedClaude([{ rewrite: "x loose" }, { rewrite: "l".repeat(640) }]);
    const { deps, progress } = loopDeps(claude, jevScores([20, 25]));
    const result = await handleReviseDraft(base({ mode: "humanize" }), deps);
    expect(result).toEqual({
      xText: "x loose", linkedinText: "l".repeat(640),
      rounds: { x: [{ round: 1, slopScore: 20, verdict: "human" }], linkedin: [{ round: 1, slopScore: 25, verdict: "human" }] },
      slopByPlatform: { x: { slopScore: 20, verdict: "human" }, linkedin: { slopScore: 25, verdict: "human" } },
    });
    expect(progress.map((p) => `${p.platform}:${p.phase}`)).toEqual(["x:rewriting", "x:checking", "linkedin:rewriting", "linkedin:checking"]);
  });

  it("no mode is still the original one-shot Refine", async () => {
    const claude = sequencedClaude([{ xText: "refined" }]);
    expect(await handleReviseDraft(base({ mode: null }), loopDeps(claude, jevScores([10])).deps)).toEqual({ xText: "refined" });
    expect(claude.calls[0]!.prompt.startsWith("Current draft:")).toBe(true);
  });

  it("generate_from_idea: an explicit voice wins over ownText", async () => {
    const claude = sequencedClaude([{ drafts: [{ xText: "t", linkedinText: LI_OK }] }]);
    await handleGenerateFromIdea({ seedText: "someone's post", ownText: false, voice: "mine" }, loopDeps(claude).deps);
    expect(claude.calls[0]!.prompt).toContain("The source is the owner's own text");
  });
});

describe("hashtags the owner doesn't allow", () => {
  it("stripHashtagLines drops hashtag-only lines and keeps inline words", () => {
    expect(stripHashtagLines("One line.\n\nMore here.\n\n#buildinpublic #search #AI #startups")).toBe("One line.\n\nMore here.");
    expect(stripHashtagLines("I use #rust at work.\n#one, #two.")).toBe("I use #rust at work.");
  });

  it("an edit reply loses its hashtag block unless the tone form allows hashtags", async () => {
    const claude = sequencedClaude([{ linkedinText: `${"l".repeat(640)}\n\n#buildinpublic #AI` }]);
    const out = await handleReviseDraft({ draftId: "d", xText: "x", linkedinText: "old", instruction: "i", mode: "sync_linkedin", voice: "mine" }, loopDeps(claude).deps);
    expect(out.linkedinText).toBe("l".repeat(640));

    const allowed = sequencedClaude([{ linkedinText: `${"l".repeat(640)}\n\n#buildinpublic` }]);
    const deps: HandlerDeps = { getProfile: async () => emptyProfile({ toneForm: { hashtags: "yes" } }), runClaudeJson: allowed.fn };
    const kept = await handleReviseDraft({ draftId: "d", xText: "x", linkedinText: "old", instruction: "i", mode: "sync_linkedin", voice: "mine" }, deps);
    expect(kept.linkedinText).toContain("#buildinpublic");
  });

  it("generated takes are cleaned too", async () => {
    const claude = sequencedClaude([{ drafts: [{ xText: "a take\n#ai", linkedinText: `${"l".repeat(640)}\n#tag` }] }]);
    const out = await handleGenerateFromIdea({ seedText: "s" }, loopDeps(claude).deps);
    expect(out.drafts).toEqual([{ xText: "a take" }]);
  });
});

describe("handleGenerateFromVideo — voice", () => {
  it("a voice in the payload adds its rule; none keeps the old prompt", async () => {
    const fetchTranscript = async () => ({ text: "the talk", truncated: false });
    const withVoice = sequencedClaude([{ drafts: [{ xText: "t", linkedinText: LI_OK }] }]);
    await handleGenerateFromVideo({ url: "https://youtu.be/a", voice: "reaction" }, { ...loopDeps(withVoice).deps, fetchTranscript });
    expect(withVoice.calls[0]!.prompt).toContain("The source was written by someone else");

    const without = sequencedClaude([{ drafts: [{ xText: "t", linkedinText: LI_OK }] }]);
    await handleGenerateFromVideo({ url: "https://youtu.be/a" }, { ...loopDeps(without).deps, fetchTranscript });
    expect(without.calls[0]!.prompt).not.toContain("The source was written by someone else");
    expect(without.calls[0]!.prompt).not.toContain("The source is the owner's own text");
  });
});

describe("X first, LinkedIn on request (2026-09-24)", () => {
  it("takes are X posts unless withLinkedin; with it, both platforms and the both-platform schema", async () => {
    const xOnly = sequencedClaude([{ drafts: [{ xText: "just X" }] }]);
    const out = await handleGenerateFromIdea({ seedText: "s" }, loopDeps(xOnly).deps);
    expect(out.drafts).toEqual([{ xText: "just X" }]);
    expect(xOnly.calls[0]!.schema).toBe(X_DRAFTS_SCHEMA);
    expect(xOnly.calls[0]!.prompt).toContain("candidate X post(s)");
    expect(xOnly.calls[0]!.prompt).not.toContain("linkedinText");

    const both = sequencedClaude([{ drafts: [{ xText: "x", linkedinText: LI_OK }] }]);
    const out2 = await handleGenerateFromIdea({ seedText: "s", withLinkedin: true }, loopDeps(both).deps);
    expect(out2.drafts).toEqual([{ xText: "x", linkedinText: LI_OK }]);
    expect(both.calls[0]!.schema).toBe(DRAFTS_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// The best three takes (2026-09-24: "non farmi mai più di 3 takes, tienimi le
// migliori con un check di Jev")
// ---------------------------------------------------------------------------

describe("generate: Jev keeps the most human takes", () => {
  const five = { drafts: ["one", "two", "three", "four", "five"].map((xText) => ({ xText })) };

  it("with Jev reachable, Claude writes two more than asked and the most human ones come back, best first, each with its score", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson(five);
    const scores: Record<string, number> = { one: 70, two: 15, three: 55, four: 30, five: 90 };
    const checkSlop = vi.fn(async (text: string, _platform?: "x" | "linkedin") => ({ slopScore: scores[text]!, verdict: scores[text]! < 35 ? "human" : "slop" }));
    const progress: Array<Record<string, unknown>> = [];
    const out = await handleGenerateFromIdea(
      { seedText: "an idea", count: 3 },
      { getProfile: async () => emptyProfile(), runClaudeJson, checkSlop, reportProgress: async (p) => { progress.push(p); } },
    );
    expect(calls[0]?.prompt).toContain("Write 5 candidate X post(s)");
    expect(checkSlop).toHaveBeenCalledTimes(5);
    expect(checkSlop.mock.calls.every((c) => c[1] === "x")).toBe(true);
    expect(out.drafts).toEqual([
      { xText: "two", slop: { platform: "x", slopScore: 15, verdict: "human" } },
      { xText: "four", slop: { platform: "x", slopScore: 30, verdict: "human" } },
      { xText: "three", slop: { platform: "x", slopScore: 55, verdict: "slop" } },
    ]);
    expect(progress).toEqual([{ kind: "generate", phase: "writing" }, { kind: "generate", phase: "checking" }]);
  });

  it("a take Jev couldn't score ranks after the scored ones; without Jev, exactly what was asked for comes back", async () => {
    const { fn: runClaudeJson } = fakeRunClaudeJson(five);
    const checkSlop = vi.fn(async (text: string) => {
      if (text === "one") throw new Error("jev down");
      return { slopScore: text === "two" ? 80 : 40, verdict: "slop" };
    });
    const scored = await handleGenerateFromIdea({ seedText: "an idea", count: 4 }, { getProfile: async () => emptyProfile(), runClaudeJson, checkSlop });
    expect((scored.drafts as Array<{ xText: string }>).map((d) => d.xText)).toEqual(["three", "four", "five", "two"]);

    const plain = fakeRunClaudeJson({ drafts: [{ xText: "a" }, { xText: "b" }, { xText: "c" }] });
    const out = await handleGenerateFromIdea({ seedText: "an idea", count: 3 }, { getProfile: async () => emptyProfile(), runClaudeJson: plain.fn });
    expect(plain.calls[0]?.prompt).toContain("Write 3 candidate X post(s)");
    expect(out.drafts).toEqual([{ xText: "a" }, { xText: "b" }, { xText: "c" }]);
  });

  it("videos too: a LinkedIn-only take is scored on its LinkedIn text", async () => {
    const { fn: runClaudeJson, calls } = fakeRunClaudeJson({ drafts: [{ xText: "x one", linkedinText: LI_OK }, { xText: "", linkedinText: LI_OK }] });
    const checkSlop = vi.fn(async (_text: string, platform?: "x" | "linkedin") => ({ slopScore: platform === "linkedin" ? 10 : 50, verdict: "v" }));
    const out = await handleGenerateFromVideo(
      { url: "https://www.youtube.com/watch?v=abc", transcript: "a talk transcript", count: 1, withLinkedin: true },
      { getProfile: async () => emptyProfile(), runClaudeJson, checkSlop },
    );
    expect(calls[0]?.prompt).toContain("Write 3 candidate post(s)");
    expect(out.drafts).toEqual([{ xText: "", linkedinText: LI_OK, slop: { platform: "linkedin", slopScore: 10, verdict: "v" } }]);
  });
});

describe("handleLearnStyle", () => {
  const lessons = [
    { trait: "numbers", value: "yes", direction: "more", lift: 4.5, text: "Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped." },
    { trait: "hook", value: "claim", direction: "less", lift: 0.2, text: "Opens with a bold claim: 1 of 10 you kept, 6 of 9 you dropped." },
  ];

  it("briefs Claude with jev-judge's prompt and schema, and returns the checked update", async () => {
    const claude = fakeRunClaudeJson({ guide: " Open with a number. ", changes: [{ summary: "Lead with a number", reason: "7 of 10 kept do" }] });
    const deps: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: claude.fn };
    const result = await handleLearnStyle({ guide: "Short sentences.", lessons, edits: ["Shorter (asked 3 times)"], examples: ["I shipped 3 fixes."] }, deps);

    expect(result).toEqual({ guide: "Open with a number.", changes: [{ summary: "Lead with a number", reason: "7 of 10 kept do" }] });
    const [call] = claude.calls;
    expect(call!.prompt).toContain("Short sentences.");
    expect(call!.prompt).toContain("- Do more: Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped.");
    expect(call!.prompt).toContain("- Do less: Opens with a bold claim");
    expect(call!.prompt).toContain("- Shorter (asked 3 times)");
    expect(call!.prompt).toContain("I shipped 3 fixes.");
    expect(call!.system).toContain("style guide");
    expect(call!.system).not.toContain("ghostwriter");
    expect(call!.schema).toMatchObject({ required: ["guide", "changes"] });
  });

  it("a first guide, and runHandler routes it", async () => {
    const claude = fakeRunClaudeJson({ guide: "Open with a number.", changes: [] });
    const deps: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: claude.fn };
    const outcome = await runHandler(makeJob({ kind: "learn_style", payload: { guide: null, lessons } }), deps);
    expect(outcome).toEqual({ ok: true, result: { guide: "Open with a number.", changes: [] } });
    expect(claude.calls[0]!.prompt).toContain("(empty: this will be their first one)");
  });

  it("no lessons, or a reply that isn't an update, fails the job", async () => {
    const deps: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: fakeRunClaudeJson({ guide: "g", changes: [] }).fn };
    await expect(handleLearnStyle({ guide: "g", lessons: [] }, deps)).rejects.toThrow("learn_style needs a lesson");
    const bad: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: fakeRunClaudeJson({ guide: "" }).fn };
    await expect(handleLearnStyle({ guide: "g", lessons }, bad)).rejects.toThrow("guide update");
  });
});

describe("handleRepoPosts (posts from a repo, 2026-10-10)", () => {
  const folder = { type: "folder" as const, path: "/Users/me/dev/postecho" };
  const github = { type: "github" as const, url: "https://github.com/a/b" };

  function repoDeps(fixture: unknown, resolved = { dir: "/Users/me/dev/postecho", name: "postecho" }) {
    const claude = fakeRunClaudeJson(fixture);
    const progress: Array<Record<string, unknown>> = [];
    const resolveRepo = vi.fn(async () => resolved);
    const deps: HandlerDeps = {
      getProfile: async () => emptyProfile(),
      runClaudeJson: claude.fn,
      resolveRepo,
      reportProgress: async (p) => { progress.push(p); },
    };
    return { deps, claude, progress, resolveRepo };
  }

  it("reads a folder with read tools only, in that folder, and returns the posts trimmed to the count", async () => {
    const { deps, claude, progress, resolveRepo } = repoDeps({ posts: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    const result = await handleRepoPosts({ ideaId: "i1", source: folder, brief: "tier gating", format: "x", count: 2 }, deps);
    expect(resolveRepo).toHaveBeenCalledWith(folder);
    expect(result).toEqual({ posts: [{ text: "one" }, { text: "two" }], repoName: "postecho" });
    expect(progress).toEqual([{ kind: "repo_posts", phase: "reading" }, { kind: "repo_posts", phase: "writing" }]);
    const [call] = claude.calls;
    expect(call!.cwd).toBe("/Users/me/dev/postecho");
    expect(call!.readOnlyTools).toBe(true);
    expect(call!.schema).toBe(REPO_X_SCHEMA);
    expect(call!.prompt).toContain("postecho");
    expect(call!.prompt).toContain("tier gating");
    expect(call!.prompt).toContain("exactly 2 X posts");
  });

  it("passes the posts already written from the repo to the prompt", async () => {
    const { deps, claude } = repoDeps({ posts: [{ text: "new one" }] });
    await handleRepoPosts({ ideaId: "i1", source: folder, brief: "", format: "x", count: 1, previous: ["An old post."] }, deps);
    expect(claude.calls[0]!.prompt).toContain("- An old post.");
  });

  it("says it's fetching first for a GitHub repository, and writes articles with titles", async () => {
    const article = { title: "How it works", text: "b".repeat(3000) };
    const { deps, claude, progress } = repoDeps({ posts: [article] }, { dir: "/repos/a__b", name: "a/b" });
    const result = await handleRepoPosts({ ideaId: "i1", source: github, brief: "", format: "article", count: 1 }, deps);
    expect(result).toEqual({ posts: [article], repoName: "a/b" });
    expect(progress.map((p) => p.phase)).toEqual(["fetching", "reading", "writing"]);
    expect(claude.calls[0]!.schema).toBe(REPO_ARTICLE_SCHEMA);
    expect(claude.calls[0]!.cwd).toBe("/repos/a__b");
  });

  it("LinkedIn posts use their own schema", async () => {
    const { deps, claude } = repoDeps({ posts: [{ text: LI_OK }] });
    await handleRepoPosts({ ideaId: "i1", source: folder, brief: "", format: "linkedin", count: 1 }, deps);
    expect(claude.calls[0]!.schema).toBe(REPO_LINKEDIN_SCHEMA);
  });

  it("refuses a payload out of bounds before reading anything", async () => {
    const { deps, resolveRepo } = repoDeps({ posts: [{ text: "one" }] });
    const base = { ideaId: "i1", source: folder, brief: "", format: "x", count: 3 };
    await expect(handleRepoPosts({ ...base, count: 0 }, deps)).rejects.toThrow();
    await expect(handleRepoPosts({ ...base, count: 7 }, deps)).rejects.toThrow();
    await expect(handleRepoPosts({ ...base, format: "thread" }, deps)).rejects.toThrow();
    await expect(handleRepoPosts({ ...base, source: { type: "folder", path: "" } }, deps)).rejects.toThrow();
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  it("a source that can't be read fails the job with its sentence", async () => {
    const { deps } = repoDeps({ posts: [] });
    deps.resolveRepo = async () => { throw new Error("This folder doesn't exist, or isn't a folder: /nope"); };
    const outcome = await runHandler(
      makeJob({ kind: "repo_posts", payload: { ideaId: "i1", source: { type: "folder", path: "/nope" }, brief: "", format: "x", count: 3 } }),
      deps,
    );
    expect(outcome).toEqual({ ok: false, error: "This folder doesn't exist, or isn't a folder: /nope" });
  });
});

describe("handlePickFolder (posts from a repo, 2026-10-10)", () => {
  it("returns the folder the owner picked", async () => {
    const deps: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: fakeRunClaudeJson({}).fn, pickFolder: async () => ({ path: "/Users/me/dev/postecho" }) };
    expect(await handlePickFolder({}, deps)).toEqual({ path: "/Users/me/dev/postecho" });
  });

  it("says when the owner cancelled", async () => {
    const deps: HandlerDeps = { getProfile: async () => emptyProfile(), runClaudeJson: fakeRunClaudeJson({}).fn, pickFolder: async () => ({ cancelled: true }) };
    expect(await handlePickFolder({}, deps)).toEqual({ cancelled: true });
  });

  it("fails with the picker's sentence when there is none", async () => {
    const deps: HandlerDeps = {
      getProfile: async () => emptyProfile(),
      runClaudeJson: fakeRunClaudeJson({}).fn,
      pickFolder: async () => { throw new Error("No folder picker on this computer: type the path instead."); },
    };
    expect(await runHandler(makeJob({ kind: "pick_folder", payload: {} }), deps))
      .toEqual({ ok: false, error: "No folder picker on this computer: type the path instead." });
  });
});
