import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { enrich, type Enriched } from "@/lib/enrich";
import { saveIdeaFromInput } from "@/lib/ideas";
import { deriveQuery, queryFromUrlSlug, seedTextFromEnriched } from "@/lib/query";
import { runScoutSearch } from "@/lib/scout-run";
import { SEARCH_STEPS_TYPE, type SearchStep } from "@/lib/search-steps";
import { requireSession } from "@/lib/session";

// Bluesky/HN fetches (8s timeout each, in parallel) plus Jev judging
// (chunked systemOne calls) can run long on a big candidate pool — see
// lib/scout-run.ts. 30s covers that inline, synchronous round trip.
export const maxDuration = 60; // scout rounds may run up to TIME_BUDGET_MS (40s) + one last round; see lib/scout-run.ts

const Body = z.object({
  input: z.string().min(1).max(2000),
  mode: z.enum(["trends", "videos"]).optional(),
});

const LOOKS_LIKE_URL = /^https?:\/\//i;

type Outcome = { status: number; body: Record<string, unknown> };

/**
 * Search-first Find Ideas: a pasted seed (X post link, article link, raw
 * idea, or — in Videos mode — a YouTube link) becomes a saved idea card AND
 * runs the scout inline, in the same request (M1.5 final design — free open
 * sources, Jev-judged, no job queue; see
 * docs/specs/2026-09-19-postecho-design.md §11 item 2). The seed
 * text (from the url's enrichment, or the raw text itself) both feeds
 * `deriveQuery` for the sources' search query and serves as Jev's judging
 * topic (the fuller text gives Jev more to judge relevance against than the
 * short keyword query alone). `onStep` hears it move on.
 */
async function search(input: string, mode: "trends" | "videos" | undefined, onStep?: (step: SearchStep) => void): Promise<Outcome> {
  const isUrl = LOOKS_LIKE_URL.test(input);
  if (mode === "videos" && !isUrl) return { status: 400, body: { error: "paste a YouTube link" } };

  try {
    let seedText: string;
    let enriched: Enriched | undefined;
    if (isUrl) {
      onStep?.({ step: "reading" });
      enriched = await enrich(input);
      if (mode === "videos" && enriched.kind !== "youtube") return { status: 400, body: { error: "paste a YouTube link" } };
      seedText = seedTextFromEnriched(enriched, input);
    } else {
      seedText = input;
    }

    // A url seed with nothing enrichable (no title/content, so seedText IS
    // the bare url) can leave deriveQuery with nothing to work with — mine
    // the url's own path slug as a last resort. If even that yields nothing,
    // refuse instead of scouting an empty query (live, 2026-09-23: a bare
    // slug searched "html" and filled Trends with noise): nothing is saved.
    const query = deriveQuery(seedText) || (isUrl ? queryFromUrlSlug(input) : "");
    if (!query) {
      return { status: 422, body: { error: "Couldn't read anything to search from that. Paste the text you care about instead." } };
    }

    // Pass the already-fetched `enriched` through so saveIdeaFromInput
    // doesn't hit the same oEmbed/OG endpoint a second time (same
    // one-fetch-per-request shape as app/api/videos/route.ts).
    const { idea, existing } = await saveIdeaFromInput(
      db,
      isUrl ? { url: input, enriched } : { text: input },
    );
    // The words it was searched with (2026-09-24): the topic chips show them,
    // and GET /api/searches pairs each chip with what the owner typed.
    await db.update(ideas).set({ meta: { ...idea.meta, searchQuery: query } }).where(eq(ideas.id, idea.id));
    const scout = await runScoutSearch(db, { query, judgeTopic: seedText, seedIdeaId: idea.id }, { onStep });

    return { status: 201, body: { idea, existing, query, scout } };
  } catch (e) {
    console.error(e);
    return { status: 500, body: { error: "internal error" } };
  }
}

/**
 * POST /api/search. Asked with `Accept: application/x-ndjson` (Find Ideas'
 * search, lib/search-steps.ts's postSearch), it streams each step as it
 * happens, one JSON line `{ step }` each, and ends with `{ done: { status,
 * body } }`, the answer it would otherwise give (owner, 2026-09-27: "lo
 * dividerei a step quando questi succedono"). Otherwise it answers once, as
 * it always has.
 */
export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  const input = parsed.data.input.trim();
  const mode = parsed.data.mode;

  if (!request.headers.get("accept")?.includes(SEARCH_STEPS_TYPE)) {
    const { status, body } = await search(input, mode);
    return Response.json(body, { status });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      const done = await search(input, mode, (step) => send({ step }));
      send({ done });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": `${SEARCH_STEPS_TYPE}; charset=utf-8`, "Cache-Control": "no-store" } });
}
