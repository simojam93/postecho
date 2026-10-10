import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas, jobs } from "@/db/schema";
import { agentServes, UPDATE_AGENT_ERROR } from "@/lib/agent-kinds";
import { normalizeRepoSource, repoIdeaUrl, repoTitle, type RepoSource } from "@/lib/repo-source";
import { requireSession } from "@/lib/session";
import { jobCreated } from "@/lib/job-header";

/** How many posts one Create may ask for, and how many by default. */
export const REPO_POSTS_MAX = 6;
export const REPO_POSTS_DEFAULT = 3;

const Source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("folder"), path: z.string().max(1000) }).strict(),
  z.object({ type: z.literal("github"), url: z.string().max(500) }).strict(),
]);

const Body = z.object({
  source: Source,
  brief: z.string().max(500).default(""),
  format: z.enum(["x", "linkedin", "article"]),
  count: z.number().int().min(1).max(REPO_POSTS_MAX).default(REPO_POSTS_DEFAULT),
}).strict();

const bad = (error: string) => Response.json({ error }, { status: 400 });

/**
 * POST /api/repos (posts from a repo, 2026-10-10)
 *
 * Body: `{ source: { type: "folder", path } | { type: "github", url }, brief?, format: "x" |
 * "linkedin" | "article", count?: 1-6 }`. The source becomes a `repo` idea (url `file://<path>` or
 * the plain GitHub link, title the folder's name or `owner/name`, `meta.sourceType`), reused when
 * the same source comes again, and a `repo_posts` job asks the agent to read it and write `count`
 * posts in the format; materialize.ts saves them as `repo_post` ideas under the source. Answers
 * `{ ideaId, jobId }`, or 409 with the update message when the agent's last heartbeat didn't list
 * repo_posts (lib/agent-kinds.ts), before anything is saved.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "count") return bad(`Ask for 1 to ${REPO_POSTS_MAX} posts.`);
    if (issue?.path[0] === "format") return bad("Pick X post, LinkedIn post or X article.");
    return bad("Choose a folder, or paste a GitHub link.");
  }
  const source = normalizeRepoSource(parsed.data.source as RepoSource);
  if (!source) {
    return parsed.data.source.type === "folder"
      ? bad("Choose a folder, or type its path.")
      : bad("Paste a public GitHub link, like https://github.com/owner/name.");
  }
  const { brief, format, count } = parsed.data;

  try {
    if (!(await agentServes("repo_posts"))) return Response.json({ error: UPDATE_AGENT_ERROR }, { status: 409 });

    const url = repoIdeaUrl(source);
    const title = repoTitle(source);
    // When it was used last: the source chips go newest first.
    const usedAt = new Date().toISOString();
    const meta = { sourceType: source.type, ...(source.type === "folder" ? { path: source.path } : {}), usedAt };
    const [inserted] = await db.insert(ideas).values({ url, kind: "repo", title, meta })
      // ideas_url_unique is a partial index (WHERE url IS NOT NULL): the matching `where` lets Postgres use it here.
      .onConflictDoNothing({ target: ideas.url, where: sql`${ideas.url} is not null` })
      .returning();
    let repo = inserted;
    if (!repo) {
      // Used before, or a GitHub repo a search found: it's a source of From a repo now, back among the chips.
      const [existing] = await db.select().from(ideas).where(eq(ideas.url, url)).limit(1);
      [repo] = await db.update(ideas)
        .set({ kind: "repo", title, status: "new", source: "manual", meta: { ...existing.meta, ...meta } })
        .where(eq(ideas.id, existing.id)).returning();
    }

    const [job] = await db.insert(jobs).values({
      kind: "repo_posts",
      payload: { ideaId: repo.id, source, brief: brief.trim(), format, count },
    }).returning();
    return jobCreated({ ideaId: repo.id, jobId: job.id }, job.id);
  } catch (err) {
    console.error(err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
