"use client";

import { useEffect, useState } from "react";
import { IdeaCard, type Idea } from "@/components/idea-card";
import { GenerationProgress } from "@/components/write/generation-progress";
import type { JobInfo } from "@/components/write/types";
import { REPO_POSTS_TYPICAL, repoPostSteps } from "./repo-steps";

const POLL_MS = 3000;

type Status = "new" | "used" | "dismissed" | "archived" | "kept";

/**
 * The selected source's posts (spec 2026-10-10), as cards like a video's: Use keeps one and opens
 * it in Write, Dismiss hides it. While its latest repo_posts job runs, the steps; when it failed,
 * the agent's sentence.
 */
export function RepoPosts({ repo, posts, onStatus, onUse, onChanged, refreshKey = 0 }: {
  repo: Idea;
  /** This source's posts still to review, in Claude's order. */
  posts: Idea[];
  onStatus: (id: string, status: Status) => Promise<void>;
  onUse: (id: string) => Promise<void>;
  /** New posts arrived: reload. */
  onChanged: () => void;
  /** Bumped when a job was just started for this source: look at it. */
  refreshKey?: number;
}) {
  // undefined until the first answer; null when the source has no job at all.
  const [job, setJob] = useState<JobInfo | null | undefined>(undefined);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const res = await fetch(`/api/jobs?ideaId=${repo.id}&kind=repo_posts&limit=1`);
        if (!res.ok) return;
        const latest = ((await res.json()).jobs?.[0] ?? null) as JobInfo | null;
        if (cancelled) return;
        setJob((previous) => {
          if (previous && previous.status !== "done" && latest?.status === "done") onChanged();
          return latest;
        });
        if (latest && (latest.status === "queued" || latest.status === "claimed")) timer = setTimeout(check, POLL_MS);
      } catch (e) {
        console.error("failed to check the repo's posts:", e);
      }
    };
    void check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [repo.id, refreshKey, onChanged]);

  const running = job?.status === "queued" || job?.status === "claimed";
  const error = job?.status === "failed" ? (typeof job.result?.error === "string" ? job.result.error : "The Mac couldn't finish this one.") : null;

  return (
    <section className="space-y-3" aria-label={`Posts from ${repo.title ?? "the repository"}`}>
      {running && job && <GenerationProgress job={job} steps={repoPostSteps(job)} typical={REPO_POSTS_TYPICAL} />}
      {error && <p className="text-sm text-danger">{error}</p>}
      {(posts.length > 0 || running) && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {posts.map((post) => <IdeaCard key={post.id} idea={post} onStatus={onStatus} onUse={onUse} />)}
          {running && [0, 1, 2].map((i) => (
            <div key={i} aria-hidden className="h-56 animate-pulse rounded-2xl border border-border bg-surface" />
          ))}
        </div>
      )}
    </section>
  );
}
