import { YoutubeTranscript } from "youtube-transcript";

/** Prompt-size budget for a transcript, whether fetched here or pasted manually (see handlers.ts, which runs a manually-supplied payload.transcript through normalizeTranscript too, for the same cap). */
export const TRANSCRIPT_CHAR_CAP = 60_000;

const DEFAULT_LANGS = ["en", "it"];

/**
 * Thrown when a transcript could not be fetched in any configured
 * language. The message is user-facing verbatim (surfaced to the owner via
 * the job's `failed` result) — never a proxy/IP/cookie retry, ever; see
 * spec §6.1 and the plan's Part B preamble.
 */
export class TranscriptUnavailable extends Error {
  constructor(message = "transcript unavailable — paste it in the app") {
    super(message);
    this.name = "TranscriptUnavailable";
  }
}

export type NormalizedTranscript = { text: string; truncated: boolean };

/**
 * Collapses all whitespace runs to single spaces, trims, and caps at
 * TRANSCRIPT_CHAR_CAP chars. Exported (not just used internally by
 * fetchTranscript) so handlers.ts can run a manually-pasted
 * `payload.transcript` through the exact same limit.
 */
export function normalizeTranscript(raw: string): NormalizedTranscript {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= TRANSCRIPT_CHAR_CAP) return { text, truncated: false };
  return { text: text.slice(0, TRANSCRIPT_CHAR_CAP), truncated: true };
}

export type FetchTranscriptOptions = { langs?: string[] };

/**
 * Fetches a YouTube transcript, trying each language in `opts.langs`
 * (default ["en", "it"]) in order until one yields segments, then whatever
 * track the video has — its auto-generated captions in the language spoken,
 * say (2026-09-27: "non esiste un fallback se manca la trascrizione?"). Any
 * failure (an error, or an empty result) moves on; if nothing yields,
 * throws TranscriptUnavailable — never retried via proxies, IP rotation, or
 * cookie tricks.
 */
export async function fetchTranscript(
  videoUrl: string,
  opts: FetchTranscriptOptions = {},
): Promise<NormalizedTranscript & { lang: string | null }> {
  const langs = opts.langs && opts.langs.length > 0 ? opts.langs : DEFAULT_LANGS;

  // undefined last: the video's own default track, in any language.
  for (const lang of [...langs, undefined]) {
    let segments: Array<{ text: string }> | undefined;
    try {
      segments = await YoutubeTranscript.fetchTranscript(videoUrl, lang ? { lang } : undefined);
    } catch {
      continue;
    }
    if (segments && segments.length > 0) {
      // Which track it was, so the page can say it ("Extracted the script in English").
      return { ...normalizeTranscript(segments.map((segment) => segment.text).join(" ")), lang: lang ?? null };
    }
  }

  throw new TranscriptUnavailable();
}
