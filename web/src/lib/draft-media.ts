import { eq } from "drizzle-orm";
import { drafts, ideas } from "@/db/schema";
import { mediaKindsFor, type MediaKind } from "@/lib/media";
import { normalizeRepoSource, type RepoSource } from "@/lib/repo-source";
import type { db as Db } from "@/db";

type DraftRow = typeof drafts.$inferSelect;
type IdeaRow = typeof ideas.$inferSelect;

/** What a post_media job needs to know about the post: its repository when it has one, its source and its text. */
export type DraftMediaSource = {
  draft: DraftRow;
  /** The repository a post from a repo came from; null for a post from anywhere else. */
  repo: { id: string; source: RepoSource } | null;
  kinds: MediaKind[];
  /** The post as the agent reads it: an article's title and body, or the X and LinkedIn texts. */
  postText: string;
  /** "linkedin" when the post has a LinkedIn text: its card gets the taller size too. */
  format: "x" | "linkedin" | "article";
  /** Where a post not from a repo comes from, for the card's footer and the image's credit: an author, else a site, else a title. */
  sourceName: string | null;
  /** The source's preview image (a video's thumbnail, an article's og:image), https only. */
  imageUrl: string | null;
};

/** The longest post text a job carries: an article's whole body fits. */
const POST_TEXT_MAX = 12_500;
const SOURCE_NAME_MAX = 120;

async function ideaById(db: typeof Db, id: unknown): Promise<IdeaRow | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1);
  return row ?? null;
}

async function repoOf(db: typeof Db, post: IdeaRow | null): Promise<DraftMediaSource["repo"]> {
  if (post?.kind !== "repo_post") return null;
  const repo = await ideaById(db, post.meta.repoId);
  if (!repo || repo.kind !== "repo" || !repo.url) return null;
  const raw: RepoSource = repo.meta.sourceType === "folder"
    ? { type: "folder", path: typeof repo.meta.path === "string" ? repo.meta.path : repo.url.replace(/^file:\/\//, "") }
    : { type: "github", url: repo.url };
  const source = normalizeRepoSource(raw);
  return source ? { id: repo.id, source } : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? hostname.replace(/^www\./, "") || null : null;
  } catch {
    return null;
  }
}

/** The source's name: its author, else its site, else its title. */
function sourceNameOf(origin: IdeaRow): string | null {
  const name = origin.author?.trim() || hostOf(origin.url) || origin.title?.trim() || null;
  return name ? name.slice(0, SOURCE_NAME_MAX) : null;
}

/** A video's thumbnail or an article's og:image, when it's an https link. */
function imageOf(origin: IdeaRow): string | null {
  const url = origin.meta.thumbnailUrl ?? origin.meta.imageUrl;
  return typeof url === "string" && url.startsWith("https://") && URL.canParse(url) ? url : null;
}

/**
 * The draft and where its post came from (media from a repo, 2026-10-11; every post since): a post from
 * a repo has its repository; any other has its source's name and preview image, read from the idea or,
 * for a video's post, from its video. A draft without an idea still gets a card. Null for no draft.
 */
export async function draftMediaSource(db: typeof Db, draftId: string): Promise<DraftMediaSource | null> {
  const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) return null;
  const post = await ideaById(db, draft.ideaId);
  const repo = await repoOf(db, post);
  const origin = post && !repo ? (post.kind === "video_idea" ? await ideaById(db, post.meta.videoId) : null) ?? post : null;
  const sourceName = origin ? sourceNameOf(origin) : null;
  const imageUrl = origin && sourceName ? imageOf(origin) : null;

  const article = draft.articleText !== null;
  const postText = (article
    ? [draft.articleTitle, draft.articleText]
    : [draft.xText, draft.linkedinText]
  ).map((text) => text?.trim()).filter(Boolean).join("\n\n").slice(0, POST_TEXT_MAX);
  const format = article ? "article" : draft.linkedinText?.trim() ? "linkedin" : "x";
  const kinds = mediaKindsFor({ repo: repo?.source.type ?? null, sourceImage: imageUrl !== null });
  return { draft, repo, kinds, postText, format, sourceName, imageUrl };
}
