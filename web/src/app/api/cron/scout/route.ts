import { db } from "@/db";
import { runScoutSearch, type ScoutRunSummary } from "@/lib/scout-run";
import { safeEqual } from "@/lib/session";
import { getSetting } from "@/lib/settings";

// See app/api/scout-now/route.ts's identical comment — one inline scout run
// per topic, sequentially.
export const maxDuration = 60;

/** The daily cron equivalent of "Search my topics" (POST /api/scout-now) — same inline runs, bearer-authenticated instead of session-authenticated. */
export async function GET(request: Request) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const topics = await getSetting(db, "topics");
    if (topics.length === 0) {
      return Response.json({ results: [], reason: "no topics configured" });
    }

    const results: ScoutRunSummary[] = [];
    for (const topic of topics) {
      results.push(await runScoutSearch(db, { query: topic, judgeTopic: topic }));
    }
    return Response.json({ results });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
