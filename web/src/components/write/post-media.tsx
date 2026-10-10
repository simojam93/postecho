"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkStep } from "@/components/work-progress";
import { refreshWork } from "@/components/work-status";
import { mediaOf, type MediaItem, type MediaKind } from "@/lib/media";
import { AGENT_PORT, deleteMediaFile, mediaUrl, revealMedia } from "@/lib/media-client";
import { GenerationProgress } from "./generation-progress";
import type { JobInfo } from "./types";

const POLL_MS = 3000;
const JSON_HEADERS = { "Content-Type": "application/json" };
const smallPillCls = "rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text disabled:opacity-50";

/** The menu's words for each kind. */
export const MEDIA_LABEL: Record<MediaKind, string> = {
  images: "Images from the repo",
  card: "A card",
  screenshots: "Screenshots",
  video: "A video",
};

/** How long each kind usually takes (spec 2026-10-11). */
export const MEDIA_TYPICAL: Record<MediaKind, string> = {
  images: "usually under a minute",
  card: "usually under a minute",
  screenshots: "usually a few minutes",
  video: "usually 10–30 min",
};

/** Each kind's steps, in the order the agent reports their phases (agent/src/media/post-media.ts). */
const STEPS: Record<MediaKind, Array<[phase: string, label: string]>> = {
  images: [["reading", "Looking for images in the repository"], ["saving", "Copying the ones that fit"]],
  card: [["making", "Writing the card"], ["saving", "Drawing it"]],
  screenshots: [["reading", "Opening the folder"], ["making", "Starting the app and taking screenshots"], ["saving", "Keeping the screenshots"]],
  video: [["reading", "Opening the folder"], ["making", "Making the video with brag-slim"], ["saving", "Keeping the video"]],
};

function kindOf(job: { payload?: Record<string, unknown> | null }): MediaKind {
  const kind = job.payload?.kind;
  return kind === "images" || kind === "screenshots" || kind === "video" ? kind : "card";
}

/** A post_media job, step by step: waiting for the Mac, then the kind's steps up to the phase it reported. */
export function mediaSteps(job: Pick<JobInfo, "status" | "payload"> & { result?: JobInfo["result"] }): WorkStep[] {
  if (job.status === "queued") return [{ label: "Waiting for your Mac", done: false }];
  if (job.status !== "claimed") return [];
  const steps = STEPS[kindOf(job)];
  const progress = job.result?.progress as { kind?: unknown; phase?: unknown } | undefined;
  const at = progress?.kind === "post_media" ? steps.findIndex(([phase]) => phase === progress.phase) : -1;
  const shown = steps.slice(0, Math.max(at, 0) + 1);
  return [
    { label: "Your Mac picked it up", done: true },
    ...shown.map(([, label], i) => ({ label, done: i < shown.length - 1 })),
  ];
}

const running = (job: JobInfo | null) => job?.status === "queued" || job?.status === "claimed";

/**
 * A post's media (media from a repo, 2026-10-11), as the page shows them: Add media with the kinds
 * the post's source allows, the steps while a job runs, and the thumbnails, each with Keep or Show in
 * Finder, and Remove. Pure: PostMedia below fetches and acts.
 */
