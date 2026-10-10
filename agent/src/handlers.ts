import { GUIDE_UPDATE_SCHEMA, guideUpdatePrompt, humanize, HUMANIZE_MAX_ROUNDS, parseGuideUpdate, type HumanizeRound } from "jev-judge";
import { z } from "zod";
import {
  editPrompt,
  generatePrompt,
  humanizePrompt,
  imagePrompt as buildImagePrompt,
  revisePrompt,
  styleEditorSystemPrompt,
  styleGuidePrompt,
  systemPrompt,
  videoPostsPrompt,
  repoPostsPrompt,
  type EditMode,
  type GeneratePromptOptions,
  type JevVerdict,
  type Voice,
} from "./prompts.js";
import type { Job, JobOutcome, Profile } from "./postecho.js";
import {
  DRAFTS_SCHEMA,
  X_DRAFTS_SCHEMA,
  parseXDraftsResult,
  humanizeMaxChars,
  humanizeSchema,
  IMAGE_PROMPT_SCHEMA,
  parseDraftsResult,
  parseHumanizeResult,
  parseImagePromptResult,
  parseReviseResult,
  parseStyleGuideResult,
  parseSyncLinkedinResult,
  parseSyncXResult,
  parseVoiceResult,
  parseRepoPosts,
  REPO_SCHEMAS,
  REVISE_SCHEMA,
  STYLE_GUIDE_SCHEMA,
  SYNC_LINKEDIN_SCHEMA,
  SYNC_X_SCHEMA,
  voiceSchema,
} from "./schemas.js";
import { fetchTranscript as defaultFetchTranscript, normalizeTranscript, TranscriptUnavailable } from "./transcript.js";
import type { PickFolderResult } from "./pick-folder.js";
import type { RepoSource } from "./repo-source.js";

/** What every handler needs, injected so tests can pass plain fakes instead of the real network/CLI/library. */
export type RunClaudeJsonFn = <T>(opts: {
  prompt: string;
  system: string;
  schema: object;
  parse: (value: unknown) => T;
  /** Posts from a repo: Claude Code runs in this directory with read tools only (claude.ts). */
  cwd?: string;
  readOnlyTools?: boolean;
  /** A long read, like a whole repository: twice the time, whatever the job's kind. */
  long?: boolean;
}) => Promise<T>;

export type FetchTranscriptFn = (
  url: string,
  opts?: { langs?: string[] },
) => Promise<{ text: string; truncated: boolean; lang?: string | null }>;

export type HandlerDeps = {
  /** Called fresh inside every handler invocation — never cached across jobs, so a tone-of-voice edit takes effect on the very next job. */
  getProfile: () => Promise<Profile>;
  runClaudeJson: RunClaudeJsonFn;
  /** Defaults to transcript.ts's real fetchTranscript; overridable for tests. */
  fetchTranscript?: FetchTranscriptFn;
  /**
   * Jev's AI-style check, run by the web app (POST /api/agent/slop-check —
   * the TypeSafe key lives on the server, not on this Mac). Absent, or
   * failing, the humanize loop stops after its first rewrite.
   */
  checkSlop?: (text: string, platform?: "x" | "linkedin") => Promise<JevVerdict>;
  /** Live progress for the job being run (POST /api/agent/jobs/:id/progress). Best effort: a failure never fails the job. */
  reportProgress?: (progress: Record<string, unknown>) => Promise<void>;
  /** repo_posts: the directory a source is read from (repo-source.ts's resolveRepo with real git and ~/.postecho/repos). */
  resolveRepo?: (source: RepoSource) => Promise<{ dir: string; name: string }>;
  /** pick_folder: the OS folder picker on this computer (pick-folder.ts). */
  pickFolder?: () => Promise<PickFolderResult>;
};

const CountSchema = z.coerce.number().int().min(1).max(25).catch(3);

/**
 * Web spreads nullable columns (drafts.xText / drafts.linkedinText, ideas.url)
 * straight into job payloads — see its videos, drafts/from-idea, revise and
 * image-prompt routes — so an absent value arrives as JSON `null`, not as a
 * missing key. Every payload field sourced from such a column is therefore
 * `.nullish()`, never merely `.optional()` (which rejects null outright and
 * would fail every X-only or LinkedIn-only draft before Claude ever ran).
 */
const NullishText = z.string().nullish();

