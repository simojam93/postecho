import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { kv } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { ReferenceItem, StyleInspirationItem } from "@/lib/library";
import type { StyleProposal } from "@/lib/style-learning";
import { DEFAULT_FIND_ORDER } from "@/lib/find-kinds";

export const SETTING_DEFAULTS = {
  identityName: "" as string,
  identityHandle: "" as string,
  identityAvatarUrl: "" as string,
  notificationEmail: "" as string,
  leadTimeMinutes: 5 as number,
  topics: [] as string[],
  // Minimum ✦ rank (jev-judge's combined 0..100 `rank` — the number shown on
  // the card) a scouted candidate needs to be saved at all (owner direction,
  // 2026-09-22): a HARD cutoff, not a display hint — anything under it is
  // never inserted, and the scout keeps searching (more rounds, bigger
  // limits) until each source has enough candidates at or above it. See
  // lib/scout-run.ts. Owner-tunable in Settings › Sources › Advanced.
  scoutMinScore: 60 as number,
  // How many strong (rank >= scoutMinScore) results a search should end up
  // with, best-first across ALL sources as one pool (owner direction,
  // 2026-09-22 — "if 8 are from HN, even better"): lib/scout-run.ts keeps
  // running collect→judge rounds until it has this many, then inserts the
  // global top-N by rank. Owner-tunable in Settings › Sources › Advanced.
  scoutResultsTotal: 20 as number,
  // Superseded by scoutResultsTotal (2026-09-22): no longer drives selection
  // and no longer shown in Settings, kept only so an existing kv row keeps
  // reading/writing cleanly through getSetting/setSetting and PUT /api/settings.
  scoutResultsPerSource: 5 as number,
  // Per source, how many candidates the query-variant expansion loop
  // accumulates (across up to 5 variant searches) before it stops fetching
  // more — see lib/scout-run.ts and lib/query.ts's queryVariants.
  scoutCandidatesPerSource: 12 as number,
  defaultSlots: { x: ["10:00", "17:00"], linkedin: ["09:00"] } as Record<string, string[]>,
  toneExamplesX: "" as string,
  toneExamplesLinkedin: "" as string,
  toneForm: {} as Record<string, unknown>,
  styleGuide: "" as string,
  // Style/format/avoid-list hint for the agent's image_prompt job (M2 agent+
  // generation, task A2/A7) — e.g. "16:9, minimalist, no text overlays,
  // avoid stock-photo people". Plain string like toneExamplesX/styleGuide,
  // capped at 4000 chars in the settings PUT whitelist (see api/settings/route.ts).
  imageSpecs: "" as string,
  agentLastHeartbeatAt: null as string | null,
  // The owner's library (2026-09-24), each with its own route (lib/library.ts):
  // posts by others whose style to learn from, and reference material Claude
  // may draw facts from. Not part of GET /api/settings — they can be large.
  styleInspiration: [] as StyleInspirationItem[],
  references: [] as ReferenceItem[],
  // When Analyze my posts last produced the style guide (materialize.ts).
  styleGuideAnalyzedAt: null as string | null,
  // X as a Find Ideas source (2026-09-24), with the owner's own API key:
  // stored sealed (lib/secret-box.ts, "" = none), never sent to the browser —
  // see lib/x-config.ts and api/settings. The budget is how many posts one
  // search may read from X, which bills per post (lib/sources/x.ts).
  xBearerToken: "" as string,
  xPostsPerSearch: 20 as number,
  // Sources the owner disconnected in Settings (2026-09-25: "give opportunity
  // to disconnect those if you want"): searches skip them, whatever keys the
  // server or the owner has for them. Adapter names (lib/sources/all.ts).
  disabledSources: [] as string[],
  // What Find Ideas shows first (owner, 2026-09-26: "vuoi rendere ordinabili l'importanza di
  // queste… così sono prioritizzate?"): the kinds of post of lib/find-kinds.ts, most wanted
  // first. Read through normalizeOrder, so a broken value still gives a valid order.
  findOrder: [...DEFAULT_FIND_ORDER] as string[],
  // The welcome (owner, 2026-09-26: "facciamo questa al primo ingresso"): when
  // it was finished or closed; null shows it after the next login. Set by POST
  // /api/setup, never by Save settings.
  onboardedAt: null as string | null,
  // The one-line hints a tab shows on its first visit (2026-09-27: after the
  // welcome, "la parte di write e plan però si perdono vero?"): the ones the
  // owner closed. The welcome, shown again, clears it. Set by POST /api/setup.
  seenHints: [] as string[],
  // Keys the owner pasted in the app (2026-09-26: "tutte le connessioni le
  // vorrei rendere semplicissime per gli utenti"): env var name → sealed value
  // (lib/secret-box.ts), for Jev, Bluesky, YouTube and Product Hunt. They win
  // over the deployment's env, as X's key does. Never sent to the browser.
  appKeys: {} as Record<string, string>,
  // The Claude model the Mac agent writes with (Settings › AI tools): an alias
  // Claude Code knows — "sonnet" (default), "opus" or "haiku". The agent reads
  // it from its heartbeat.
  claudeModel: "sonnet" as string,
  // Learning from the owner's choices (2026-09-27, lib/style-learning.ts): the
  // style guide change Claude proposed from them, waiting in Settings › Voice
  // until it's applied or dismissed (null: none); when PostEcho last looked at
  // the choices; and when the agent's heartbeat last asked whether to (at most
  // daily). Not part of GET /api/settings: GET /api/style-learning.
  styleProposal: null as StyleProposal | null,
  styleLearnedAt: null as string | null,
  styleLearnCheckedAt: null as string | null,
};


export type SettingKey = keyof typeof SETTING_DEFAULTS;

/**
 * Structural type satisfied by both the production db (neon-http) and the
 * PGlite test db: both are concrete subclasses of drizzle's `PgDatabase`,
 * differing only in their `PgQueryResultHKT` driver parameter, which doesn't
 * affect the `select`/`insert` chains used here. Using the shared base class
 * (rather than a hand-rolled Pick or a union) keeps this in sync with
 * whatever either driver's concrete type actually exposes.
 */
type SettingsDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function getSetting<K extends SettingKey>(
  db: SettingsDb,
  key: K,
): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const rows = await db.select().from(kv).where(eq(kv.key, key));
  if (rows.length === 0) return structuredClone(SETTING_DEFAULTS[key]);
  return rows[0].value as (typeof SETTING_DEFAULTS)[K];
}

export async function setSetting<K extends SettingKey>(
  db: SettingsDb,
  key: K,
  value: (typeof SETTING_DEFAULTS)[K],
): Promise<void> {
  const jsonValue = value === null ? sql`'null'::jsonb` : value;
  await db
    .insert(kv)
    .values({ key, value: jsonValue })
    .onConflictDoUpdate({ target: kv.key, set: { value: jsonValue } });
}
