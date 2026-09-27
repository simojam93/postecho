import { AI_STYLE_FINGERPRINTS } from "jev-judge";
import type { Profile } from "./postecho.js";

/**
 * Splits a raw tone-examples blob (one Settings textarea, per spec §4
 * "Tone-of-voice setup": "paste 5–15 of the owner's best posts") into
 * individual posts and returns the first `limit` non-empty ones.
 *
 * There's no established delimiter for "one post" within a single textarea
 * elsewhere in this codebase (Settings just stores the raw string — see
 * web/src/lib/settings.ts), so this picks the most natural convention for
 * someone pasting several posts into one box: a blank line between them.
 */
function firstNonEmptyBlocks(raw: string, limit: number): string[] {
  return raw
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .slice(0, limit);
}

const MAX_EXAMPLES_PER_PLATFORM = 3;

/**
 * The system prompt injected into every generation/revision/image/style
 * call: identity, style guide (if any), up to 3 best examples per platform,
 * and the hard rules (spec §2.2 / plan task B5). Safe on a completely empty
 * profile (fresh install, nothing configured yet) — every section beyond
 * the hard rules is conditional.
 */
export function systemPrompt(profile: Profile): string {
  const lines: string[] = ["You are the ghostwriter for one specific person's X and LinkedIn posts."];

  const handle = profile.identityHandle.trim().replace(/^@/, "");
  const identity = [profile.identityName.trim(), handle && `(@${handle})`].filter(Boolean).join(" ");
  if (identity) {
    lines.push(`You are writing as ${identity}.`);
  }

  if (profile.styleGuide.trim()) {
    lines.push("", "Style guide:", profile.styleGuide.trim());
  }

  const examplesX = firstNonEmptyBlocks(profile.toneExamplesX, MAX_EXAMPLES_PER_PLATFORM);
  if (examplesX.length > 0) {
    lines.push("", "Best X examples (match this voice; don't copy the content):");
    for (const example of examplesX) lines.push("---", example);
  }

  const examplesLinkedin = firstNonEmptyBlocks(profile.toneExamplesLinkedin, MAX_EXAMPLES_PER_PLATFORM);
  if (examplesLinkedin.length > 0) {
    lines.push("", "Best LinkedIn examples (match this voice; don't copy the content):");
    for (const example of examplesLinkedin) lines.push("---", example);
  }

  // The owner's reference material (Settings, 2026-09-24): facts to draw on, not a voice to copy.
  const references = (profile.references ?? []).filter((r) => r.text.trim());
  if (references.length > 0) {
    lines.push(
      "",
      "Reference material about the owner and their work (from their own files). Use it when it's relevant to the post, and never invent beyond it. " +
        "Keep private details, such as clients, figures or contacts, out of posts unless the post is about them.",
    );
    for (const r of references) lines.push(`--- ${r.name}`, r.text.trim());
  }

  const hashtagsAllowed = profile.toneForm?.hashtags === "yes";
  lines.push(
    "",
    "Hard rules:",
    "- X posts: at most 280 characters, no links in the body.",
    hashtagsAllowed ? "- Hashtags are fine on X when they fit naturally." : "- Never use hashtags.",
    "- LinkedIn posts: 600-1200 characters, with a strong, scroll-stopping first line.",
    "- Always write in first person.",
    "- Be concrete and specific: no filler, no generic platitudes, no corporate voice.",
    "- Respond with JSON only, matching the schema exactly — no prose, no markdown code fences, no explanation.",
  );

  return lines.join("\n");
}

/**
 * The two voices a post can have (Write's voice switch, M3.7; owner,
 * 2026-09-24: "puoi scrivere qualsiasi post in prima o terza persona in stile
 * reazione"). "mine": the owner's own text — Write's "+ New" — is theirs to
 * say in the first person. "reaction": live (2026-09-23) a "Show HN" by
 * another founder came back as "I built TeardownHQ" in the owner's voice;
 * someone else's work is something the owner reacts to, never theirs.
 */
