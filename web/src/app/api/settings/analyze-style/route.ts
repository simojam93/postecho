import { db } from "@/db";
import { jobs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { inspirationForAnalysis } from "@/lib/library";
import { getSetting } from "@/lib/settings";
import { jobCreated } from "@/lib/job-header";

const MIN_TOTAL_EXAMPLES = 3;

/**
 * Counts non-empty example "blocks" in a tone-examples textarea — posts
 * separated by one or more blank lines, the same convention the agent's
 * systemPrompt() uses to pick the first 3 examples per platform (see
 * docs/plans/2026-09-21-m2-agent-generation.md task B5). Used
 * here only to gate "Analyze my posts" on having enough signal — the full
 * text is sent to the job either way, uncapped/unsplit.
 */
function countExampleBlocks(text: string): number {
  return text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0).length;
}

/**
 * POST /api/settings/analyze-style
 *
 * The Settings "Analyze my posts" button (M2 plan task A7): enqueues an
 * `analyze_style` job so the agent can draft a compact markdown style guide
 * from the owner's saved tone examples + style form (see materialize.ts's
 * materializeStyleGuide, which writes the result back onto the `styleGuide`
 * setting once the job completes — the Settings page then polls this job
 * and reloads settings to pick it up). Requires at least 3 example posts
 * across both platforms combined: fewer gives Claude too little signal to
 * imitate a voice from (spec's "Tone-of-voice setup" calls for 5-15).
 */
export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const [toneExamplesX, toneExamplesLinkedin, toneForm, styleInspiration] = await Promise.all([
      getSetting(db, "toneExamplesX"),
      getSetting(db, "toneExamplesLinkedin"),
      getSetting(db, "toneForm"),
      getSetting(db, "styleInspiration"),
    ]);

    // The owner's own posts, or posts by others they learn from (the style
    // inspiration list, 2026-09-24) — three of either are enough to analyze.
    const inspiration = inspirationForAnalysis(styleInspiration);
    const totalExamples = countExampleBlocks(toneExamplesX) + countExampleBlocks(toneExamplesLinkedin);
    if (totalExamples < MIN_TOTAL_EXAMPLES && inspiration.length < MIN_TOTAL_EXAMPLES) {
      return Response.json({ error: "add a few example posts first, or three posts to learn style from" }, { status: 400 });
    }

    const [job] = await db.insert(jobs).values({
      kind: "analyze_style",
      payload: { toneExamplesX, toneExamplesLinkedin, toneForm, inspiration },
    }).returning();

    return jobCreated({ job }, job.id);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
