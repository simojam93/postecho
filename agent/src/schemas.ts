import { z } from "zod";

/**
 * Numeric hard rules that are structural (don't depend on the owner's
 * profile) live here, encoded twice: once as JSON Schema (fed to `claude -p
 * --json-schema`, so the CLI's own structured-output validator enforces
 * them) and once as zod (this agent's own belt-and-suspenders check before
 * a result is ever posted back). Rules that DO depend on the profile — no
 * hashtags unless toneForm.hashtags === "yes", first person, tone, etc. —
 * are prompt-only instructions; see systemPrompt() in prompts.ts.
 */
const X_MAX_CHARS = 280;
const LINKEDIN_MIN_CHARS = 600;
const LINKEDIN_MAX_CHARS = 1200;
// A revision can legitimately be asked to go shorter/longer than the fresh-
// generation window ("make it punchier", "cut this to two lines") — only
// the platform's own ceiling (matching web's drafts.linkedinText storage
// cap) applies there, no floor.
const REVISE_LINKEDIN_MAX_CHARS = 4000;
const IMAGE_PROMPT_MAX_CHARS = 2000;
const STYLE_GUIDE_MAX_CHARS = 20000;

/** { drafts: [{ xText, linkedinText }] }, 1..25 items, each carrying BOTH platform texts. Used by generate_from_video and generate_from_idea. */
export const DRAFTS_SCHEMA = {
  type: "object",
  properties: {
    drafts: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          xText: { type: "string", maxLength: X_MAX_CHARS },
          linkedinText: { type: "string", minLength: LINKEDIN_MIN_CHARS, maxLength: LINKEDIN_MAX_CHARS },
        },
        // Both platforms in every take (owner, 2026-09-23: "fa solo X e non
        // LinkedIn?" — generation had been returning X-only takes).
        required: ["xText", "linkedinText"],
        additionalProperties: false,
      },
    },
  },
  required: ["drafts"],
  additionalProperties: false,
} as const;

const DraftItemResultSchema = z.object({
  xText: z.string().max(X_MAX_CHARS),
  linkedinText: z.string().min(LINKEDIN_MIN_CHARS).max(LINKEDIN_MAX_CHARS),
});

const DraftsResultSchema = z.object({
  drafts: z.array(DraftItemResultSchema).min(1).max(25),
});

export function parseDraftsResult(value: unknown) {
  return DraftsResultSchema.parse(value);
}

/**
 * { drafts: [{ xText }] } — X only, the default since 2026-09-24 (owner: "tutto
 * il discorso linkedin va messo come eventuale… farti vedere solo X"): a take
 * is an X post; its LinkedIn version is written on request in Write
 * (revise_draft sync_linkedin, from the X and the source). Faster too — the
 * LinkedIn texts were most of a generation's output.
 */
export const X_DRAFTS_SCHEMA = {
  type: "object",
  properties: {
    drafts: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        properties: { xText: { type: "string", maxLength: X_MAX_CHARS } },
        required: ["xText"],
        additionalProperties: false,
      },
    },
  },
  required: ["drafts"],
  additionalProperties: false,
} as const;

const XDraftsResultSchema = z.object({
  drafts: z.array(z.object({ xText: z.string().min(1).max(X_MAX_CHARS) })).min(1).max(25),
});

export function parseXDraftsResult(value: unknown): { drafts: Array<{ xText: string; linkedinText?: string }> } {
  return XDraftsResultSchema.parse(value);
}

/**
 * { xText?, linkedinText? } — used by revise_draft. No LinkedIn floor: a
 * revision may deliberately go shorter than a fresh draft would.
 *
 * No top-level `anyOf` here, on purpose: `claude -p --json-schema` hands the
 * schema to the API as a tool `input_schema`, and the API rejects `oneOf` /
 * `allOf` / `anyOf` AT THE TOP LEVEL ("input_schema does not support oneOf,
 * allOf, or anyOf at the top level" — hit live on 2026-09-22, every
 * revise_draft job failed in ~6s). Nested combinators are fine (see
 * DRAFTS_SCHEMA's per-item anyOf). The "at least one of the two" rule is
 * enforced by parseReviseResult's zod refine instead — a miss costs one
 * retry with the JSON reminder, not a hard API error.
 */
export const REVISE_SCHEMA = {
  type: "object",
  properties: {
    xText: { type: "string", maxLength: X_MAX_CHARS },
    linkedinText: { type: "string", maxLength: REVISE_LINKEDIN_MAX_CHARS },
  },
  additionalProperties: false,
} as const;

