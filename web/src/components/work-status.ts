/**
 * Whether Find Ideas or Write is working, for the sidebar (owner, 2026-09-27:
 * "se stanno lavorando voglio che ci sia un charging che poi diventa un tick
 * verde quando ha finito, così se sono su un'altra tab posso controllare…
 * cose più lunghe di qualche secondo", and "la spunta verde resta un secondo e
 * poi scompare"). A module-level store the sidebar reads with
 * useSyncExternalStore: it outlives the pages, so a search or a job started
 * on one tab is still followed from another.
 *
 * Two sources. Local work, a search streamed to the page, is wrapped in
 * trackWork. Jobs the Mac runs are read from GET /api/jobs/active by
 * refreshWork, which the sidebar calls on every tab change and when the
 * window gets focus, then every POLL_MS while one runs, and never otherwise.
 * When the last work on a tab ends, it shows ✓ (or its failure) for
 * DONE_SHOWN_MS, then nothing: "tanto se non sta caricando ha finito".
 */

export type WorkTab = "find" | "write";
export type WorkMark = "running" | "done" | "failed";
export type WorkSnapshot = Readonly<Record<WorkTab, WorkMark | null>>;

/** Which tab a job's work shows on: a video's or a repo's posts in Find Ideas; a post's takes, edits and Humanize in Compose. */
export const TAB_OF_KIND: Readonly<Record<string, WorkTab>> = {
  video_ideas: "find",
  repo_posts: "find",
  generate_from_video: "write",
  generate_from_idea: "write",
  revise_draft: "write",
  image_prompt: "write",
};

export const DONE_SHOWN_MS = 1500;
export const POLL_MS = 4000;

const TABS: WorkTab[] = ["find", "write"];
const EMPTY: WorkSnapshot = { find: null, write: null };

let snapshot: WorkSnapshot = EMPTY;
const listeners = new Set<() => void>();
const local: Record<WorkTab, number> = { find: 0, write: 0 };
const jobsRunning: Record<WorkTab, boolean> = { find: false, write: false };
/** Jobs seen queued or running, and their tab: when one is no longer, it has ended. */
const seen = new Map<string, WorkTab>();
const ended: Partial<Record<WorkTab, { mark: "done" | "failed"; until: number }>> = {};
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let reading = false;

function markOf(tab: WorkTab, now: number): WorkMark | null {
  if (local[tab] > 0 || jobsRunning[tab]) return "running";
  const end = ended[tab];
  return end && end.until > now ? end.mark : null;
}

function emit(): void {
  const now = Date.now();
  const next = { find: markOf("find", now), write: markOf("write", now) };
  if (TABS.every((tab) => next[tab] === snapshot[tab])) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function showEnd(tab: WorkTab, mark: "done" | "failed"): void {
  ended[tab] = { mark, until: Date.now() + DONE_SHOWN_MS };
  setTimeout(emit, DONE_SHOWN_MS + 20);
}

export function subscribeWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function workSnapshot(): WorkSnapshot {
  return snapshot;
}
export function serverWorkSnapshot(): WorkSnapshot {
  return EMPTY;
}

/** Local work on `tab`, like a search: running until it settles, then its ✓, or its failure when `ok` says so. */
export async function trackWork<T>(tab: WorkTab, work: Promise<T>, ok: (value: T) => boolean = () => true): Promise<T> {
  local[tab]++;
  emit();
  let succeeded = false;
  try {
    const value = await work;
    succeeded = ok(value);
    return value;
  } finally {
    local[tab]--;
    if (local[tab] === 0 && !jobsRunning[tab]) showEnd(tab, succeeded ? "done" : "failed");
    emit();
  }
}

/** One read of GET /api/jobs/active: which tabs have jobs running, and which just ended. */
export function applyJobs(rows: ReadonlyArray<{ id: string; kind: string; status: string }>): void {
  const running: Record<WorkTab, boolean> = { find: false, write: false };
  const live = new Set<string>();
  for (const row of rows) {
    const tab = TAB_OF_KIND[row.kind];
    if (!tab || (row.status !== "queued" && row.status !== "claimed")) continue;
    running[tab] = true;
    live.add(row.id);
    seen.set(row.id, tab);
  }
  for (const [id, tab] of seen) {
    if (live.has(id)) continue;
    seen.delete(id);
    // Gone from the list too: it ended longer ago than the list reaches, so it's over.
    const status = rows.find((row) => row.id === id)?.status;
    if (!running[tab] && local[tab] === 0) showEnd(tab, status === "failed" ? "failed" : "done");
  }
  for (const tab of TABS) jobsRunning[tab] = running[tab];
  emit();
}

/** Reads the jobs (GET /api/jobs/active) and, while one runs, reads again in POLL_MS. Best effort: a failed read changes nothing. */
export async function refreshWork(fetcher: typeof fetch = fetch): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const res = await fetcher("/api/jobs/active");
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body?.jobs)) applyJobs(body.jobs);
  } catch {
    // The sidebar stays as it was.
  } finally {
    reading = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = TABS.some((tab) => jobsRunning[tab]) ? setTimeout(() => void refreshWork(fetcher), POLL_MS) : null;
  }
}

/** Tests only: back to nothing working. */
export function resetWork(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  reading = false;
  seen.clear();
  for (const tab of TABS) {
    local[tab] = 0;
    jobsRunning[tab] = false;
    delete ended[tab];
  }
  snapshot = EMPTY;
}
