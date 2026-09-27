import { db } from "@/db";
import { runScoutSearch, type ScoutRunSummary } from "@/lib/scout-run";
import { requireSession } from "@/lib/session";
import { getSetting } from "@/lib/settings";

// Up to 20 topics (Settings caps it there), each its own inline scout run —
// see lib/scout-run.ts's own maxDuration comment for why a single run can
// already take a while.
export const maxDuration = 60;

/**
 * "Search my topics": runs the same inline scout as a Search, once per
 * configured Settings topic, sequentially — one already-slow/rate-limited
 * topic shouldn't make every topic's Bluesky/HN/Jev calls land on the free
 * APIs at once.
 */
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;

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
