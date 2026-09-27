import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideaKind, ideas } from "@/db/schema";
import { saveIdeaFromInput } from "@/lib/ideas";
import { requireSession, safeEqual } from "@/lib/session";

const ScoutMeta = z.object({
  score: z.number().min(0).max(100).optional(),
  topic: z.string().max(80).optional(),
});

const Body = z.union([
  z.object({ url: z.url(), source: z.literal("scout").optional(), meta: ScoutMeta.optional() }),
  // Up to 8000: Write's "+ New" takes whole notes or drafts (2026-09-24);
  // the search box keeps its own 2000 cap (api/search).
  z.object({ text: z.string().trim().min(1).max(8000) }),
]);
// Derived from the schema (rather than a hand-duplicated list) so this can't
// silently drift out of sync with idea_kind again the next time a kind is
// added — see db/schema.ts's ideaKind pgEnum.
const KindFilter = z.enum(ideaKind.enumValues);

/**
 * Resolves *how* the request is authorized, not just whether it is: only the
 * bearer-token path (external feeders, e.g. the private trend scout) may
 * claim `source`/`meta` on a captured idea. A logged-in browser session must
 * not be able to forge scout provenance/score just because it holds a valid
 * cookie, so callers need to distinguish the two success cases instead of
 * collapsing them into a single "authorized" boolean.
 */
async function authorized(request: Request): Promise<"token" | "session" | Response> {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && process.env.CAPTURE_TOKEN && safeEqual(bearer, process.env.CAPTURE_TOKEN)) {
    return "token";
  }
  const denied = await requireSession();
  return denied ?? "session";
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (auth instanceof Response) return auth;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  if ("url" in parsed.data && (parsed.data.source !== undefined || parsed.data.meta !== undefined) && auth !== "token") {
    return Response.json(
      { error: "source and meta may only be set by a bearer-token request" },
      { status: 400 },
    );
  }

  try {
    if ("text" in parsed.data) {
      const { idea } = await saveIdeaFromInput(db, { text: parsed.data.text });
      return Response.json({ idea }, { status: 201 });
    }

    // The body's meta wins on key collisions inside saveIdeaFromInput — that's
    // intended, since only a bearer-token request can set meta at all (see
    // authorized() above). In practice it never actually collides today:
    // enrich() doesn't produce score/topic keys (see lib/enrich.ts's
    // Enriched shape/tests).
    const { idea, existing } = await saveIdeaFromInput(db, {
      url: parsed.data.url,
      source: parsed.data.source,
      meta: parsed.data.meta,
    });
    return existing
      ? Response.json({ idea, existing: true }, { status: 200 })
      : Response.json({ idea }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const kindParam = new URL(request.url).searchParams.get("kind");
  let kind: z.infer<typeof KindFilter> | undefined;
  if (kindParam !== null) {
    const parsedKind = KindFilter.safeParse(kindParam);
    if (!parsedKind.success) return Response.json({ error: "invalid kind" }, { status: 400 });
    kind = parsedKind.data;
  }

  try {
    const rows = kind
      ? await db.select().from(ideas).where(eq(ideas.kind, kind)).orderBy(desc(ideas.createdAt))
      : await db.select().from(ideas).orderBy(desc(ideas.createdAt));
    return Response.json({ ideas: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
