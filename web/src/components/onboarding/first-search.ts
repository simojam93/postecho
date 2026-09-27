import { scoutResultMessage, type ScoutSummary } from "@/components/search-box";
import { postSearch, type SearchStep } from "@/lib/search-steps";
import { trackWork } from "@/components/work-status";
import { sourceLabel } from "@/lib/sources/labels";

/** Fired on window when a search the welcome started has finished: Find Ideas reloads its grid and chips. */
export const IDEAS_CHANGED_EVENT = "postecho:ideas-changed";
/** Fired on window whenever the first search moves on: Find Ideas' banner follows it. */
export const FIRST_SEARCH_EVENT = "postecho:first-search";

/**
 * The welcome's first search, followed in Find Ideas (owner, 2026-09-27: the
 * welcome ends on the first results, then "to have better results connect
 * more sources… e li si rimanda ai settings"). The welcome starts it and
 * closes; Find Ideas, mounted already or not yet, reads where it's at and
 * hears when it changes. It lives in this page's memory only: a reload
 * forgets it.
 */
export type FirstSearch =
  | { status: "searching"; topic: string; steps: SearchStep[]; startedAt: number }
  | {
      status: "done";
      topic: string;
      /** Cards it brought: new ones plus ones already saved. */
      found: number;
      message: string;
      /** The search couldn't judge: Jev isn't connected. */
      /** Saved without Jev, so not ranked (lib/scout-run.ts's UNRANKED_NOTE). */
      unranked: boolean;
      /** The sources it skipped for want of a key, by name. */
      missingSources: string[];
    }
  | { status: "failed"; topic: string };

let current: FirstSearch | null = null;

export function getFirstSearch(): FirstSearch | null {
  return current;
}

export function subscribeFirstSearch(onChange: () => void): () => void {
  window.addEventListener(FIRST_SEARCH_EVENT, onChange);
  return () => window.removeEventListener(FIRST_SEARCH_EVENT, onChange);
}

function set(next: FirstSearch | null) {
  current = next;
  window.dispatchEvent(new Event(FIRST_SEARCH_EVENT));
}

/** The banner's ×. */
export function dismissFirstSearch(): void {
  set(null);
}

/** The sources a search skipped for want of a key: what "connect more sources" names. */
export function missingSources(perSource: ScoutSummary["perSource"]): string[] {
  return Object.entries(perSource ?? {})
    .filter(([, source]) => source.status === "disabled")
    .map(([name]) => sourceLabel(name).label);
}

/** Searches `topic` as the Search box would, telling Find Ideas how it's going. */
export async function runFirstSearch(topic: string, fetcher: typeof fetch = fetch): Promise<void> {
  const startedAt = Date.now();
  set({ status: "searching", topic, steps: [], startedAt });
  try {
    const res = await trackWork("find", postSearch({ input: topic, mode: "trends" }, (steps) => set({ status: "searching", topic, steps, startedAt }), fetcher), (r) => r.ok);
    const body = res.body;
    const scout = body?.scout as ScoutSummary | undefined;
    if (!res.ok || !scout) {
      console.error(`welcome: the first search for "${topic}" failed:`, res.status);
      set({ status: "failed", topic });
      return;
    }
    set({
      status: "done",
      topic,
      found: scout.inserted + scout.skippedDuplicates,
      message: scoutResultMessage(typeof body.query === "string" ? body.query : topic, scout)?.text ?? "",
      unranked: Boolean(scout.note?.startsWith("unranked")),
      missingSources: missingSources(scout.perSource),
    });
  } catch (e) {
    console.error(`welcome: the first search for "${topic}" failed:`, e);
    set({ status: "failed", topic });
  } finally {
    window.dispatchEvent(new Event(IDEAS_CHANGED_EVENT));
  }
}
