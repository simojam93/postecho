import { checkSlop, createJevClient, type JevClient } from "jev-judge";
import type { db as Db } from "@/db";
import { openSecret, sealSecret } from "@/lib/secret-box";
import { getSetting, setSetting } from "@/lib/settings";
import { createBlueskySession } from "@/lib/sources/bluesky";
import type { Fetcher } from "@/lib/sources/types";

/**
 * Connections the owner makes in the app (2026-09-26: "tutte le connessioni
 * le vorrei rendere semplicissime per gli utenti"): paste a key in Settings or
 * the welcome, PostEcho tests it right away, and keeps it sealed on the server
 * (kv appKeys, lib/secret-box.ts). A key pasted here wins over the same env var
 * in the deployment, as X's key does (lib/x-config.ts); the env var still
 * works for anyone who prefers it. Values never go back to the browser.
 */
export const SERVICES = {
  jev: { env: ["TYPESAFE_API_KEY"] },
  bluesky: { env: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"] },
  youtube: { env: ["YOUTUBE_API_KEY"] },
  producthunt: { env: ["PRODUCTHUNT_TOKEN"] },
} as const satisfies Record<string, { env: readonly string[] }>;

export type ServiceId = keyof typeof SERVICES;
export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];
export type ServiceValues = Record<string, string>;

export type ConnectionStatus = {
  connected: boolean;
  /** Where its key lives: pasted in the app, set on the server, or nowhere. */
  via: "app" | "server" | null;
  /** Enough to tell which key is in use: "…abcd", or Bluesky's handle. Null without one. */
  hint: string | null;
};

const TEST_TIMEOUT_MS = 8_000;

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === "string" && value in SERVICES;
}

/** The keys pasted in the app, opened. A key that no longer opens (a new SESSION_SECRET) is left out. */
export async function loadAppKeys(db: typeof Db): Promise<Record<string, string>> {
  const sealed = await getSetting(db as never, "appKeys");
  const open: Record<string, string> = {};
  for (const [name, value] of Object.entries(sealed ?? {})) {
    const plain = openSecret(value);
    if (plain) open[name] = plain;
  }
  return open;
}

/** The env with the app's keys on top: what the scout's sources and Jev read. */
export async function serviceEnv(db: typeof Db, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const keys = await loadAppKeys(db);
  return Object.keys(keys).length === 0 ? base : { ...base, ...keys };
}

function hintFor(service: ServiceId, values: Record<string, string | undefined>): string | null {
  if (service === "bluesky") return values.BLUESKY_IDENTIFIER ?? null;
  const key = values[SERVICES[service].env[0]];
  return key ? `…${key.slice(-4)}` : null;
}

export async function connectionStatuses(db: typeof Db, base: NodeJS.ProcessEnv = process.env): Promise<Record<ServiceId, ConnectionStatus>> {
  const keys = await loadAppKeys(db);
  const has = (source: Record<string, string | undefined>, names: readonly string[]) => names.every((n) => Boolean(source[n]?.trim()));
  return Object.fromEntries(SERVICE_IDS.map((id) => {
    const names = SERVICES[id].env;
    if (has(keys, names)) return [id, { connected: true, via: "app", hint: hintFor(id, keys) }];
    if (has(base, names)) return [id, { connected: true, via: "server", hint: hintFor(id, base) }];
    return [id, { connected: false, via: null, hint: null }];
  })) as Record<ServiceId, ConnectionStatus>;
}

/** Saves a service's keys, sealed, next to the others. */
export async function saveServiceKeys(db: typeof Db, service: ServiceId, values: ServiceValues): Promise<void> {
  const current = { ...(await getSetting(db as never, "appKeys")) };
  for (const name of SERVICES[service].env) current[name] = sealSecret(values[name]!.trim());
  await setSetting(db as never, "appKeys", current);
}

/** Takes a service's pasted keys out of the app (the env var, if any, applies again). */
export async function removeServiceKeys(db: typeof Db, service: ServiceId): Promise<void> {
  const current = { ...(await getSetting(db as never, "appKeys")) };
  for (const name of SERVICES[service].env) delete current[name];
  await setSetting(db as never, "appKeys", current);
}

/** Jev's key: the one pasted in the app, else the deployment's TYPESAFE_API_KEY. */
export async function jevApiKey(db: typeof Db): Promise<string | null> {
  const keys = await loadAppKeys(db);
  return keys.TYPESAFE_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim() || null;
}

/** A Jev client with whichever key is set, or null without one. */
export async function jevClient(db: typeof Db): Promise<JevClient | null> {
  const apiKey = await jevApiKey(db);
  return apiKey ? createJevClient({ apiKey }) : null;
}

export type TestDeps = { fetcher?: Fetcher; jev?: (apiKey: string) => JevClient };

/**
 * Tries a service's keys for real before they're saved: one small call each
 * — Jev scores a short sentence, Bluesky opens a session, YouTube and Product
 * Hunt run a one-result query. Null when it works, else what to fix, in plain
 * words (never the key).
 */
export async function testService(service: ServiceId, values: ServiceValues, deps: TestDeps = {}): Promise<string | null> {
  const fetcher = deps.fetcher ?? fetch;
  try {
    switch (service) {
      case "jev": {
        const client = (deps.jev ?? ((apiKey: string) => createJevClient({ apiKey, maxRetries: 0 })))(values.TYPESAFE_API_KEY!.trim());
        await checkSlop(client, { text: "Checking that PostEcho can reach Jev." });
        return null;
      }
      case "bluesky": {
        await createBlueskySession({ identifier: values.BLUESKY_IDENTIFIER!.trim(), appPassword: values.BLUESKY_APP_PASSWORD!.trim(), fetcher });
        return null;
      }
      case "youtube": {
        const url = `https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=1&q=test&key=${encodeURIComponent(values.YOUTUBE_API_KEY!.trim())}`;
        const res = await fetcher(url, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
        if (res.ok) return null;
        return res.status === 403
          ? "YouTube refused the key: check that the YouTube Data API v3 is enabled for its project."
          : "YouTube refused the key: check that you copied all of it.";
      }
      case "producthunt": {
        const res = await fetcher("https://api.producthunt.com/v2/api/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${values.PRODUCTHUNT_TOKEN!.trim()}` },
          body: JSON.stringify({ query: "{ posts(first: 1) { edges { node { id } } } }" }),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        return res.ok ? null : "Product Hunt refused the token: use the Developer Token from your application's page.";
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (service === "jev") return /401|403|unauthori[sz]ed|api key/i.test(message) ? "Jev refused the key: check that you copied all of it." : "Couldn't reach Jev. Try again in a moment.";
    if (service === "bluesky") return /40[01]/.test(message) ? "Bluesky refused them: use your handle and an app password, never your account password." : "Couldn't reach Bluesky. Try again in a moment.";
    return "Couldn't reach it. Try again in a moment.";
  }
}
