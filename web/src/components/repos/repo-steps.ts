import type { WorkStep } from "@/components/work-progress";
import type { JobInfo } from "@/components/write/types";

/** Claude Code exploring a repository and writing from it: longer than a video's posts. */
export const REPO_POSTS_TYPICAL = "usually 2–5 min";

export type RepoFormat = "x" | "linkedin" | "article";

const FORMAT_NAMES: Record<RepoFormat, [one: string, many: string]> = {
  x: ["an X post", "X posts"],
  linkedin: ["a LinkedIn post", "LinkedIn posts"],
  article: ["an X article", "X articles"],
};

/** "3 X posts", "a LinkedIn post", "an X article". */
export function postsLabel(format: RepoFormat, count: number): string {
  const [one, many] = FORMAT_NAMES[format];
  return count === 1 ? one : `${count} ${many}`;
}

/**
 * A repo_posts job, step by step (spec 2026-10-10: "getting the repository, reading it,
 * writing"): waiting for the Mac, getting a GitHub repository (a folder is read where it is),
 * then Claude Code reading it and writing, which is one call that says nothing until it ends
 * (agent/src/handlers.ts's handleRepoPosts), so one step.
 */
export function repoPostSteps(job: Pick<JobInfo, "status" | "payload"> & { result?: JobInfo["result"] }): WorkStep[] {
  if (job.status === "queued") return [{ label: "Waiting for your Mac", done: false }];
  if (job.status !== "claimed") return [];
  const payload = job.payload ?? {};
  const format: RepoFormat = payload.format === "linkedin" || payload.format === "article" ? payload.format : "x";
  const count = typeof payload.count === "number" ? payload.count : 3;
  const github = (payload.source as { type?: unknown } | undefined)?.type === "github";
  const progress = job.result?.progress as { kind?: unknown; phase?: unknown } | undefined;
  const phase = progress?.kind === "repo_posts" ? progress.phase : null;

  const steps: WorkStep[] = [{ label: "Your Mac picked it up", done: true }];
  if (phase === "fetching") {
    steps.push({ label: "Getting the repository from GitHub", done: false });
  } else if (phase === "reading" || phase === "writing") {
    if (github) steps.push({ label: "Got the repository from GitHub", done: true });
    steps.push({ label: `Reading the repository and writing ${postsLabel(format, count)}`, done: false });
  } else {
    steps.push({ label: "Reading the repository", done: false });
  }
  return steps;
}
