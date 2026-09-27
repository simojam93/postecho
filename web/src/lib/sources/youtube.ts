import {
  ADAPTER_DEFAULT_LIMIT,
  ADAPTER_TIMEOUT_MS,
  clampText,
  dedupeByUrl,
  disabledResult,
  envReady,
  errorResult,
  type AdapterPost,
  type AdapterResult,
  type SourceAdapter,
} from "./adapter";
import type { Fetcher } from "./types";

const BASE_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const SOURCE_NAME = "youtube";
const MAX_LIMIT = 50;
const REQUIRED_ENV = ["YOUTUBE_API_KEY"];

type YoutubeSearchItem = {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string | null;
  };
};

type YoutubeSearchResponse = { items?: YoutubeSearchItem[] };
type YoutubeVideosResponse = { items?: Array<{ id?: unknown; snippet?: { description?: string } }> };

/**
 * The prose at the top of a video's full description: it stops where the
 * chapters start, and skips lines with a link, lines of hashtags and calls
 * to subscribe.
 */
export function readableDescription(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^\(?\d{1,2}:\d{2}/.test(t) || /^(chapters|timestamps)\b/i.test(t)) break;
    if (/https?:\/\/|www\./i.test(t) || /^(#\S+\s*)+$/.test(t) || /^subscribe\b/i.test(t)) continue;
    kept.push(t);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** A card's text from a video's title and the prose of its full description. */
export function youtubeCardText(title: string, prose: string): string {
  return clampText(`${title} — ${prose}`);
}

/**
 * The full descriptions of `ids` (owner, 2026-09-27: a card's "more" still
 * ended in "...", because search.list cuts every description at about 160
 * characters): one videos.list call, 1 quota unit for up to 50 videos. Best
 * effort: on any failure the cut descriptions stay.
 */
async function fullDescriptions(ids: string[], key: string, fetcher: Fetcher): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (ids.length === 0) return found;
  try {
    const url = `${VIDEOS_URL}?part=snippet&id=${ids.map(encodeURIComponent).join(",")}&key=${encodeURIComponent(key)}`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return found;
    const data = JSON.parse(await res.text()) as YoutubeVideosResponse;
    for (const item of data.items ?? []) {
      const prose = typeof item.id === "string" ? readableDescription(item.snippet?.description ?? "") : "";
      if (prose) found.set(item.id as string, prose);
    }
  } catch {
    // The cut descriptions from the search stay.
  }
  return found;
}

function toAdapterPost(item: YoutubeSearchItem, full?: string): AdapterPost | null {
  const videoId = item.id?.videoId;
  const title = item.snippet?.title;
  if (!videoId || !title) return null;
  const description = item.snippet?.description;
  const text = full ? youtubeCardText(title, full) : clampText(description ? `${title} — ${description}` : title);
  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    text,
    title,
    author: item.snippet?.channelTitle ?? null,
    metrics: {},
    createdAt: item.snippet?.publishedAt ?? null,
  };
}

async function search(
  query: string,
  opts: { fetcher: Fetcher; limit?: number; env?: NodeJS.ProcessEnv },
): Promise<AdapterResult> {
  const env = opts.env ?? process.env;
  if (!envReady({ requiredEnv: REQUIRED_ENV }, env)) return disabledResult({ requiredEnv: REQUIRED_ENV });

  const limit = Math.min(opts.limit ?? ADAPTER_DEFAULT_LIMIT, MAX_LIMIT);
  const url =
    `${BASE_URL}?part=snippet&type=video&q=${encodeURIComponent(query)}` +
    `&maxResults=${limit}&order=relevance&key=${encodeURIComponent(env.YOUTUBE_API_KEY!)}`;

  try {
    const res = await opts.fetcher(url, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return errorResult(SOURCE_NAME, `request failed with status ${res.status}`);

    const data = JSON.parse(await res.text()) as YoutubeSearchResponse;
    const items = data.items ?? [];
    const ids = [...new Set(items.map((item) => item.id?.videoId).filter((id): id is string => Boolean(id)))];
    const full = await fullDescriptions(ids, env.YOUTUBE_API_KEY!, opts.fetcher);
    const posts = dedupeByUrl(
      items.map((item) => toAdapterPost(item, full.get(item.id?.videoId ?? ""))).filter((p): p is AdapterPost => p !== null),
    );
    return { posts, status: "ok" };
  } catch (e) {
    return errorResult(SOURCE_NAME, "request failed", e);
  }
}

/**
 * YouTube Data API v3 video search. Requires `YOUTUBE_API_KEY` (a free
 * Google Cloud Console API key with the YouTube Data API v3 enabled —
 * quota is 10,000 units/day, and a search call costs 100 units); without
 * it this adapter is disabled and makes no request. A second call,
 * `videos.list` (1 unit), brings the results' full descriptions; it asks for
 * the snippet only, so `metrics` (view/like counts) stays empty.
 */
export const youtube: SourceAdapter = {
  name: "youtube",
  label: "YouTube",
  tag: "YT",
  requiredEnv: REQUIRED_ENV,
  search,
};

/** A YouTube video's id from its link (watch?v=, youtu.be/, /shorts/, /live/, /embed/); null for anything else. */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^(www\.|m\.)/, "");
  const id = host === "youtu.be"
    ? parsed.pathname.slice(1).split("/")[0]
    : host === "youtube.com" || host === "music.youtube.com"
      ? parsed.searchParams.get("v") ?? parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ?? null
      : null;
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** How much of a description goes to the Mac, at most. */
const DESCRIPTION_MAX_CHARS = 5000;

/**
 * A video's whole description with its chapters, links and hashtag lines
 * dropped: what the Videos tab's ideas come from when YouTube has no
 * transcript in any language (2026-09-27: "non esiste un fallback se manca
 * la trascrizione youtube senza farlo manualmente?"). One videos.list call, 1
 * quota unit. Null when there's no key, no such video, or no description.
 */
export async function videoDescriptionFor(url: string, key: string | undefined, fetcher: Fetcher): Promise<string | null> {
  const id = youtubeVideoId(url);
  if (!id || !key) return null;
  try {
    const res = await fetcher(`${VIDEOS_URL}?part=snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text()) as YoutubeVideosResponse;
    const raw = data.items?.[0]?.snippet?.description ?? "";
    const kept = raw.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !/https?:\/\/|www\./i.test(line) && !/^(#\S+\s*)+$/.test(line))
      .join("\n");
    return kept ? kept.slice(0, DESCRIPTION_MAX_CHARS) : null;
  } catch {
    return null;
  }
}
