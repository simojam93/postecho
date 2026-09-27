import type { Fetcher, SourcePost } from "@/lib/sources/types";

const SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession";
const SEARCH_URL = "https://bsky.social/xrpc/app.bsky.feed.searchPosts";
/**
 * The two orderings searchPosts offers. Same query, same limit, one shared
 * session: `top` is the engagement-ranked slice and `latest` the
 * chronological one, and for anything but the most popular queries they
 * barely overlap — `latest` is where a post from an hour ago lives. `top`
 * stays first: it is the ordering this source used on its own.
 */
const SORTS = ["top", "latest"] as const;
const TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 25;
// Bluesky access JWTs outlive this by a good margin (per the AT Protocol
// docs) — 90 minutes just keeps one process from re-logging-in on every
// search while still refreshing well before any real expiry.
const SESSION_TTL_MS = 90 * 60 * 1000;
const DISABLED_WARNING = "bluesky: disabled — set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD";

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);
const defaultNow = () => Date.now();

export type BlueskyCredentials = { identifier: string; appPassword: string };
export type BlueskySession = { accessJwt: string; did: string; handle: string };

type BlueskyPost = {
  uri: string;
  author: { handle: string; displayName?: string };
  record: { text?: string; createdAt?: string };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
};

type BlueskySearchResponse = { posts?: BlueskyPost[] };

type CreateSessionResponse = { accessJwt?: string; did?: string; handle?: string };

/** Thrown by `createBlueskySession` on a non-2xx response. Carries the HTTP
 * status only — never the identifier/password or the response body, so it's
 * safe to log or surface without leaking credentials. */
export class BlueskySessionError extends Error {
  status: number;
  constructor(status: number) {
    super(`createBlueskySession: request failed with status ${status}`);
    this.name = "BlueskySessionError";
    this.status = status;
  }
}

// uri is `at://<did>/app.bsky.feed.post/<rkey>` — the record key is always
// the last path segment.
function rkeyFromUri(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

function toSourcePost(post: BlueskyPost): SourcePost | null {
  const handle = post.author?.handle;
  if (!post.uri || !handle) return null;
  return {
    id: post.uri,
    source: "bluesky",
    url: `https://bsky.app/profile/${handle}/post/${rkeyFromUri(post.uri)}`,
    text: post.record?.text ?? "",
    author: post.author.displayName || handle,
    metrics: { likes: post.likeCount, reposts: post.repostCount, replies: post.replyCount },
    createdAt: post.record?.createdAt ?? null,
  };
}

/** Reads BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD from the environment; null when either is unset. */
export function blueskyCredentialsFromEnv(): BlueskyCredentials | null {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !appPassword) return null;
  return { identifier, appPassword };
}

/**
 * Logs in with an App Password (bsky.app → Settings → Privacy and security →
 * App passwords — never the account password) to get a short-lived
 * `accessJwt` for authenticated search. Throws a `BlueskySessionError`
 * (status only, no credentials) on a non-2xx response so callers can tell an
 * auth failure from a network hiccup; `searchBluesky` below is what turns
 * that into the source's documented degrade-to-`[]` contract.
 */
export async function createBlueskySession(params: {
  identifier: string;
  appPassword: string;
  fetcher?: Fetcher;
}): Promise<BlueskySession> {
  const fetcher = params.fetcher ?? defaultFetcher;
  const res = await fetcher(SESSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: params.identifier, password: params.appPassword }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new BlueskySessionError(res.status);

  const data = JSON.parse(await res.text()) as CreateSessionResponse;
  if (!data.accessJwt || !data.did || !data.handle) {
    throw new Error("createBlueskySession: malformed response");
  }
  return { accessJwt: data.accessJwt, did: data.did, handle: data.handle };
}

// Module-level session cache — one Bluesky login shared by the whole
// process rather than one per search. `warnedDisabled` backs the
// once-per-process "disabled" warning. Both are reset between tests via
// `resetBlueskyStateForTests`.
let cachedSession: { session: BlueskySession; createdAt: number } | null = null;
let warnedDisabled = false;

/** Test-only: clears the session cache and the once-per-process warn flag so each test starts from a clean slate. */
export function resetBlueskyStateForTests(): void {
  cachedSession = null;
  warnedDisabled = false;
}