export const OWN_TEXT_RULE =
  "The source is the owner's own text: their notes, idea or draft. Turn it into their own post, in their voice. " +
  "Their experience, facts and opinions in it are theirs to state in the first person; don't add claims the text doesn't support.";
export const REACTION_RULE =
  "The source was written by someone else. You are writing the owner's own reaction to it — what they noticed, agree or disagree with, or learned. " +
  "Never present the source's product, results or experience as the owner's: no \"I built\", \"my launch\", \"we shipped\" about it. Name or credit the source when it matters.";

export type Voice = "mine" | "reaction";

/**
 * How to write so it reads human — the rules that took the humanize loop from
 * 100 to "human" in three rounds (2026-09-23), in every generation and edit
 * too, since Jev now scores every reply (live 2026-09-24: chat replies without
 * them came back 2-5/10, "Old way… New way…" and all).
 */
export const HUMAN_WRITING_RULES = [
  "Write like one specific person, not a language model (an AI-writing detector scores every reply):",
  "- very different sentence lengths; a fragment is fine",
  '- no "not X, but Y" / "X, not Y" / "Old way… New way…" contrasts, nothing forced into threes, no em-dashes (—)',
  "- no hook clichés, no slogan and no neat moral or summary as the last line",
  "- plain, concrete words; a casual aside or a throwaway word is fine",
].join("\n");

/**
 * @tags on X (owner, 2026-09-24: "vorrei poter aver taggate persone o aziende
 * con il loro tag dentro X… in automatico mentre scrivi il post", and "I
 * don't want to pay for it"): from Claude's own knowledge, never the X API,
 * so only the handles it's sure of. Write turns every @handle into a link to
 * check it with one click, and finds the rest from a selected name. LinkedIn
 * gets names: tags there are picked in LinkedIn's own editor, so each name
 * worth tagging carries a note the owner acts on while scheduling there
 * (2026-09-25: "just add (to tag on LinkedIn) within the text created so that
 * I can do it live on LinkedIn while scheduling it").
 */
export const X_TAGS_RULE =
  "Tags on X: where the X text names a person, company or product with a public X account, write its @handle instead of the plain name, " +
  "but only when you are sure it is their real, current handle (an @handle the source gives is exact). When you're not sure, keep the name. " +
  "At most three tags, and never start the post with an @handle.";
export const LINKEDIN_TAG_NOTE = "(to tag on LinkedIn)";
export const LINKEDIN_NAMES_RULE =
  `On LinkedIn, write people and companies by their names, never as @handles, and right after the name of each person or company worth tagging add "${LINKEDIN_TAG_NOTE}", once per name: the owner tags them in LinkedIn's own editor while scheduling.`;
export const KEEP_TAGS_RULE = `Keep every @handle and every "${LINKEDIN_TAG_NOTE}" note exactly as written, unless the request is about it.`;

/**
 * How a video's posts read (owner, 2026-09-27: "li vorrei creare di modo che
 * sembrino scritti da me come se fossero idee mie senza fare link diretti al
 * video… se mi va le aggiungo io"): the owner's own ideas, sparked by the
 * video, never a report on it. True to both sides all the same: nothing
 * copied word for word, and none of the speaker's story or results handed
 * to the owner.
 */
export const VIDEO_AS_OWN_IDEAS_RULE =
  "Write each post as the owner's own idea: their view or insight on the subject, in their voice, as if it came from their own thinking. " +
  "Never mention or point to the video, the talk, its speaker or the interview: no \"in this video\", no \"he says\", no links (the owner adds a credit when they want one). " +
  "Use your own words, never sentences copied from the source. " +
  "Don't give the owner experiences they didn't have: the speaker's story, company and results are not the owner's, so no \"I built\" or \"when we raised\" about them; state facts and numbers as facts, and the point as the owner's view.";

export function voiceRule(voice: Voice): string {
  return voice === "mine" ? OWN_TEXT_RULE : REACTION_RULE;
}

