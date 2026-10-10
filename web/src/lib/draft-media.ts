import { eq } from "drizzle-orm";
import { drafts, ideas } from "@/db/schema";
import { mediaKindsFor, type MediaKind } from "@/lib/media";
import { normalizeRepoSource, type RepoSource } from "@/lib/repo-source";
import type { db as Db } from "@/db";

type DraftRow = typeof drafts.$inferSelect;

/** What a post_media job needs to know about the post: its repository and its text. */
export type DraftMediaSource = {
  draft: DraftRow;
  repoId: string;
  source: RepoSource;
  kinds: MediaKind[];
  /** The post as the agent reads it: an article's title and body, or the X and LinkedIn texts. */
  postText: string;
  /** "linkedin" when the post has a LinkedIn text: its card gets the taller size too. */
  format: "x" | "linkedin" | "article";
};

/** The longest post text a job carries: an article's whole body fits. */
const POST_TEXT_MAX = 12_500;

/**
 * The draft and the repository its post came from (media from a repo, 2026-10-11): a draft whose
 * idea is a `repo_post`, whose `meta.repoId` is a `repo` source. `null` draft when there is no such
 * draft; `source` null when it isn't a post from a repo.
 */
export async function draftMediaSource(
  db: typeof Db,
  draftId: string,
): Promise<{ draft: DraftRow | null; media: DraftMediaSource | null }> {
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) return { draft: null, media: null };
  const [post] = draft.ideaId ? await db.select().from(ideas).where(eq(ideas.id, draft.ideaId)).limit(1) : [];
  const repoId = post?.kind === "repo_post" && typeof post.meta.repoId === "string" ? post.meta.repoId : null;
  const [repo] = repoId ? await db.select().from(ideas).where(eq(ideas.id, repoId)).limit(1) : [];
  if (!repo || repo.kind !== "repo" || !repo.url) return { draft, media: null };

  const raw: RepoSource = repo.meta.sourceType === "folder"
    ? { type: "folder", path: typeof repo.meta.path === "string" ? repo.meta.path : repo.url.replace(/^file:\/\//, "") }
    : { type: "github", url: repo.url };
  const source = normalizeRepoSource(raw);
  if (!source) return { draft, media: null };

  const article = draft.articleText !== null;
  const postText = (article
    ? [draft.articleTitle, draft.articleText]
    : [draft.xText, draft.linkedinText]
  ).map((text) => text?.trim()).filter(Boolean).join("\n\n").slice(0, POST_TEXT_MAX);
  const format = article ? "article" : draft.linkedinText?.trim() ? "linkedin" : "x";
  return { draft, media: { draft, repoId: repo.id, source, kinds: mediaKindsFor(source.type), postText, format } };
}