const GenerateFromVideoPayload = z.object({
  ideaId: z.string().optional(),
  url: z.string().min(1, "generate_from_video needs a url"),
  instructions: z.string().optional().default(""),
  count: CountSchema.optional().default(3),
  // Web's language toggle (spec §4: "English default / video's original
  // language") is a boolean. A language name is accepted too, for callers
  // that want to be explicit.
  originalLanguage: z.union([z.boolean(), z.string()]).nullish(),
  transcript: NullishText,
  // Use on a YouTube card sends the post's voice (lib/voice.ts on web); the
  // Videos form doesn't, and gets no voice rule, as before.
  voice: z.enum(["mine", "reaction"]).nullish(),
  // LinkedIn versions too (off by default since 2026-09-24).
  withLinkedin: z.boolean().nullish(),
  // Use on a Videos topic (2026-09-27): write about that topic, from the whole transcript.
  topic: z.object({ title: z.string().trim().min(1).max(200), summary: z.string().max(1000) }).nullish(),
});

const VideoIdeasPayload = z.object({
  ideaId: z.string().optional(),
  url: z.string().min(1, "video_ideas needs a url"),
  title: NullishText,
  // Twelve: six shown, six behind Show more (web's api/videos/ideas).
  count: z.coerce.number().int().min(1).max(25).catch(12).optional().default(12),
  originalLanguage: z.union([z.boolean(), z.string()]).nullish(),
  transcript: NullishText,
  // The video's description and chapters (web's videoDescriptionFor), for when YouTube has no transcript.
  description: NullishText,
});

/** Below this, a description has too little in it to find ideas from. */
const MIN_DESCRIPTION_CHARS = 200;

const GenerateFromIdeaPayload = z.object({
  ideaId: z.string().optional(),
  seedText: NullishText,
  seedUrl: NullishText,
  // The seed is the owner's own text (Write's "+ New", 2026-09-24), not
  // someone else's post: write it as theirs. Absent on older web builds.
  ownText: z.boolean().nullish(),
  // Write's voice switch (M3.7): the post's voice, explicit. Wins over ownText.
  voice: z.enum(["mine", "reaction"]).nullish(),
  // LinkedIn versions too (off by default since 2026-09-24).
  withLinkedin: z.boolean().nullish(),
  instructions: z.string().optional().default(""),
  count: CountSchema.optional().default(3),
});

const ReviseDraftPayload = z
  .object({
    draftId: z.string(),
    xText: NullishText,
    linkedinText: NullishText,
    instruction: z.string().min(1, "revise_draft needs an instruction"),
    // Write's Humanize (M3.6): run the Claude <-> Jev loop on this platform's
    // text instead of a one-shot revision. The instruction is still sent, so
    // an agent that predates this field degrades to the one-shot humanize.
    humanize: z.enum(["x", "linkedin"]).nullish(),
    // Write's Edit with Claude (M3.7): which kind of request, the post's
    // voice, what it was written from and the requests so far. An absent
    // mode is the original one-shot Refine.
    mode: z.enum(["custom", "humanize", "sync_linkedin", "sync_x", "voice"]).nullish(),
    voice: z.enum(["mine", "reaction"]).nullish(),
    sourceText: NullishText,
    history: z.array(z.string()).max(20).nullish(),
    // A post from a repo (2026-10-10): the repository it came from. Moving it to the other platform
    // reads the whole repository again, the way a video's LinkedIn version had its whole transcript.
    repo: z.discriminatedUnion("type", [
      z.object({ type: z.literal("folder"), path: z.string().trim().min(1) }),
      z.object({ type: z.literal("github"), url: z.string().trim().min(1) }),
    ]).nullish(),
  })
  .refine((p) => Boolean(p.xText || p.linkedinText), {
    message: "revise_draft needs an xText and/or a linkedinText to revise",
  });

const ImagePromptPayload = z
  .object({
    draftId: z.string(),
    xText: NullishText,
    linkedinText: NullishText,
    imageSpecs: NullishText,
  })
  .refine((p) => Boolean(p.xText || p.linkedinText), {
    message: "image_prompt needs an xText and/or a linkedinText to work from",
  });

const AnalyzeStylePayload = z.object({
  toneExamplesX: z.string().optional().default(""),
  toneExamplesLinkedin: z.string().optional().default(""),
  toneForm: z.record(z.string(), z.unknown()).optional().default({}),
  // Style inspiration (2026-09-24): posts by other people to borrow structure from.
  inspiration: z.array(z.string()).max(20).optional().default([]),
});