export type GeneratePromptOptions = {
  sourceKind: "video" | "idea";
  sourceText: string;
  instructions?: string;
  count: number;
  /** A language to write in, by name (e.g. "Italian"). Ignored when keepSourceLanguage is set. */
  language?: string;
  /** Write in whatever language the source itself is in — web's "video's original language" toggle. */
  keepSourceLanguage?: boolean;
  /** An idea that is the owner's own text (Write's "+ New"), not someone else's post. */
  ownText?: boolean;
  /** A video's voice (Use on a YouTube card, 2026-09-24): someone else's talk is a reaction unless switched. */
  voice?: Voice;
  /** Also write each take's LinkedIn version. Off by default since 2026-09-24: LinkedIn is written on request in Write. */
  withLinkedin?: boolean;
  /** One topic of the video to write about (Use on a Videos topic, 2026-09-27): the rest of the transcript is context. */
  topic?: { title: string; summary: string } | null;
};

/** User prompt for generate_from_video / generate_from_idea — a fresh batch of candidate posts from one source. */
export function generatePrompt(opts: GeneratePromptOptions): string {
  const sourceLabel = opts.sourceKind === "video"
    ? "YouTube video transcript"
    : opts.ownText ? "the owner's own notes" : "idea";
  const lines = [
    `Source (${sourceLabel}):`,
    opts.sourceText,
    "",
    ...(opts.topic
      ? [`The posts are about one topic from it: “${opts.topic.title}”. ${opts.topic.summary.trim()}`, "Use what the source says about that topic; the rest is context.", ""]
      : []),
    opts.withLinkedin
      ? `Write ${opts.count} candidate post(s) based on the source above. Every candidate has BOTH an X version (xText, at most 280 characters) and a LinkedIn version (linkedinText, 600-1200 characters) making the same point in each platform's register.`
      : `Write ${opts.count} candidate X post(s) based on the source above (xText, at most 280 characters each), each from a different angle.`,
  ];
  if (opts.sourceKind === "idea") lines.push(opts.ownText ? OWN_TEXT_RULE : REACTION_RULE);
  else if (opts.voice) lines.push(voiceRule(opts.voice));
  lines.push(X_TAGS_RULE);
  if (opts.withLinkedin) lines.push(LINKEDIN_NAMES_RULE);

  if (opts.instructions?.trim()) {
    lines.push(`Instructions from the owner: ${opts.instructions.trim()}`);
  }
  if (opts.keepSourceLanguage) {
    lines.push("Write in the same language as the source above (the video's original language).");
  } else if (opts.language?.trim()) {
    lines.push(`Write in this language: ${opts.language.trim()}.`);
  }

  lines.push("", HUMAN_WRITING_RULES, "");
  lines.push(opts.withLinkedin
    ? 'Return a JSON object: { "drafts": [ { "xText": "...", "linkedinText": "..." } ] }.'
    : 'Return a JSON object: { "drafts": [ { "xText": "..." } ] }.');
  return lines.join("\n");
}

export type VideoPostsPromptOptions = {
  /** The video's title, when known. */
  title?: string | null;
  transcript: string;
  count: number;
  /** The language the posts are written in (web's toggle; English by default). */
  language?: string;
  /** Write them in the video's own language instead. */
  keepSourceLanguage?: boolean;
  /** YouTube had no transcript: the source is the video's description and chapters. */
  fromDescription?: boolean;
};

/**
 * User prompt for video_ideas (2026-09-27: "it should take all the script of
 * the video and create some post ideas… at least 6 best and 6 more"; topics
 * for a while; then "penso che semplicemente andrebbero creati già dei post X
 * pronti all'attacco senza titolo, 6+6 vanno bene", and "post stilosi e
 * interessanti che posso ricondividere con X"): the best X posts a whole
 * video sparks, each on a different idea, best first, ready as they are and
 * written as the owner's own ideas (VIDEO_AS_OWN_IDEAS_RULE). Use opens one
 * in Write's editor, without writing takes.
 */