const ReviseResultSchema = z
  .object({
    xText: z.string().max(X_MAX_CHARS).optional(),
    linkedinText: z.string().max(REVISE_LINKEDIN_MAX_CHARS).optional(),
  })
  .refine((draft) => Boolean(draft.xText || draft.linkedinText), {
    message: "a revision needs an xText and/or a linkedinText",
  });

export function parseReviseResult(value: unknown) {
  return ReviseResultSchema.parse(value);
}

/** { imagePrompt } — used by image_prompt. */
export const IMAGE_PROMPT_SCHEMA = {
  type: "object",
  properties: {
    imagePrompt: { type: "string", minLength: 1, maxLength: IMAGE_PROMPT_MAX_CHARS },
  },
  required: ["imagePrompt"],
  additionalProperties: false,
} as const;

const ImagePromptResultSchema = z.object({
  imagePrompt: z.string().min(1).max(IMAGE_PROMPT_MAX_CHARS),
});

export function parseImagePromptResult(value: unknown) {
  return ImagePromptResultSchema.parse(value);
}

/** { styleGuide } — used by analyze_style. */
export const STYLE_GUIDE_SCHEMA = {
  type: "object",
  properties: {
    styleGuide: { type: "string", minLength: 1, maxLength: STYLE_GUIDE_MAX_CHARS },
  },
  required: ["styleGuide"],
  additionalProperties: false,
} as const;

const StyleGuideResultSchema = z.object({
  styleGuide: z.string().min(1).max(STYLE_GUIDE_MAX_CHARS),
});

export function parseStyleGuideResult(value: unknown) {
  return StyleGuideResultSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Humanize (M3.6): Write's revise_draft in humanize mode, jev-judge's
// Claude <-> Jev loop (handlers.ts's humanizeLoop).
// ---------------------------------------------------------------------------

/**
 * The per-call ceiling for a humanized rewrite, which keeps "roughly the same
 * length": an X post, or a text that would fit one, must still fit 280
 * characters; a longer LinkedIn post may grow by at most 40%, within the
 * revision's LinkedIn ceiling.
 */
export function humanizeMaxChars(original: string, platform: "x" | "linkedin"): number {
  if (platform === "x" || original.length <= X_MAX_CHARS) return X_MAX_CHARS;
  return Math.min(REVISE_LINKEDIN_MAX_CHARS, Math.ceil(original.length * 1.4));
}

/**
 * { rewrite } — one humanize round's rewrite. Built per call: the ceiling
 * depends on the original (humanizeMaxChars). Not `text`: live
 * (2026-09-23) Sonnet read a field called "text" as "the whole reply" and
 * put the JSON object itself into it.
 */
export function humanizeSchema(maxChars: number) {
  return {
    type: "object",
    properties: { rewrite: { type: "string", minLength: 1, maxLength: maxChars } },
    required: ["rewrite"],
    additionalProperties: false,
  };
}

/** A reply that nested the JSON inside the field anyway ("{\"rewrite\": \"…\"}") is unwrapped, once. */
function unwrapNestedJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const inner = JSON.parse(trimmed) as { rewrite?: unknown; text?: unknown } | null;
    const text = inner?.rewrite ?? inner?.text;
    return typeof text === "string" ? text : value;
  } catch {
    return value;
  }
}

export function parseHumanizeResult(maxChars: number): (value: unknown) => { text: string } {
  const schema = z.object({ rewrite: z.string().transform(unwrapNestedJson).pipe(z.string().trim().min(1).max(maxChars)) });
  return (value: unknown) => ({ text: schema.parse(value).rewrite });
}

// ---------------------------------------------------------------------------
// Edit with Claude (M3.7): Write's chat. Custom requests reuse REVISE_SCHEMA;
// syncing one platform from the other and switching the voice have their own.
// ---------------------------------------------------------------------------

/** { linkedinText } — LinkedIn rewritten from the X post (sync_linkedin): a fresh LinkedIn post, so the generation window applies. */
export const SYNC_LINKEDIN_SCHEMA = {
  type: "object",
  properties: { linkedinText: { type: "string", minLength: LINKEDIN_MIN_CHARS, maxLength: LINKEDIN_MAX_CHARS } },
  required: ["linkedinText"],
  additionalProperties: false,
} as const;

export function parseSyncLinkedinResult(value: unknown): { linkedinText: string } {
  return z.object({ linkedinText: z.string().min(LINKEDIN_MIN_CHARS).max(LINKEDIN_MAX_CHARS) }).parse(value);
}