export function MediaView({
  draftId, port, kinds, media, job, error, unreachable, menuOpen, busy,
  onMenu, onAdd, onKeep, onRemove, onReveal, onUnreachable,
}: {
  draftId: string;
  port: number;
  /** null until loaded. */
  kinds: MediaKind[] | null;
  media: MediaItem[];
  /** The latest media job for the post. */
  job: JobInfo | null;
  /** What asking for media answered, when it failed. */
  error: string | null;
  /** A thumbnail didn't load, or Show in Finder failed: the agent isn't reachable from this page. */
  unreachable: boolean;
  menuOpen: boolean;
  busy: boolean;
  onMenu: (open: boolean) => void;
  onAdd: (kind: MediaKind) => void;
  onKeep: (file: string) => void;
  onRemove: (file: string) => void;
  onReveal: (file: string) => void;
  onUnreachable: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) onMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen, onMenu]);

  const failed = job?.status === "failed"
    ? (typeof job.result?.error === "string" ? job.result.error : "The Mac couldn't make these media.")
    : null;
  const canAdd = kinds !== null && kinds.length > 0 && !running(job) && !busy;

  return (
    <section aria-label="Media" className="space-y-3">
      <div ref={menuRef} className="relative inline-flex">
        <button type="button" onClick={() => onMenu(!menuOpen)} disabled={!canAdd} aria-haspopup="menu" aria-expanded={menuOpen}
          className={smallPillCls}>Add media</button>
        {menuOpen && kinds && (
          <div role="menu" className="absolute left-0 top-full z-10 mt-1 min-w-48 rounded-xl border border-border bg-surface-2 p-1 shadow-lg">
            {kinds.map((kind) => (
              <button key={kind} type="button" role="menuitem" onClick={() => { onMenu(false); onAdd(kind); }}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface">
                {MEDIA_LABEL[kind]}
              </button>
            ))}
          </div>
        )}
      </div>

      {running(job) && job && <GenerationProgress job={job} steps={mediaSteps(job)} typical={MEDIA_TYPICAL[kindOf(job)]} />}
      {(error ?? failed) && <p className="text-sm text-danger">{error ?? failed}</p>}

      {media.length > 0 && (
        <>
          {unreachable && <p className="text-xs text-text-dim">The media are on the computer where the agent runs.</p>}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {media.map((item) => {
              const src = mediaUrl(port, draftId, item.file);
              return (
                <li key={item.file}>
                  <figure className={`overflow-hidden rounded-xl border bg-surface-2 ${item.kept ? "border-accent" : "border-border"}`}>
                    {item.kind === "video" ? (
                      <video src={src} crossOrigin="anonymous" controls muted playsInline preload="metadata" onError={onUnreachable}
                        className="aspect-video w-full bg-surface object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- a file on the owner's computer, served by the agent: nothing for next/image to optimize.
                      <img src={src} alt={item.caption ?? ""} crossOrigin="anonymous" loading="lazy" onError={onUnreachable}
                        className="aspect-video w-full bg-surface object-cover" />
                    )}
                    <figcaption className="space-y-2 p-2">
                      {item.caption && <p className="line-clamp-2 text-xs text-text-dim">{item.caption}</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {item.kept
                          ? <button type="button" onClick={() => onReveal(item.file)} className={smallPillCls}>Show in Finder</button>
                          : <button type="button" onClick={() => onKeep(item.file)} disabled={busy} className={smallPillCls}>Keep</button>}
                        <button type="button" onClick={() => onRemove(item.file)} disabled={busy}
                          className="rounded-full px-2 py-1 text-xs text-text-dim hover:text-danger disabled:opacity-50">Remove</button>
                      </div>
                    </figcaption>
                  </figure>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

type Loaded = { kinds: MediaKind[]; media: MediaItem[]; job: JobInfo | null };

/**
 * Add media under a post from a repo (spec 2026-10-11): reads GET /api/drafts/:id/media, polls while
 * a media job runs and reloads when it ends; Keep and Remove go through PATCH /api/drafts/:id
 * (`media`), Remove also deletes the file through the agent, Show in Finder asks the agent.
 */
export function PostMedia({ draftId }: { draftId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/drafts/${draftId}/media`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const next: Loaded = { kinds: body.kinds ?? [], media: mediaOf({ media: body.media }), job: body.job ?? null };
        if (cancelled) return;
        setData(next);
        if (running(next.job)) timer = setTimeout(load, POLL_MS);
      } catch (e) {
        console.error("failed to load the post's media:", e);
      }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [draftId, reloadKey]);

  const closeMenu = useCallback((open: boolean) => setMenuOpen(open), []);

  async function add(kind: MediaKind) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/media`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : "Something went wrong. Try again.");
        return;
      }
      setReloadKey((k) => k + 1);
      void refreshWork();
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  /** Saves the list the page wants; the draft's answer is the truth. */
  async function save(next: Array<{ file: string; kept: boolean }>): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ media: next }) });
      if (!res.ok) return false;
      const body = await res.json();
      setData((current) => current && { ...current, media: mediaOf(body.draft?.meta) });
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  const media = data?.media ?? [];
  const keep = (file: string) => void save(media.map((item) => ({ file: item.file, kept: item.kept || item.file === file })));
  const remove = async (file: string) => {
    if (await save(media.filter((item) => item.file !== file).map(({ file: f, kept }) => ({ file: f, kept })))) {
      void deleteMediaFile(AGENT_PORT, draftId, file);
    }
  };
  const reveal = async (file: string) => {
    if (!(await revealMedia(AGENT_PORT, draftId, file))) setUnreachable(true);
  };

  return (
    <MediaView
      draftId={draftId}
      port={AGENT_PORT}
      kinds={data?.kinds ?? null}
      media={media}
      job={data?.job ?? null}
      error={error}
      unreachable={unreachable || AGENT_PORT === 0}
      menuOpen={menuOpen}
      busy={busy}
      onMenu={closeMenu}
      onAdd={(kind) => void add(kind)}
      onKeep={keep}
      onRemove={(file) => void remove(file)}
      onReveal={(file) => void reveal(file)}
      onUnreachable={() => setUnreachable(true)}
    />
  );
}