export function videoPostsPrompt(o: VideoPostsPromptOptions): string {
  const what = o.fromDescription ? "description and chapters (the video has no transcript)" : "transcript";
  const lines = [
    `Source (YouTube video ${what}${o.title?.trim() ? `: “${o.title.trim()}”` : ""}):`,
    o.transcript,
    "",
    ...(o.fromDescription
      ? ["This is what the video's page says about it, not what was said in it: keep to what it states."]
      : []),
    `Read the whole ${o.fromDescription ? "description" : "transcript"} and write the ${o.count} best X posts the owner could publish, each built on a different idea from it: never two about the same one.`,
    "Each post is ready to publish as it is: at most 280 characters, one idea, with the detail that makes it worth reading (a number, an example, a sharp observation).",
    "Make each one worth reposting: a first line that makes people stop, a clear point of view, nothing generic. Vary the shape across them: a bold claim with its reason, a short list, a counterintuitive observation, a practical tip, a question worth answering.",
    "Order them best first: the ones people on X would care about most come first.",
    VIDEO_AS_OWN_IDEAS_RULE,
    X_TAGS_RULE,
    "Never invent numbers, names or claims the source doesn't support.",
    o.keepSourceLanguage
      ? "Write the posts in the video's own language."
      : `Write the posts in ${o.language?.trim() || "English"}.`,
    "",
    HUMAN_WRITING_RULES,
    "",
    'Return a JSON object: { "drafts": [ { "xText": "..." } ] }.',
  ];
  return lines.join("\n");
}

export type RevisePromptOptions = {
  xText?: string;
  linkedinText?: string;
  instruction: string;
};

/** User prompt for revise_draft — rewrite whichever platform field(s) the draft actually has. */
export function revisePrompt(opts: RevisePromptOptions): string {
  const lines = ["Current draft:"];
  if (opts.xText) lines.push(`X: ${opts.xText}`);
  if (opts.linkedinText) lines.push(`LinkedIn: ${opts.linkedinText}`);
  lines.push(
    "",
    `Revise it per this instruction: ${opts.instruction}`,
    "",
    "Only revise the platform field(s) shown above — don't invent a platform that wasn't there.",
    'Return a JSON object: { "xText": "...", "linkedinText": "..." } — include only the field(s) you revised.',
  );
  return lines.join("\n");
}

export type ImagePromptOptions = {
  text: string;
  imageSpecs?: string;
};

/** User prompt for image_prompt — one image-generation prompt for a post. */
export function imagePrompt(opts: ImagePromptOptions): string {
  const lines = ["Post text:", opts.text];
  if (opts.imageSpecs?.trim()) {
    lines.push("", `Owner's image style/specs: ${opts.imageSpecs.trim()}`);
  }
  lines.push(
    "",
    "Write one image-generation prompt (for a tool like nano banana / a text-to-image model) that visually complements this post.",
    'Return a JSON object: { "imagePrompt": "..." }.',
  );
  return lines.join("\n");
}

export type StyleGuidePromptOptions = {
  examplesX: string;
  examplesLinkedin: string;
  toneForm: Record<string, unknown>;
  /** Posts by other people the owner admires (Settings' style inspiration): structure to borrow, never voice. */
  inspiration?: string[];
};

