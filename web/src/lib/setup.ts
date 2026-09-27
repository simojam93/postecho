import type { db as Db } from "@/db";
import { connectionStatuses } from "@/lib/connections";
import { getSetting, setSetting } from "@/lib/settings";
import { sourceRows, type SourceRow } from "@/lib/sources/status";

/** The agent heartbeats every 60 s; three missed ones and it's presumed off (as Settings and Write say). */
export const AGENT_ONLINE_MS = 3 * 60_000;

/**
 * What the welcome's "What's connected" step shows (owner, 2026-09-26: "i
 * collegamenti con lo stato verde/rosso"), and Settings › AI tools too:
 * whether each piece is there, never a key's value. Keys stay on the server;
 * the welcome checks and explains, it doesn't ask for them.
 */
export type SetupStatus = {
  onboardedAt: string | null;
  topics: string[];
  /** Claude on the owner's Mac, through the PostEcho agent. */
  agent: {
    /** The agent heartbeated within the last three minutes. */
    online: boolean;
    lastHeartbeatAt: string | null;
  };
  /** Jev's key is there — pasted in the app, or TYPESAFE_API_KEY on the server: Jev ranks, scores and picks. */
  jev: boolean;
  /** The sources that need a key, each with the env names it needs. */
  keyedSources: SourceRow[];
  /** The ones that need nothing, by label. */
  keylessSources: string[];
};

export async function loadSetupStatus(db: typeof Db, now: Date = new Date()): Promise<SetupStatus> {
  const [onboardedAt, topics, heartbeat, sources, connections] = await Promise.all([
    getSetting(db as never, "onboardedAt"),
    getSetting(db as never, "topics"),
    getSetting(db as never, "agentLastHeartbeatAt"),
    sourceRows(db),
    connectionStatuses(db),
  ]);
  return {
    onboardedAt,
    topics,
    agent: {
      online: heartbeat !== null && now.getTime() - new Date(heartbeat).getTime() <= AGENT_ONLINE_MS,
      lastHeartbeatAt: heartbeat,
    },
    jev: connections.jev.connected,
    keyedSources: sources.filter((s) => s.keyedBy !== "none"),
    keylessSources: sources.filter((s) => s.keyedBy === "none").map((s) => s.label),
  };
}

/**
 * First-time things (components/onboarding/tab-hints.tsx): Find Ideas' + More
 * sources glows once; the cog shows the Settings tour once; the Videos tab
 * explains itself once. Write's and Calendar's pills went on 2026-09-27
 * ("non aggiunge nulla").
 */
export const HINT_IDS = ["sources", "settings", "videos"] as const;
export type HintId = (typeof HINT_IDS)[number];

export function isHintId(value: unknown): value is HintId {
  return typeof value === "string" && (HINT_IDS as readonly string[]).includes(value);
}

/** The hints the owner closed, as the layout hands them to the tabs. */
export async function seenHints(db: typeof Db): Promise<HintId[]> {
  return (await getSetting(db as never, "seenHints")).filter(isHintId);
}

/** A tab's hint closed: it doesn't come back (until the welcome is shown again). */
export async function markHintSeen(db: typeof Db, id: HintId): Promise<HintId[]> {
  const seen = await seenHints(db);
  if (seen.includes(id)) return seen;
  const next = [...seen, id];
  await setSetting(db as never, "seenHints", next);
  return next;
}

/** The welcome shown again: the tabs' hints come back with it. */
export async function resetHints(db: typeof Db): Promise<void> {
  await setSetting(db as never, "seenHints", []);
}

/** The welcome was finished or closed: it doesn't come back by itself. Keeps the first time; returns it. */
export async function markOnboarded(db: typeof Db, now: Date = new Date()): Promise<string> {
  const current = await getSetting(db as never, "onboardedAt");
  if (current) return current;
  const at = now.toISOString();
  await setSetting(db as never, "onboardedAt", at);
  return at;
}
