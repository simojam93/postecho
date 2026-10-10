/**
 * Client-side shapes for the Write page (M2.5 plan, task W3): mirrors of the
 * server types in lib/drafts.ts (dates arrive as ISO strings over JSON) plus
 * the slices of /api/ideas, /api/jobs and /api/settings the page renders.
 * Declared here rather than imported from lib/ so the client bundle never
 * pulls in the drizzle schema those server modules import.
 */

export type DraftStatus = "candidate" | "kept" | "used" | "discarded";

/** lib/drafts.ts's IdeaSummary. */
export type DraftIdea = { id: string; title: string | null; url: string | null; kind: string };

/** A row of GET /api/drafts — lib/drafts.ts's DraftListItem. */
export type Draft = {
  id: string;
  ideaId: string | null;
  xText: string | null;
  linkedinText: string | null;
  /** An X article's title and body (posts from a repo, 2026-10-10); null on X and LinkedIn posts. */
  articleTitle?: string | null;
  articleText?: string | null;
  /** When Ready put it in Schedule's list (schedule in a row, 2026-10-10); null while in Compose. */
  readyAt?: string | null;
  status: DraftStatus;
  favorite: boolean;
  parentId: string | null;
  imagePrompt: string | null;
  jobId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  idea: DraftIdea | null;
  latestJobStatus: string | null;
};

/** An entry of GET /api/drafts?view=in-progress — lib/drafts.ts's PostInProgress. */
export type PostInProgress = {
  ideaId: string | null;
  idea: DraftIdea | null;
  chosenDraftId: string | null;
  takeCount: number;
  latestJobStatus: string | null;
};

/** The fields of an ideas row (GET /api/ideas) the source card and strip labels use. */
export type SourceIdea = {
  id: string;
  url: string | null;
  kind: string;
  title: string | null;
  content: string | null;
  author: string | null;
  status: string;
  // `voice` (M3.7): the post's voice once switched in Write — lib/voice.ts.
  // A video's ready post (lib/video-post.ts): `format` "post", and the video it came from.
  meta: {
    thumbnailUrl?: string | null; topic?: string; sourceName?: string; voice?: string;
    format?: string; videoTitle?: string | null; articleUrl?: string;
    // A post from a repo (2026-10-10): the repository it was written from.
    repoName?: string;
  };
};

/**
 * A row of GET /api/jobs. `createdAt` (when the job was enqueued) drives the
 * progress block's elapsed counter. `payload` is NOT returned by that route
 * today — it's read when present (e.g. a POST /api/drafts/from-idea response
 * carries the full row) so a `count` there wins over the per-kind default.
 */
export type JobInfo = {
  id: string;
  kind: string;
  status: string;
  result: Record<string, unknown> | null;
  createdAt?: string | null;
  payload?: Record<string, unknown> | null;
};

export type Platform = "x" | "linkedin";

/** The owner's identity (Settings → identity*), for the X-style take previews. */
export type Identity = { name: string; handle: string; avatarUrl: string };