/**
 * Maps web's `originalLanguage` toggle onto generatePrompt's language options:
 * `true` keeps the video's own language, `false`/absent means English (the
 * toggle's documented default), and a non-blank string names the language.
 */
function languageOptions(
  originalLanguage: boolean | string | null | undefined,
): Pick<GeneratePromptOptions, "language" | "keepSourceLanguage"> {
  if (originalLanguage === true) return { keepSourceLanguage: true };
  if (typeof originalLanguage === "string" && originalLanguage.trim()) return { language: originalLanguage.trim() };
  return { language: "English" };
}

/**
 * Whether the owner allows hashtags (Settings' tone form) — the system prompt's
 * rule. Live (2026-09-24) an edit still came back with a trailing
 * "#buildinpublic #search #AI" line, so a reply is also cleaned when they're
 * not allowed (stripHashtagLines).
 */
function hashtagsAllowed(profile: Profile): boolean {
  return profile.toneForm?.hashtags === "yes";
}

/** Drops lines made only of hashtags (the trailing "#a #b #c" block); inline words stay as written. */
export function stripHashtagLines(text: string): string {
  const kept = text.split("\n").filter((line) => !/^\s*(#[\p{L}\p{N}_]+[\s,.]*)+$/u.test(line));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cleanFields<T extends { xText?: string; linkedinText?: string }>(fields: T, profile: Profile): T {
  if (hashtagsAllowed(profile)) return fields;
  return {
    ...fields,
    ...(fields.xText !== undefined ? { xText: stripHashtagLines(fields.xText) } : {}),
    ...(fields.linkedinText !== undefined ? { linkedinText: stripHashtagLines(fields.linkedinText) } : {}),
  };
}

/** generate_from_video: transcript (fetched, or payload.transcript verbatim) -> candidate drafts in the owner's voice. */
export async function handleGenerateFromVideo(payload: unknown, deps: HandlerDeps): Promise<{ drafts: unknown }> {
  const p = GenerateFromVideoPayload.parse(payload);

  // payload.transcript (owner pasted it manually after a fetch failure) always wins over fetching again.
  const { text: sourceText } = p.transcript
    ? normalizeTranscript(p.transcript)
    : await (deps.fetchTranscript ?? defaultFetchTranscript)(p.url, {});

  const profile = await deps.getProfile();
  await reportGenerate(deps, "writing");
  return pickBestTakes(cleanDrafts(await deps.runClaudeJson({
    prompt: generatePrompt({
      sourceKind: "video",
      sourceText,
      instructions: p.instructions,
      count: askFor(p.count, deps),
      ...languageOptions(p.originalLanguage),
      ...(p.voice ? { voice: p.voice } : {}),
      withLinkedin: p.withLinkedin === true,
      topic: p.topic ?? null,
    }),
    system: systemPrompt(profile),
    schema: p.withLinkedin ? DRAFTS_SCHEMA : X_DRAFTS_SCHEMA,
    parse: p.withLinkedin ? parseDraftsResult : parseXDraftsResult,
  }), profile), p.count, deps);
}

/** What the page says the video was read from: YouTube's track (and its language), a pasted script, or the description. */
type VideoRead = { source: "transcript" | "description"; lang?: string | null; pasted?: boolean };

async function reportVideoIdeas(deps: HandlerDeps, phase: "reading" | "writing" | "checking", read?: VideoRead): Promise<void> {
  if (!deps.reportProgress) return;
  try { await deps.reportProgress({ kind: "video_ideas", phase, ...read }); } catch { /* a courtesy to the page */ }
}

/**
 * video_ideas (2026-09-27): the whole transcript (fetched, or pasted by hand)
 * -> the best X posts in it, ready as they are (owner: "post X pronti
 * all'attacco senza titolo, 6+6"). With Jev reachable Claude writes a couple
 * more and the most human are kept, each with its score, in Claude's order
 * (web ranks them with Jev's ✦ too). The text it read comes back as well:
 * web keeps it on the job. Each phase is reported so the page can say it.
 */
export async function handleVideoIdeas(payload: unknown, deps: HandlerDeps): Promise<{ posts: unknown; source: "transcript" | "description"; text: string }> {
  const p = VideoIdeasPayload.parse(payload);
  let source: "transcript" | "description" = "transcript";
  let text: string;
  let read: VideoRead = { source, pasted: true };
  await reportVideoIdeas(deps, "reading");
  if (p.transcript) {
    text = normalizeTranscript(p.transcript).text;
  } else {
    try {
      const fetched = await (deps.fetchTranscript ?? defaultFetchTranscript)(p.url, {});
      text = fetched.text;
      read = { source, lang: fetched.lang ?? null };
    } catch (e) {
      // No transcript in any language (2026-09-27: "non esiste un fallback… senza farlo manualmente?"):
      // the description and chapters, when they say enough; otherwise the owner is asked to paste it.
      const description = p.description?.trim() ?? "";
      if (!(e instanceof TranscriptUnavailable) || description.length < MIN_DESCRIPTION_CHARS) throw e;
      text = description;
      source = "description";
      read = { source };
    }
  }
  const profile = await deps.getProfile();
  await reportVideoIdeas(deps, "writing", read);
  const written = cleanDrafts(await deps.runClaudeJson({
    prompt: videoPostsPrompt({
      title: p.title,
      transcript: text,
      count: askFor(p.count, deps),
      fromDescription: source === "description",
      ...languageOptions(p.originalLanguage),
    }),
    system: systemPrompt(profile),
    schema: X_DRAFTS_SCHEMA,
    parse: parseXDraftsResult,
  }), profile);
  const best = await pickBestTakes(written, p.count, deps, { inOrder: true, report: () => reportVideoIdeas(deps, "checking", read) });
  return { posts: best.drafts, source, text };
}

function cleanDrafts(result: { drafts: Array<{ xText: string; linkedinText?: string }> }, profile: Profile) {
  return { drafts: result.drafts.map((d) => cleanFields(d, profile)) };
}

// ---------------------------------------------------------------------------
// The best three takes (owner, 2026-09-24: "non farmi mai più di 3 takes,
// tienimi le migliori con un check di Jev"): with Jev reachable, Claude writes
// a couple more than asked, Jev scores each, and the most human ones are kept,
// each with its score (web stores it, so the card's badge needs no check).
// ---------------------------------------------------------------------------

/** How many more than asked Claude writes when Jev can pick among them. */
export const EXTRA_TAKES_FOR_JEV = 2;

function askFor(count: number, deps: HandlerDeps): number {
  return deps.checkSlop ? Math.min(25, count + EXTRA_TAKES_FOR_JEV) : count;
}

async function reportGenerate(deps: HandlerDeps, phase: "writing" | "checking"): Promise<void> {
  if (!deps.reportProgress) return;
  try { await deps.reportProgress({ kind: "generate", phase }); } catch { /* a courtesy to the page */ }
}

type Take = { xText: string; linkedinText?: string };
type ScoredTake = Take & { slop?: { platform: "x" | "linkedin"; slopScore: number; verdict: string } };

/**
 * Jev scores every take (its X text, else its LinkedIn one) and the `keep`
 * most human survive, most human first — or, `inOrder`, in the order Claude
 * wrote them (a video's posts, best first). `report` says the check started.
 */
export async function pickBestTakes(
  result: { drafts: Take[] },
  keep: number,
  deps: HandlerDeps,
  { inOrder = false, report }: { inOrder?: boolean; report?: () => Promise<void> } = {},
): Promise<{ drafts: ScoredTake[] }> {
  const checkSlop = deps.checkSlop;
  if (!checkSlop) return { drafts: result.drafts.slice(0, keep) };
  await (report ? report() : reportGenerate(deps, "checking"));
  const scored = await Promise.all(result.drafts.map(async (take, i) => {
    const platform: "x" | "linkedin" = take.xText?.trim() ? "x" : "linkedin";
    const text = platform === "x" ? take.xText : take.linkedinText ?? "";
    try {
      const verdict = text.trim() ? await checkSlop(text, platform) : null;
      return { take, i, platform, verdict };
    } catch {
      return { take, i, platform, verdict: null };
    }
  }));
  scored.sort((a, b) => (a.verdict?.slopScore ?? 101) - (b.verdict?.slopScore ?? 101) || a.i - b.i);
  const kept = scored.slice(0, keep);
  if (inOrder) kept.sort((a, b) => a.i - b.i);
  return {
    drafts: kept.map(({ take, platform, verdict }) =>
      verdict ? { ...take, slop: { platform, slopScore: verdict.slopScore, verdict: verdict.verdict } } : take),
  };
}

/** generate_from_idea: a saved idea's seed text/url -> candidate drafts in the owner's voice. */
export async function handleGenerateFromIdea(payload: unknown, deps: HandlerDeps): Promise<{ drafts: unknown }> {
  const p = GenerateFromIdeaPayload.parse(payload);
  const sourceText = [p.seedText, p.seedUrl].filter((part) => part && part.trim()).join("\n");
  if (!sourceText.trim()) {
    throw new Error("generate_from_idea needs a seedText and/or a seedUrl to generate from");
  }

  const profile = await deps.getProfile();
  await reportGenerate(deps, "writing");
  return pickBestTakes(cleanDrafts(await deps.runClaudeJson({
    prompt: generatePrompt({
      sourceKind: "idea",
      sourceText,
      instructions: p.instructions,
      count: askFor(p.count, deps),
      ownText: (p.voice ?? (p.ownText ? "mine" : "reaction")) === "mine",
      withLinkedin: p.withLinkedin === true,
    }),
    system: systemPrompt(profile),
    schema: p.withLinkedin ? DRAFTS_SCHEMA : X_DRAFTS_SCHEMA,
    parse: p.withLinkedin ? parseDraftsResult : parseXDraftsResult,
  }), profile), p.count, deps);
}

/** revise_draft: one draft + a free-text instruction -> a revised xText/linkedinText. */
export async function handleReviseDraft(
  payload: unknown,
  deps: HandlerDeps,
): Promise<Record<string, unknown>> {
  const p = ReviseDraftPayload.parse(payload);
  const profile = await deps.getProfile();
  if (p.humanize) {
    const field = p.humanize === "x" ? "xText" : "linkedinText";
    const label = p.humanize === "x" ? "X" : "LinkedIn";
    const original = p[field];
    if (!original?.trim()) throw new Error(`revise_draft: there is no ${label} text to humanize`);
    const out = await humanizeLoop(
      {
        original,
        platform: p.humanize,
        platformLabel: label,
        system: systemPrompt(profile),
        maxChars: humanizeMaxChars(original, p.humanize),
      },
      deps,
    );
    // Only the humanized platform's field, like any revision; web carries the
    // other one over. `slop` is Jev's verdict on the returned text, so the
    // revision's badge needs no second check (web's materializeRevision).
    return {
      [field]: out.text,
      humanize: { rounds: out.rounds },
      ...(out.slop ? { slop: { platform: p.humanize, slopScore: out.slop.slopScore, verdict: out.slop.verdict } } : {}),
    };
  }
  if (p.mode) {
    let editDeps = deps;
    let sourceText = p.sourceText ?? undefined;
    if (p.repo && (p.mode === "sync_linkedin" || p.mode === "sync_x") && deps.resolveRepo) {
      const repo = await deps.resolveRepo(p.repo);
      editDeps = { ...deps, runClaudeJson: (o) => deps.runClaudeJson({ ...o, cwd: repo.dir, readOnlyTools: true, long: true }) };
      sourceText = `The post came from the repository "${repo.name}", your working directory. Read it with Read, Glob and Grep for the detail the other version has no room for: what it does, the decisions behind it, the details in the code. Never invent what the repository doesn't show.`;
    }
    return handleEdit(
      {
        mode: p.mode,
        xText: p.xText ?? undefined,
        linkedinText: p.linkedinText ?? undefined,
        sourceText,
        voice: p.voice ?? "reaction",
        history: p.history ?? [],
        instruction: p.instruction,
      },
      systemPrompt(profile),
      editDeps,
      profile,
    );
  }
  return deps.runClaudeJson({
    prompt: revisePrompt({
      xText: p.xText ?? undefined,
      linkedinText: p.linkedinText ?? undefined,
      instruction: p.instruction,
    }),
    system: systemPrompt(profile),
    schema: REVISE_SCHEMA,
    parse: parseReviseResult,
  });
}

// ---------------------------------------------------------------------------
// Edit with Claude (M3.7) — Write's chat. Every request lands as a new
// version; every reply carries Jev's score per platform it changed (owner,
// 2026-09-24: the full loop only when Humanize is asked for).
// ---------------------------------------------------------------------------

type EditRequest = {
  mode: EditMode | "humanize";
  xText?: string;
  linkedinText?: string;
  sourceText?: string;
  voice: Voice;
  history: string[];
  instruction: string;
};

type Platform = "x" | "linkedin";
type Fields = { xText?: string; linkedinText?: string };
const FIELD: Record<Platform, keyof Fields> = { x: "xText", linkedin: "linkedinText" };

async function handleEdit(req: EditRequest, system: string, deps: HandlerDeps, profile: Profile): Promise<Record<string, unknown>> {
  const report = async (progress: Record<string, unknown>) => {
    if (!deps.reportProgress) return;
    try { await deps.reportProgress(progress); } catch { /* a courtesy to the page */ }
  };

  if (req.mode === "humanize") {
    const fields: Fields = {};
    const rounds: Partial<Record<Platform, HumanizeRound[]>> = {};
    const slopByPlatform: Partial<Record<Platform, JevVerdict>> = {};
    for (const platform of ["x", "linkedin"] as const) {
      const original = req[FIELD[platform]];
      if (!original?.trim()) continue;
      const out = await humanizeLoop(
        { original, platform, platformLabel: platform === "x" ? "X" : "LinkedIn", system, maxChars: humanizeMaxChars(original, platform) },
        deps,
      );
      fields[FIELD[platform]] = out.text;
      rounds[platform] = out.rounds;
      if (out.slop) slopByPlatform[platform] = out.slop;
    }
    if (!fields.xText && !fields.linkedinText) throw new Error("revise_draft: there is no text to humanize");
    return { ...fields, rounds, slopByPlatform };
  }

  if (req.mode === "sync_linkedin" && !req.xText?.trim()) throw new Error("revise_draft: there is no X text to write LinkedIn from");
  if (req.mode === "sync_x" && !req.linkedinText?.trim()) throw new Error("revise_draft: there is no LinkedIn text to write X from");

  await report({ kind: "edit", mode: req.mode, phase: "rewriting" });
  const prompt = editPrompt({ ...req, mode: req.mode });
  const present = { x: Boolean(req.xText?.trim()), linkedin: Boolean(req.linkedinText?.trim()) };
  let fields: Fields;
  if (req.mode === "sync_linkedin") {
    fields = await deps.runClaudeJson({ prompt, system, schema: SYNC_LINKEDIN_SCHEMA, parse: parseSyncLinkedinResult });
  } else if (req.mode === "sync_x") {
    fields = await deps.runClaudeJson({ prompt, system, schema: SYNC_X_SCHEMA, parse: parseSyncXResult });
  } else if (req.mode === "voice") {
    fields = await deps.runClaudeJson({ prompt, system, schema: voiceSchema(present), parse: parseVoiceResult(present) });
  } else {
    fields = await deps.runClaudeJson({ prompt, system, schema: REVISE_SCHEMA, parse: parseReviseResult });
  }
  fields = cleanFields(fields, profile);

  // One Jev check per platform the reply changed, so the new version shows its score at once.
  const slopByPlatform: Partial<Record<Platform, JevVerdict>> = {};
  if (deps.checkSlop) {
    await report({ kind: "edit", mode: req.mode, phase: "checking" });
    for (const platform of ["x", "linkedin"] as const) {
      const text = fields[FIELD[platform]];
      if (!text) continue;
      try { slopByPlatform[platform] = await deps.checkSlop(text, platform); } catch { /* unscored, not failed */ }
    }
  }
  return { ...fields, slopByPlatform };
}

/** image_prompt: a draft's text (+ image specs, from the payload or else the fresh profile) -> one image-generation prompt. */
export async function handleImagePrompt(payload: unknown, deps: HandlerDeps): Promise<{ imagePrompt: unknown }> {
  const p = ImagePromptPayload.parse(payload);
  const profile = await deps.getProfile();
  const text = [p.xText, p.linkedinText].filter((part) => part && part.trim()).join("\n\n");
  // An explicitly-blank payload.imageSpecs is treated the same as absent — either way, fall back to the fresh profile's.
  const imageSpecs = p.imageSpecs?.trim() ? p.imageSpecs : profile.imageSpecs;

  return deps.runClaudeJson({
    prompt: buildImagePrompt({ text, imageSpecs }),
    system: systemPrompt(profile),
    schema: IMAGE_PROMPT_SCHEMA,
    parse: parseImagePromptResult,
  });
}

/** analyze_style: the owner's example posts + tone form -> a draft style guide. */
export async function handleAnalyzeStyle(payload: unknown, deps: HandlerDeps): Promise<{ styleGuide: unknown }> {
  const p = AnalyzeStylePayload.parse(payload);
  const profile = await deps.getProfile();
  return deps.runClaudeJson({
    prompt: styleGuidePrompt({
      examplesX: p.toneExamplesX,
      examplesLinkedin: p.toneExamplesLinkedin,
      toneForm: p.toneForm,
      inspiration: p.inspiration,
    }),
    system: systemPrompt(profile),
    schema: STYLE_GUIDE_SCHEMA,
    parse: parseStyleGuideResult,
  });
}

// ---------------------------------------------------------------------------
// Humanize — the Claude <-> Jev loop (owner, 2026-09-23: "aggiungi il loop
// anche qui tra jev e claude quando clicco humanize"), jev-judge's humanize()
// since 2026-09-27: jev-judge runs the rounds, Claude is its writer.
// ---------------------------------------------------------------------------

// At most HUMANIZE_MAX_ROUNDS (jev-judge's, 3) rewrites per Humanize: each is
// one `claude -p` call (~10-25 s) and one Jev check (~1 s).
export { HUMANIZE_MAX_ROUNDS };
export type { HumanizeRound };

export type HumanizeLoopOptions = {
  original: string;
  /** The platform Jev calibrates for: Write humanizes one platform's post at a time. */
  platform?: "x" | "linkedin";
  platformLabel?: string;
  system: string;
  maxChars: number;
};

/**
 * jev-judge's humanize() with Claude as the writer: Claude rewrites, Jev
 * scores the rewrite (through the web app, deps.checkSlop), and while Jev
 * still doesn't call it "human" Claude tries again from the original with
 * that score and Jev's rubric in hand, at most HUMANIZE_MAX_ROUNDS times.
 * Returns the best-scored rewrite (not necessarily the last) with every
 * round's score. Each phase is reported through `deps.reportProgress` so the
 * page can say which round it's on. Degrades rather than fails: without
 * `checkSlop`, or when a check fails, it stops after that round; a rewrite
 * failing after round 1 keeps the best one so far. Only a first-round
 * rewrite failure fails the job.
 */
export async function humanizeLoop(
  opts: HumanizeLoopOptions,
  deps: HandlerDeps,
): Promise<{ text: string; rounds: HumanizeRound[]; slop: JevVerdict | null }> {
  const { checkSlop, reportProgress } = deps;
  const out = await humanize({
    original: opts.original,
    rewrite: async ({ previous }) => (await deps.runClaudeJson({
      prompt: humanizePrompt({ original: opts.original, previous, maxChars: opts.maxChars, platformLabel: opts.platformLabel }),
      system: opts.system,
      schema: humanizeSchema(opts.maxChars),
      parse: parseHumanizeResult(opts.maxChars),
    })).text,
    score: checkSlop ? (text) => checkSlop(text, opts.platform) : undefined,
    maxRounds: HUMANIZE_MAX_ROUNDS,
    // The shape web's lib/humanize-progress.ts reads.
    onStep: reportProgress
      ? ({ round, maxRounds, phase, rounds }) => reportProgress({ kind: "humanize", platform: opts.platform ?? null, round, maxRounds, phase, rounds })
      : undefined,
  });
  return { text: out.text, rounds: out.rounds, slop: out.score };
}

// ---------------------------------------------------------------------------
// Learning from the owner's choices (2026-09-27): web reads what they keep and
// drop with jev-judge (lib/style-learning.ts); Claude turns it into a change
// to the style guide, which waits for the owner's Apply in Settings › Voice.
// ---------------------------------------------------------------------------

const LearnStylePayload = z.object({
  guide: z.string().max(20000).nullish(),
  lessons: z.array(z.object({
    trait: z.string(),
    value: z.string(),
    direction: z.enum(["more", "less"]),
    lift: z.number(),
    text: z.string().min(1).max(300),
  })).min(1, "learn_style needs a lesson").max(10),
  edits: z.array(z.string().max(300)).max(20).nullish(),
  examples: z.array(z.string().max(2000)).max(5).nullish(),
});

/** learn_style: the lessons from the owner's choices, their edit requests and a few posts they kept -> Claude's update to the style guide, a reason per change. */
export async function handleLearnStyle(payload: unknown, deps: HandlerDeps): Promise<Record<string, unknown>> {
  const p = LearnStylePayload.parse(payload);
  return deps.runClaudeJson({
    prompt: guideUpdatePrompt({ guide: p.guide ?? "", lessons: p.lessons, edits: p.edits ?? undefined, examples: p.examples ?? undefined }),
    system: styleEditorSystemPrompt(),
    schema: GUIDE_UPDATE_SCHEMA,
    parse: parseGuideUpdate,
  });
}

// ---------------------------------------------------------------------------
// Posts from a repo (2026-10-10): a folder on this computer or a public GitHub
// repository, read by Claude Code in place with read tools only.
// ---------------------------------------------------------------------------

const RepoPostsPayload = z.object({
  ideaId: z.string().min(1, "repo_posts needs an ideaId"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("folder"), path: z.string().trim().min(1, "repo_posts needs a folder path") }),
    z.object({ type: z.literal("github"), url: z.string().trim().min(1, "repo_posts needs a GitHub link") }),
  ]),
  brief: z.string().max(2000).nullish(),
  format: z.enum(["x", "linkedin", "article"]),
  count: z.number().int().min(1).max(6),
  // Posts already written from this source (web's api/repos), so this ask finds other angles.
  previous: z.array(z.string().max(1000)).max(30).nullish(),
});