async function getSession(
  credentials: BlueskyCredentials,
  fetcher: Fetcher,
  now: number,
  forceNew: boolean,
): Promise<BlueskySession> {
  if (!forceNew && cachedSession && now - cachedSession.createdAt < SESSION_TTL_MS) {
    return cachedSession.session;
  }
  const session = await createBlueskySession({ ...credentials, fetcher });
  cachedSession = { session, createdAt: now };
  return session;
}

/**
 * Bluesky's authenticated post search — one of the two free, open sources
 * the M1.5 scout queries server-side (see
 * docs/specs/2026-09-19-postecho-design.md §11 item 2).
 * Unauthenticated `app.bsky.feed.searchPosts` returns 403 ("Request
 * forbidden by administrative rules") on both `public.api.bsky.app` and
 * `api.bsky.app` (verified 2026-09-21), so this logs in with an App
 * Password (see `createBlueskySession`) and searches `bsky.social` with a
 * Bearer token instead. The session is cached in-process for 90 minutes and
 * refreshed once on a 401 (an expired/revoked token) before giving up.
 *
 * The search runs TWICE per call, once per entry in `SORTS`, in parallel and
 * on ONE shared session (two searches, still a single login); the results
 * are merged, deduped by uri and capped at `limit`. A 401 on either pass
 * triggers a single shared refresh and that pass retries once. One pass
 * failing still returns the other's posts.
 *
 * With no BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD configured (env, or
 * `opts.credentials` for callers/tests), this is a deliberate opt-out: it
 * returns `[]` immediately without any fetch and warns once per process,
 * rather than failing the whole scout run. Any other failure (a non-ok
 * response even after the retry, a network error, malformed JSON) also
 * degrades to `[]` rather than throwing — same contract as before, and the
 * same as `searchHackerNews` — so a Bluesky outage never fails the whole
 * scout run; `searchAllSources` just gets fewer candidates (and reports
 * this source's status — see lib/sources/index.ts).
 */
export async function searchBluesky(
  query: string,
  opts: {
    fetcher?: Fetcher;
    limit?: number;
    credentials?: BlueskyCredentials;
    now?: () => number;
  } = {},
): Promise<SourcePost[]> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const now = opts.now ?? defaultNow;
  const credentials = opts.credentials ?? blueskyCredentialsFromEnv();

  if (!credentials) {
    if (!warnedDisabled) {
      console.warn(DISABLED_WARNING);
      warnedDisabled = true;
    }
    return [];
  }

  const searchOnce = (session: BlueskySession, sort: string) =>
    fetcher(`${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}&sort=${sort}`, {
      headers: { Authorization: `Bearer ${session.accessJwt}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  try {
    const session = await getSession(credentials, fetcher, now(), false);
    // ONE refresh shared by both passes: memoised so that even if both come
    // back 401 at the same moment they await the same new session instead of
    // logging in twice. Each pass still retries itself exactly once.
    let refreshing: Promise<BlueskySession> | null = null;
    const refreshSession = () => (refreshing ??= getSession(credentials, fetcher, now(), true));

    const settled = await Promise.allSettled(
      SORTS.map(async (sort) => {
        let res = await searchOnce(session, sort);
        if (res.status === 401) res = await searchOnce(await refreshSession(), sort);
        if (!res.ok) throw new Error(`sort=${sort} failed with status ${res.status}`);
        const data = JSON.parse(await res.text()) as BlueskySearchResponse;
        return (data.posts ?? []).map(toSourcePost).filter((p): p is SourcePost => p !== null);
      }),
    );

    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failures.length > 0) {
      // Exactly one warn whether one pass failed or both. `reason` is always
      // one of the Errors thrown just above (a status, never a body) or a
      // JSON.parse error — no credentials and no accessJwt can reach it.
      console.warn(
        `searchBluesky: ${failures.map((f) => String(f.reason instanceof Error ? f.reason.message : f.reason)).join("; ")}`,
      );
      if (failures.length === SORTS.length) return [];
    }

    // Dedupe on the AT-Protocol uri (`SourcePost.id`) — `url` is derived
    // from it, so the two are the same identity, and the same post routinely
    // appears in both orderings.
    const seen = new Set<string>();
    const posts: SourcePost[] = [];
    for (const post of settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []))) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      posts.push(post);
    }
    return posts.slice(0, limit);
  } catch (e) {
    console.warn("searchBluesky: request failed", e);
    return [];
  }
}
