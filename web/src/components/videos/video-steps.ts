import type { WorkStep } from "@/components/work-progress";
import type { JobInfo } from "@/components/write/types";

/** A video's posts take a whole read and a dozen posts: longer than a post's takes. */
export const VIDEO_POSTS_TYPICAL = "usually 1–3 min";

const LANGUAGES: Record<string, string> = { en: "English", it: "Italian" };

/** What the agent read the video from, said once it's done (agent/src/handlers.ts's VideoRead). */
function readLabel(progress: { source?: unknown; lang?: unknown; pasted?: unknown }): string {
  if (progress.source === "description") return "No script on YouTube, so it read the description";
  if (progress.pasted === true) return "Read the script you pasted";
  const language = typeof progress.lang === "string" ? LANGUAGES[progress.lang] ?? progress.lang : null;
  return language ? `Extracted the script in ${language}` : "Extracted the script";
}

/**
 * Writing a video's posts, step by step, as its video_ideas job tells it
 * (owner, 2026-09-27: "1. extracting script in english 2. analysing script…
 * in stile come fa claude"): waiting for the Mac, extracting the script (or
 * reading the description, when YouTube has none), writing the posts from
 * it, then Jev's check of how human each reads. The agent reports each
 * phase (agent/src/handlers.ts's handleVideoIdeas).
 */
export function videoPostSteps(job: Pick<JobInfo, "status" | "payload"> & { result?: JobInfo["result"] }): WorkStep[] {
  if (job.status === "queued") return [{ label: "Waiting for your Mac", done: false }];
  if (job.status !== "claimed") return [];
  const count = typeof job.payload?.count === "number" ? job.payload.count : 12;
  const progress = job.result?.progress as { kind?: unknown; phase?: unknown; source?: unknown; lang?: unknown; pasted?: unknown } | undefined;
  const steps: WorkStep[] = [{ label: "Your Mac picked it up", done: true }];
  const phase = progress?.kind === "video_ideas" ? progress.phase : null;
  if (phase === "writing" || phase === "checking") {
    const what = progress!.source === "description" ? "description" : "script";
    steps.push({ label: readLabel(progress!), done: true });
    steps.push(phase === "writing"
      ? { label: `Writing the ${count} best posts from the ${what}`, done: false }
      : { label: "Wrote the posts", done: true });
    if (phase === "checking") steps.push({ label: `Checking how human each one reads, to keep the ${count} best`, done: false });
  } else {
    steps.push({ label: "Extracting the script", done: false });
  }
  return steps;
}
