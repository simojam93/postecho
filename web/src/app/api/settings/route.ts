import { z } from "zod";
import { db } from "@/db";
import { requireSession } from "@/lib/session";
import { FIND_KIND_IDS, normalizeOrder, type FindKindId } from "@/lib/find-kinds";
import { sealSecret } from "@/lib/secret-box";
import { getSetting, setSetting, SETTING_DEFAULTS, type SettingKey } from "@/lib/settings";
import { X_POSTS_PER_SEARCH } from "@/lib/sources/x";
import { kindCountsOf, loadRatedIdeas, loadTasteExamples } from "@/lib/taste";
import { keyHint, loadXConfig } from "@/lib/x-config";

const TIME_RE = /^\d{2}:\d{2}$/;

// `defaultSlots` is keyed by platform, but a caller may only send one
// platform's slots — a plain `z.record` over an enum key in zod v4 requires
// EVERY enum member to be present (it validates as a total map), which would
// wrongly 400 a payload that only updates `x`. `partialRecord` keeps the
// "only x/linkedin keys" restriction while allowing either (or neither) key.
const Body = z.object({
  identityName: z.string().max(100).optional(),
  identityHandle: z.string().max(50).optional(),
  identityAvatarUrl: z.union([z.url(), z.literal("")]).optional(),
  notificationEmail: z.union([z.email(), z.literal("")]).optional(),
  leadTimeMinutes: z.number().int().min(1).max(120).optional(),
  topics: z.array(z.string().min(1).max(80)).max(20).optional(),
  scoutMinScore: z.number().int().min(0).max(100).optional(),
  scoutResultsPerSource: z.number().int().min(1).max(10).optional(),
  scoutResultsTotal: z.number().int().min(5).max(50).optional(),
  scoutCandidatesPerSource: z.number().int().min(5).max(50).optional(),
  defaultSlots: z.partialRecord(z.enum(["x", "linkedin"]), z.array(z.string().regex(TIME_RE)).max(6)).optional(),
  toneExamplesX: z.string().max(20000).optional(),
  toneExamplesLinkedin: z.string().max(20000).optional(),
  toneForm: z.record(z.string(), z.unknown()).optional(),
  styleGuide: z.string().max(20000).optional(),
  imageSpecs: z.string().max(4000).optional(),
  // The owner's X API bearer token: sealed before it's stored, "" removes it.
  // Bearer tokens are URL-encoded base64 — letters, digits and % = + / . _ ~ -.
  xBearerToken: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9%=+/._~-]{20,600}$/, "that doesn't look like an X bearer token")]).optional(),
  xPostsPerSearch: z.number().int().min(X_POSTS_PER_SEARCH.min).max(X_POSTS_PER_SEARCH.max).optional(),
  // The sources the owner disconnected (adapter names), the whole list.
  disabledSources: z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(30).optional(),
  // What Find Ideas shows first (2026-09-26): all five kinds, each once, most wanted first.
  findOrder: z.array(z.enum(FIND_KIND_IDS as [FindKindId, ...FindKindId[]])).length(FIND_KIND_IDS.length)
    .refine((order) => new Set(order).size === order.length, { message: "each kind once" }).optional(),
  // The Claude model the Mac agent writes with (2026-09-26, Settings › AI tools).
  claudeModel: z.enum(["sonnet", "opus", "haiku"]).optional(),
}).strict();

// The library lists have their own routes (api/style-inspiration, api/references):
// they can run to hundreds of kilobytes, and pages poll this one. The X key
// never leaves the server: the response carries `x` (connected, hint) instead.
const LISTED_ELSEWHERE = new Set<SettingKey>([
  "styleInspiration", "references", "xBearerToken", "appKeys", "seenHints", "styleProposal", "styleLearnedAt", "styleLearnCheckedAt",
]);
const SETTING_KEYS = (Object.keys(SETTING_DEFAULTS) as SettingKey[]).filter((key) => !LISTED_ELSEWHERE.has(key));

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const entries = await Promise.all(
      SETTING_KEYS.map(async (key): Promise<[SettingKey, unknown]> => {
        const value = await getSetting(db, key);
        // A broken stored order still reaches the page as a valid one.
        return [key, key === "findOrder" ? normalizeOrder(value) : value];
      }),
    );
    // Computed, not stored: the same taste examples lib/scout-run.ts feeds to
    // judgePosts, surfaced as counts for the Settings hints, and Plan's votes per kind.
    const [taste, x, rated] = await Promise.all([loadTasteExamples(db), loadXConfig(db), loadRatedIdeas(db)]);
    return Response.json({
      settings: Object.fromEntries(entries),
      tasteCounts: { kept: taste.kept.length, skipped: taste.skipped.length, rated: rated.length },
      kindCounts: kindCountsOf(rated),
      x: { connected: x.token !== null, hint: keyHint(x.token) },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "validation failed", fields: z.flattenError(parsed.error).fieldErrors },
      { status: 400 },
    );
  }

  try {
    for (const [key, value] of Object.entries(parsed.data) as [SettingKey, unknown][]) {
      if (value === undefined) continue;
      const stored = key === "xBearerToken" && value !== "" ? sealSecret(value as string) : value;
      await setSetting(db, key, stored as never);
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
