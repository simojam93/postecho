import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas, jobKind, jobs } from "@/db/schema";
import { requireSession } from "@/lib/session";

const KindFilter = z.enum(jobKind.enumValues);

/** A video_ideas result keeps the whole text the agent read for Use (api/drafts/from-idea); the page never needs it. */
function withoutReadText(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result || !("text" in result)) return result;
  return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "text"));
}
const Limit = z.coerce.number().int().min(1).max(50);
const DEFAULT_LIMIT = 20;

/**
 * GET /api/jobs?kind=&id=&ideaId=&limit=
 *
 * `id` and `ideaId` (task A6) let the UI poll a single job's status
 * directly — e.g. Create's "Claude is writing/rewriting…" states poll
 * `?id=<jobId>` after enqueueing a revise/image-prompt job, and a video/idea
 * card polls `?ideaId=<ideaId>` to notice a generate_from_video/idea job
 * in flight before its drafts exist. `ideaId` matches `payload->>'ideaId'`
 * (a jsonb text-extraction equality, since jobs has no dedicated ideaId
 * column — payload is the only place it lives; see materialize.ts and the
 * drafts/from-idea route). All filters AND together; none of them are
 * mutually exclusive with `kind`. Either filter accepting a well-formed but
 * non-matching uuid returns an empty list, same as an unmatched `kind`
 * already did — only a malformed (non-uuid) value 400s.
 */
export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const params = new URL(request.url).searchParams;

  const kindParam = params.get("kind");
  let kind: z.infer<typeof KindFilter> | undefined;
  if (kindParam !== null) {
    const parsedKind = KindFilter.safeParse(kindParam);
    if (!parsedKind.success) return Response.json({ error: "invalid kind" }, { status: 400 });
    kind = parsedKind.data;
  }

  const idParam = params.get("id");
  if (idParam !== null && !z.uuid().safeParse(idParam).success) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const ideaIdParam = params.get("ideaId");
  if (ideaIdParam !== null && !z.uuid().safeParse(ideaIdParam).success) {
    return Response.json({ error: "invalid ideaId" }, { status: 400 });
  }

  const limitParam = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsedLimit = Limit.safeParse(limitParam);
    if (!parsedLimit.success) return Response.json({ error: "invalid limit" }, { status: 400 });
    limit = parsedLimit.data;
  }

  try {
    const conditions = [];
    if (kind) conditions.push(eq(jobs.kind, kind));
    if (idParam) conditions.push(eq(jobs.id, idParam));
    if (ideaIdParam) conditions.push(sql`${jobs.payload}->>'ideaId' = ${ideaIdParam}`);

    const rows = await db
      .select()
      .from(jobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(limit);

    // Mode-scoped searches strip support: a job whose payload carries a
    // seedIdeaId (i.e. it came from a Search, not "Search my topics") joins
    // that idea's kind so the UI can tell a Videos-seeded search from a
    // Trends-seeded one. Batched into one extra query (not N+1) since a
    // page of jobs is small and this only needs each distinct id once.
    const seedIdeaIds = [...new Set(
      rows
        .map((j) => (j.payload as { seedIdeaId?: unknown }).seedIdeaId)
        .filter((id): id is string => typeof id === "string"),
    )];
    const kindBySeedIdeaId = new Map<string, string>();
    if (seedIdeaIds.length > 0) {
      const seedIdeas = await db.select({ id: ideas.id, kind: ideas.kind }).from(ideas).where(inArray(ideas.id, seedIdeaIds));
      for (const idea of seedIdeas) kindBySeedIdeaId.set(idea.id, idea.kind);
    }

    return Response.json({
      jobs: rows.map((j) => {
        const seedIdeaId = (j.payload as { seedIdeaId?: unknown }).seedIdeaId;
        return {
          id: j.id,
          kind: j.kind,
          status: j.status,
          // The scout worker's convention (and any future job kind that wants
          // to surface a short label) — jobs with no `query` key in payload
          // (e.g. generate_from_video) report null rather than undefined so
          // the shape is stable for callers.
          query: (j.payload as { query?: string }).query ?? null,
          seedKind: typeof seedIdeaId === "string" ? kindBySeedIdeaId.get(seedIdeaId) ?? null : null,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          result: j.kind === "video_ideas" ? withoutReadText(j.result) : j.result,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