/** User prompt for analyze_style — draft a compact style guide from the owner's examples + form answers. */
export function styleGuidePrompt(opts: StyleGuidePromptOptions): string {
  const own = Boolean(opts.examplesX.trim() || opts.examplesLinkedin.trim());
  const lines = ["Draft a compact style guide (markdown, a few short sections) from these examples and form answers."];
  if (opts.examplesX.trim()) lines.push("", "X examples:", opts.examplesX.trim());
  if (opts.examplesLinkedin.trim()) lines.push("", "LinkedIn examples:", opts.examplesLinkedin.trim());
  if (Object.keys(opts.toneForm ?? {}).length > 0) {
    lines.push("", "Style form answers:", JSON.stringify(opts.toneForm));
  }
  const inspiration = (opts.inspiration ?? []).filter((p) => p.trim());
  if (inspiration.length > 0) {
    // Style inspiration (2026-09-24): posts by other people the owner admires.
    lines.push(
      "",
      "Posts by other people the owner admires (style inspiration). Borrow their structural moves: how they open, their pacing and line breaks, how they build a point. " +
        "Never copy their wording, opinions or facts, and don't make the owner sound like them.",
    );
    inspiration.forEach((post, i) => lines.push(`--- inspiration ${i + 1}`, post.trim()));
    if (!own) {
      lines.push("", "There are no examples of the owner's own posts yet: base the voice on the form answers and keep it plain; take only structure from the posts above.");
    }
  }
  lines.push("", 'Return a JSON object: { "styleGuide": "..." }.');
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Humanize (M3.6) — the Claude <-> Jev loop (handlers.ts's humanizeLoop)
// ---------------------------------------------------------------------------

/**
 * What Jev's AI-style check scores: jev-judge's own words for its checkSlop
 * rubric, so Claude knows exactly what the number it gets back measures.
 */
export const JEV_FINGERPRINTS = AI_STYLE_FINGERPRINTS;

export type JevVerdict = { slopScore: number; verdict: string };

export type HumanizePromptOptions = {
  original: string;
  /** From round 2 on: the last rewrite and Jev's verdict on it. */
  previous?: ({ text: string } & JevVerdict) | null;
  maxChars: number;
  /** "X" / "LinkedIn": the platform whose post it is (Write humanizes one at a time); unset reads "text". */
  platformLabel?: string;
};

/** One humanize round: the original, Jev's feedback so far, and how to rewrite. */
export function humanizePrompt(o: HumanizePromptOptions): string {
  const what = o.platformLabel ? `${o.platformLabel} post` : "text";
  const lines = [`Original ${what}:`, "<<<", o.original, ">>>", ""];
  if (o.previous) {
    lines.push(
      "Your previous rewrite:",
      "<<<",
      o.previous.text,
      ">>>",
      "",
      `An AI-writing detector (Jev) still rates that rewrite ${o.previous.slopScore}/100 for LLM style (${o.previous.verdict}); below 35 reads human.`,
      `Jev looks for: ${JEV_FINGERPRINTS}.`,
      `Rewrite the original ${what} again and go much further than last time: looser, more uneven, every list and contrast broken up. Cutting a secondary point is fine.`,
    );
  } else {
    lines.push(`Jev looks for: ${JEV_FINGERPRINTS}.`, `Rewrite the ${what} so it reads like one specific person wrote it.`);
  }
  lines.push(
    "",
    "How to make it read human (this is exactly what Jev checks):",
    "- Break the parallelism. Never put three items, or three short sentences, in a row; if the original lists three things, keep the one that matters or fold them into one plain sentence.",
    '- No "X, not Y" / "not X, but Y" / "it\'s not X, it\'s Y" in any form. No em-dashes (—) or dash asides.',
    "- Let it be loose: very different sentence lengths, a fragment, contractions, a throwaway word or two (honestly, kind of, I mean, anyway), a small aside in parentheses. Not every sentence has to earn its place.",
    '- No hook line ("Here\'s the thing", "The result?"), no slogan, no moral, no neat summarizing last line: end on a plain, even slightly unfinished thought.',
    "- Plain everyday words; no buzzwords (delve, leverage, seamless, game-changer, unlock, elevate, landscape, journey, compounding).",
    "- Don't invent facts or typos.",
    "",
    `Keep: the language it is written in, the facts, numbers and names that matter, every @handle and every "${LINKEDIN_TAG_NOTE}" note exactly as written, the point, the person (I / we / they) and roughly the same length.`,
    "Drop: the original's structure, rhythm and slogans. Those are what reads as AI.",
    o.maxChars <= 280 ? "It must stay within 280 characters." : `At most ${o.maxChars} characters.`,
    "Don't add hashtags, emojis, links or a call to action that weren't there.",
    "Before answering, reread your rewrite and fix any sentence that still has one of those patterns.",
    'Return a JSON object: { "rewrite": "..." }.',
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Learning from the owner's choices (2026-09-27): the brief itself is
// jev-judge's guideUpdatePrompt; this is who reads it.
// ---------------------------------------------------------------------------

/**
 * learn_style's system prompt: the editor of the owner's style guide, not
 * the ghostwriter. The brief carries the guide and the evidence, so the
 * ghostwriter's examples, references and post rules would only be noise.
 */
export function styleEditorSystemPrompt(): string {
  return [
    "You keep one person's style guide for their X and LinkedIn posts up to date, from what they keep and what they drop.",
    "You change only what the evidence supports, in plain words, and you say why.",
    "Respond with JSON only, matching the schema exactly — no prose, no markdown code fences, no explanation.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Edit with Claude (M3.7) — Write's chat: one request, one new version
// ---------------------------------------------------------------------------

/** The source is context, not the post: long enough for the detail X had no room for, bounded for the prompt. */
const EDIT_SOURCE_MAX_CHARS = 8000;

export type EditMode = "custom" | "sync_linkedin" | "sync_x" | "voice";

export type EditPromptOptions = {
  mode: EditMode;
  xText?: string;
  linkedinText?: string;
  /** What the post was written from (the idea's full read, else its text), for facts and context. */
  sourceText?: string;
  voice: Voice;
  /** Earlier requests on this post, oldest first — so "no, less formal" means something. */
  history?: string[];
  instruction: string;
};

/** One chat request on the post: the source, the post as it is now, its voice, the conversation so far and the request. */
export function editPrompt(o: EditPromptOptions): string {
  const lines: string[] = [];
  if (o.sourceText?.trim()) {
    const source = o.sourceText.length > EDIT_SOURCE_MAX_CHARS ? `${o.sourceText.slice(0, EDIT_SOURCE_MAX_CHARS)} …` : o.sourceText;
    lines.push("Source the post was written from (for context and facts):", "<<<", source, ">>>", "");
  }
  lines.push("Current post:");
  if (o.xText) lines.push(`X: ${o.xText}`);
  if (o.linkedinText) lines.push(`LinkedIn: ${o.linkedinText}`);
  lines.push("", voiceRule(o.voice));
  const history = (o.history ?? []).filter((h) => h.trim());
  if (history.length > 0) {
    lines.push("", "Earlier requests on this post, oldest first:", ...history.map((h) => `- ${h}`));
  }
  lines.push("", HUMAN_WRITING_RULES, "");

  if (o.mode === "sync_linkedin") {
    lines.push(
      "The owner reworked the X post, and the LinkedIn version no longer matches it. Rewrite the LinkedIn post so it makes the same point as the X post, from the same angle and in the same voice.",
      "X leads: its claims, angle and tone win. Never contradict it, and don't bring back what it dropped.",
      "Use the source for the supporting facts and detail the X post had no room for.",
      "LinkedIn register: 600-1200 characters, with a strong, specific first line.",
      `${LINKEDIN_NAMES_RULE} The X post's @handles become the names they stand for, each with that note.`,
    );
    if (o.instruction.trim()) lines.push(`Also: ${o.instruction.trim()}`);
    lines.push('Return a JSON object: { "linkedinText": "..." }.');
  } else if (o.mode === "sync_x") {
    lines.push(
      "Write the X version of this LinkedIn post: the same point, from the same angle and in the same voice, at most 280 characters, no links.",
      "LinkedIn leads: keep its claims and never contradict it.",
      X_TAGS_RULE,
    );
    if (o.instruction.trim()) lines.push(`Also: ${o.instruction.trim()}`);
    lines.push('Return a JSON object: { "xText": "..." }.');
  } else if (o.mode === "voice") {
    lines.push(
      "Rewrite the post in the voice described above. Keep the point, the facts and roughly the same length; change only what the voice requires.",
      "Rewrite every platform shown above. X stays within 280 characters.",
      KEEP_TAGS_RULE,
      'Return a JSON object: { "xText": "...", "linkedinText": "..." } with every platform shown above.',
    );
  } else {
    lines.push(
      `Request: ${o.instruction.trim()}`,
      "",
      "Change what the request asks for and keep the rest. Only revise the platform field(s) shown above — don't invent a platform that wasn't there. X stays within 280 characters.",
      KEEP_TAGS_RULE,
      'Return a JSON object: { "xText": "...", "linkedinText": "..." } — include only the field(s) you changed.',
    );
  }
  return lines.join("\n");
}
