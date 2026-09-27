import { checkSlop, type JevClient, type SlopCheck } from "jev-judge";
import { jevClient } from "@/lib/connections";
import { eq } from "drizzle-orm";
import { drafts } from "@/db/schema";
import type { db as Db } from "@/db";

export type SlopDeps = { jev?: JevClient };

let deps: SlopDeps = {};

/**
 * Test-only override hook for the Jev client. DI in the same spirit as
 * lib/scout-run.ts's `deps.jev` parameter, but as a module-level setter:
 * unlike runScoutSearch, the slop-check route builds its client itself
 * (so it can 503 when TYPESAFE_API_KEY is unset) rather than receiving one
 * from a caller, so there's no natural per-call `deps` argument for tests
 * to thread a fake client through instead. Tests call
 * `setSlopDeps({ jev: fakeClient })` and reset with `setSlopDeps({})`
 * (e.g. in afterEach) to restore the default build-from-env behavior.
 */
export function setSlopDeps(next: SlopDeps): void {
  deps = next;
}

/**
 * Resolves the Jev client to use: the test-injected one if set, otherwise a
 * real one built from `TYPESAFE_API_KEY` — or `null` when neither is
 * available, so the route can respond 503 instead of calling jev-judge
 * with no key configured (this feature is optional/off-by-default per the
 * spec — see docs/specs/2026-09-19-postecho-design.md §11
 * item 3).
 */
export async function getSlopClient(db: typeof Db): Promise<JevClient | null> {
  if (deps.jev) return deps.jev;
  // The key pasted in the app, else the deployment's (lib/connections.ts).
  return jevClient(db);
}

export type SlopCheckInput = { text: string; platform?: "x" | "linkedin"; draftId?: string };

/**
 * Runs jev-judge's checkSlop and, when `draftId` is given and still points
 * at an existing draft, persists the verdict onto that draft's
 * `meta.slop` — merged with whatever else already lives in `meta` (e.g.
 * materialize.ts's `overLimit` flag), never replacing the whole column.
 * Silently skips persistence for an unknown/deleted draftId, same
 * tolerate-don't-crash spirit as materialize.ts's unknown-ideaId handling:
 * the slop check itself already ran and its result is still returned to
 * the caller either way.
 */
export async function runSlopCheck(
  db: typeof Db,
  client: JevClient,
  input: SlopCheckInput,
): Promise<SlopCheck> {
  const result = await checkSlop(client, { text: input.text, platform: input.platform });

  if (input.draftId) {
    const [draft] = await db.select({ meta: drafts.meta }).from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
    if (draft) {
      const at = new Date().toISOString();
      const verdict = { slopScore: result.slopScore, verdict: result.verdict, at };
      const byPlatform = (draft.meta.slopByPlatform ?? {}) as Record<string, unknown>;
      const meta = {
        ...draft.meta,
        slop: { platform: input.platform ?? "generic", ...verdict },
        // Per platform too (M3.7), so an X check never hides the LinkedIn score.
        ...(input.platform ? { slopByPlatform: { ...byPlatform, [input.platform]: verdict } } : {}),
      };
      await db.update(drafts).set({ meta }).where(eq(drafts.id, input.draftId));
    }
  }

  return result;
}