async function reportRepoPosts(deps: HandlerDeps, phase: "fetching" | "reading" | "writing"): Promise<void> {
  if (!deps.reportProgress) return;
  try { await deps.reportProgress({ kind: "repo_posts", phase }); } catch { /* a courtesy to the page */ }
}

/**
 * repo_posts: the source, resolved to a directory (a GitHub repository is
 * cloned or updated first, "fetching"), then one Claude Code run inside it
 * that explores with Read, Glob and Grep ("reading") and writes the posts
 * ("writing"). Reading and writing are that one call, which says nothing
 * until it ends, so both are reported as it starts: the page ticks reading
 * and waits on writing.
 */
export async function handleRepoPosts(
  payload: unknown,
  deps: HandlerDeps,
): Promise<{ posts: Array<{ text: string; title?: string }>; repoName: string }> {
  const p = RepoPostsPayload.parse(payload);
  if (!deps.resolveRepo) throw new Error("repo_posts: this agent can't read repositories");
  if (p.source.type === "github") await reportRepoPosts(deps, "fetching");
  const repo = await deps.resolveRepo(p.source);
  const profile = await deps.getProfile();
  await reportRepoPosts(deps, "reading");
  await reportRepoPosts(deps, "writing");
  const { posts } = await deps.runClaudeJson({
    prompt: repoPostsPrompt({ repoName: repo.name, brief: p.brief ?? "", format: p.format, count: p.count, previous: p.previous ?? undefined }),
    system: systemPrompt(profile),
    schema: REPO_SCHEMAS[p.format],
    parse: parseRepoPosts(p.format),
    cwd: repo.dir,
    readOnlyTools: true,
  });
  const clean = hashtagsAllowed(profile) ? posts : posts.map((post) => ({ ...post, text: stripHashtagLines(post.text) }));
  return { posts: clean.slice(0, p.count), repoName: repo.name };
}