/** { xText } — X rewritten from the LinkedIn post (sync_x). */
export const SYNC_X_SCHEMA = {
  type: "object",
  properties: { xText: { type: "string", minLength: 1, maxLength: X_MAX_CHARS } },
  required: ["xText"],
  additionalProperties: false,
} as const;

export function parseSyncXResult(value: unknown): { xText: string } {
  return z.object({ xText: z.string().min(1).max(X_MAX_CHARS) }).parse(value);
}

/** { xText, linkedinText } for a voice switch — every platform the post has, required. Built per call. */
export function voiceSchema(present: { x: boolean; linkedin: boolean }) {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  if (present.x) { properties.xText = { type: "string", minLength: 1, maxLength: X_MAX_CHARS }; required.push("xText"); }
  if (present.linkedin) { properties.linkedinText = { type: "string", minLength: 1, maxLength: REVISE_LINKEDIN_MAX_CHARS }; required.push("linkedinText"); }
  return { type: "object", properties, required, additionalProperties: false };
}

export function parseVoiceResult(present: { x: boolean; linkedin: boolean }): (value: unknown) => { xText?: string; linkedinText?: string } {
  const shape: Record<string, z.ZodString> = {};
  if (present.x) shape.xText = z.string().min(1).max(X_MAX_CHARS);
  if (present.linkedin) shape.linkedinText = z.string().min(1).max(REVISE_LINKEDIN_MAX_CHARS);
  // Exactly the platforms the post has: none missing, none invented.
  const schema = z.object(shape).strict();
  return (value: unknown) => schema.parse(value) as { xText?: string; linkedinText?: string };
}

// ---------------------------------------------------------------------------
// Posts from a repo (2026-10-10): { posts: [{ text, title? }] } in one format.
// The JSON Schema holds Claude to the format's window; the zod check keeps
// each item inside the wider limits the web stores and drops the rest, so one
// long post doesn't cost the whole run (none left is a failure, retried once).
// ---------------------------------------------------------------------------

const REPO_MAX_ITEMS = 6;
const ARTICLE_TITLE_MAX_CHARS = 100;
const ARTICLE_MAX_CHARS = 12000;

export const REPO_X_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      minItems: 1,
      maxItems: REPO_MAX_ITEMS,
      items: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: X_MAX_CHARS } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

export const REPO_LINKEDIN_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      minItems: 1,
      maxItems: REPO_MAX_ITEMS,
      items: {
        type: "object",
        properties: { text: { type: "string", minLength: LINKEDIN_MIN_CHARS, maxLength: LINKEDIN_MAX_CHARS } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

export const REPO_ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      minItems: 1,
      maxItems: REPO_MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: ARTICLE_TITLE_MAX_CHARS },
          text: { type: "string", minLength: 1, maxLength: ARTICLE_MAX_CHARS },
        },
        required: ["title", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

export type RepoFormat = "x" | "linkedin" | "article";
export type RepoPost = { text: string; title?: string };

export const REPO_SCHEMAS: Record<RepoFormat, object> = {
  x: REPO_X_SCHEMA,
  linkedin: REPO_LINKEDIN_SCHEMA,
  article: REPO_ARTICLE_SCHEMA,
};

const REPO_ITEMS: Record<RepoFormat, z.ZodType<RepoPost>> = {
  x: z.object({ text: z.string().trim().min(1).max(X_MAX_CHARS) }),
  // Up to the revision ceiling, what the web stores: a little over 1,200 isn't worth losing.
  linkedin: z.object({ text: z.string().trim().min(LINKEDIN_MIN_CHARS).max(REVISE_LINKEDIN_MAX_CHARS) }),
  article: z.object({
    title: z.string().trim().min(1).max(ARTICLE_TITLE_MAX_CHARS),
    text: z.string().trim().min(1).max(ARTICLE_MAX_CHARS),
  }),
};

export function parseRepoPosts(format: RepoFormat): (value: unknown) => { posts: RepoPost[] } {
  const item = REPO_ITEMS[format];
  return (value: unknown) => {
    const { posts } = z.object({ posts: z.array(z.unknown()) }).parse(value);
    const kept = posts.flatMap((p) => {
      const r = item.safeParse(p);
      return r.success ? [r.data] : [];
    });
    if (kept.length === 0) throw new Error(`repo_posts: no ${format} post within its limits`);
    return { posts: kept };
  };
}
