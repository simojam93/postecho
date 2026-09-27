"use client";

import { useEffect, useState } from "react";
import { IdeaCard, type Idea } from "@/components/idea-card";
import { ShowMoreButton, useShowMore } from "@/components/show-more";
import { WorkProgress } from "@/components/work-progress";
import { VIDEO_POSTS_TYPICAL, videoPostSteps } from "./video-steps";
import type { JobInfo } from "@/components/write/types";

const POLL_MS = 3000;
const JSON_HEADERS = { "Content-Type": "application/json" };
/** The agent's words when YouTube gives no transcript (agent/src/transcript.ts's TranscriptUnavailable). */
const NO_TRANSCRIPT = /transcript unavailable/i;

type Status = "new" | "used" | "dismissed" | "archived" | "kept";

/**
 * The post ideas PostEcho found in the selected video's whole transcript
 * (owner, 2026-09-27: "it should take all the script of the video and create
 * some post ideas that I can use. I would say at least 6 best and 6 more that
 * I can open if I click show more"): six at a time, best first; the video
 * itself is its chip above (VideoChips). While the Mac reads it, the moving
 * bar; ideas taken from the description (YouTube had no transcript) say so,
 * with a box to paste the transcript for better ones.
 */
export function VideoIdeas({ video, ideas, onStatus, onUse, onChanged, refreshKey = 0 }: {
  video: Idea;
  /** This video's ideas still to review, best first. */
  ideas: Idea[];
  onStatus: (id: string, status: Status) => Promise<void>;
  onUse: (id: string) => Promise<void>;
  /** New ideas arrived: reload. */
  onChanged: () => void;
  /** Bumped when the video was asked again from its chip: look at the new job. */
  refreshKey?: number;
}) {
  // undefined until the first answer; null when the video has no ideas job at all.
  const [job, setJob] = useState<JobInfo | null | undefined>(undefined);
  const [pollKey, setPollKey] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const { count, showMore } = useShowMore(video.id);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const res = await fetch(`/api/jobs?ideaId=${video.id}&kind=video_ideas&limit=1`);
        if (!res.ok) return;
        const latest = ((await res.json()).jobs?.[0] ?? null) as JobInfo | null;
        if (cancelled) return;
        setJob((previous) => {
          if (previous && previous.status !== "done" && latest?.status === "done") onChanged();
          return latest;
        });
        if (latest && (latest.status === "queued" || latest.status === "claimed")) timer = setTimeout(check, POLL_MS);
      } catch (e) {
        console.error("failed to check the video's ideas:", e);
      }
    };
    void check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [video.id, pollKey, refreshKey, onChanged]);

  /** Asks the Mac again, with the transcript pasted by hand when there is one. */
  async function askAgain(withTranscript?: string) {
    if (asking || !video.url) return;
    setAsking(true);
    setAskError(null);
    try {
      const res = await fetch("/api/videos/ideas", {
        method: "POST", headers: JSON_HEADERS,
        body: JSON.stringify({ url: video.url, ...(withTranscript ? { transcript: withTranscript } : {}) }),
      });
      if (!res.ok) { setAskError("Couldn't ask again. Try in a moment."); return; }
      setTranscript("");
      setPollKey((k) => k + 1);
    } finally {
      setAsking(false);
    }
  }

  const running = job?.status === "queued" || job?.status === "claimed";
  const failed = job?.status === "failed";
  const error = failed && typeof job?.result?.error === "string" ? job.result.error : null;
  const needsTranscript = failed && NO_TRANSCRIPT.test(error ?? "");
  const found = ideas.length;
  // YouTube had no transcript in any language: the agent read the description and chapters instead.
  const fromDescription = ideas.some((idea) => idea.meta.fromDescription === true);

  return (
    <section className="space-y-3" aria-label={`Post ideas from ${video.title ?? "the video"}`}>

      {running && job && (
        <WorkProgress steps={videoPostSteps(job)} startedAt={job.createdAt} typical={VIDEO_POSTS_TYPICAL} label="Video posts progress" />
      )}
      {fromDescription && !running && (
        <details className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <summary className="cursor-pointer text-text-dim">YouTube has no transcript for this video, so these ideas come from its description. Paste the transcript for better ones.</summary>
          <div className="mt-3 space-y-2">
            <textarea rows={4} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="The video's transcript"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim" />
            <button type="button" onClick={() => void askAgain(transcript.trim())} disabled={asking || !transcript.trim()}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50">
              {asking ? "Sending…" : "Create"}
            </button>
          </div>
        </details>
      )}
      {needsTranscript && (
        <div className="space-y-2 rounded-xl border border-border bg-surface p-4">
          <p className="text-sm">YouTube has no transcript for this video. Paste it here and PostEcho finds the ideas from it.</p>
          <textarea rows={4} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="The video's transcript"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim" />
          <button type="button" onClick={() => void askAgain(transcript.trim())} disabled={asking || !transcript.trim()}
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50">
            {asking ? "Sending…" : "Create"}
          </button>
        </div>
      )}
      {failed && !needsTranscript && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="text-danger">{error ?? "The Mac couldn't finish this one."}</p>
          <button type="button" onClick={() => void askAgain()} disabled={asking}
            className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text disabled:opacity-50">Try again</button>
        </div>
      )}
      {askError && <p className="text-sm text-danger">{askError}</p>}

      {(found > 0 || running) && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {ideas.slice(0, count).map((idea) => <IdeaCard key={idea.id} idea={idea} onStatus={onStatus} onUse={onUse} />)}
            {running && [0, 1, 2].map((i) => (
              <div key={i} aria-hidden className="h-56 animate-pulse rounded-2xl border border-border bg-surface" />
            ))}
          </div>
          <ShowMoreButton hidden={found - count} onClick={showMore} />
        </div>
      )}
      {job?.status === "done" && found === 0 && (
        <p className="text-sm text-text-dim">No ideas left from this video. <button type="button" onClick={() => void askAgain()} className="underline hover:text-text">Find more</button></p>
      )}
    </section>
  );
}