/** pick_folder: the OS folder picker on this computer -> { path } or { cancelled: true }. */
export async function handlePickFolder(_payload: unknown, deps: HandlerDeps): Promise<PickFolderResult> {
  if (!deps.pickFolder) throw new Error("No folder picker on this computer: type the path instead.");
  return deps.pickFolder();
}

type Handler = (payload: unknown, deps: HandlerDeps) => Promise<Record<string, unknown>>;

/** Every kind this agent serves (see spec §2.2 and the plan's Part B preamble), mapped to its handler. */
export const HANDLERS: Record<string, Handler> = {
  generate_from_video: handleGenerateFromVideo,
  generate_from_idea: handleGenerateFromIdea,
  revise_draft: handleReviseDraft,
  image_prompt: handleImagePrompt,
  analyze_style: handleAnalyzeStyle,
  video_ideas: handleVideoIdeas,
  learn_style: handleLearnStyle,
  repo_posts: handleRepoPosts,
  pick_folder: handlePickFolder,
};

export const SERVED_KINDS = Object.keys(HANDLERS);

/**
 * Runs the handler matching `job.kind` and always resolves (never rejects)
 * to a JobOutcome ready for postResult — any thrown error (a validation
 * failure, TranscriptUnavailable, a ClaudeRunError/ClaudeTimeoutError, a
 * network error) becomes `{ ok: false, error: message }` with the error's
 * own message verbatim (e.g. TranscriptUnavailable's "transcript
 * unavailable — paste it in the app", unchanged).
 */
export async function runHandler(job: Job, deps: HandlerDeps): Promise<JobOutcome> {
  const handler = HANDLERS[job.kind];
  if (!handler) {
    return { ok: false, error: `unknown job kind: ${job.kind}` };
  }
  try {
    const result = await handler(job.payload, deps);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
