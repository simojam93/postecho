# M1.5-A — Scout Touchpoints (public repo) Implementation Plan

> **SUPERSEDED (2026-09-21):** the browser-based private worker was abandoned; the scout now runs server-side against free open APIs (spec §11 M1.5). The enqueue/cron touchpoints below were implemented and later replaced by inline search execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PostEcho the compliant, public-safe hooks the private trend scout plugs into: on-demand and daily scout-job enqueueing, scout-aware idea capture, and score badges on Trends cards.

**Architecture:** Everything here is inert without an external worker: two enqueue paths insert a `scout` job (topics snapshotted in the payload, deduped), the existing bearer-token capture endpoint learns to accept `source`/`meta`, and the Trends UI renders what arrives. No browser automation, no X API — this repo stays 100% ToS-clean.

**Tech Stack:** Existing PostEcho stack (Next.js 16.3.5, Drizzle, vitest + PGlite, zod 4).

**Scope guard:** only the touchpoints are in this plan; the scout itself and its Jev calls came in later M1.5 plans (spec §11 M1.5), and X is only ever read through its official API.

---

### Task A1: Scout job enqueue helper + `POST /api/scout-now`

**Files:**
- Create: `web/src/lib/scout.ts`, `web/src/lib/scout.test.ts`, `web/src/app/api/scout-now/route.ts`

- [ ] **Step 1: Failing tests**

`web/src/lib/scout.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { jobs } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));

const { enqueueScoutJob } = await import("@/lib/scout");
const { setSetting } = await import("@/lib/settings");

beforeEach(async () => { state.db = await createTestDb(); });

describe("enqueueScoutJob", () => {
  it("creates a scout job with topics snapshot", async () => {
    await setSetting(state.db as never, "topics", ["ai audio", "indie saas"]);
    const r = await enqueueScoutJob(state.db as never);
    expect(r.enqueued).toBe(true);
    const rows = await state.db!.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("scout");
    expect(rows[0].payload).toMatchObject({ topics: ["ai audio", "indie saas"] });
  });

  it("dedupes while a scout job is queued or claimed", async () => {
    await setSetting(state.db as never, "topics", ["ai"]);
    await enqueueScoutJob(state.db as never);
    const r2 = await enqueueScoutJob(state.db as never);
    expect(r2.enqueued).toBe(false);
    expect(await state.db!.select().from(jobs)).toHaveLength(1);
  });

  it("refuses when no topics are configured", async () => {
    const r = await enqueueScoutJob(state.db as never);
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe("no topics configured");
  });

  it("enqueues again after the previous job finished", async () => {
    await setSetting(state.db as never, "topics", ["ai"]);
    await enqueueScoutJob(state.db as never);
    const [j] = await state.db!.select().from(jobs);
    await state.db!.update(jobs).set({ status: "done" }).where((await import("drizzle-orm")).eq(jobs.id, j.id));
    const r = await enqueueScoutJob(state.db as never);
    expect(r.enqueued).toBe(true);
  });
});
```

Run: FAIL (module missing). Then implement.

- [ ] **Step 2: Implement the helper**

`web/src/lib/scout.ts`:

```ts
import { and, inArray, eq } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import type { db as Db } from "@/db";

type EnqueueResult = { enqueued: boolean; reason?: string; jobId?: string };

export async function enqueueScoutJob(db: typeof Db): Promise<EnqueueResult> {
  const topics = await getSetting(db as never, "topics");
  if (!topics.length) return { enqueued: false, reason: "no topics configured" };

  const open = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, "scout"), inArray(jobs.status, ["queued", "claimed"])));
  if (open.length > 0) return { enqueued: false, reason: "scout already pending" };

  const [job] = await db
    .insert(jobs)
    .values({ kind: "scout", payload: { topics, requestedAt: new Date().toISOString() } })
    .returning();
  return { enqueued: true, jobId: job.id };
}
```

(Type note: follow the settings helpers' `PgDatabase` pattern if `typeof Db` fights the compiler; keep it cast-free like the heartbeat route.)

- [ ] **Step 3: `POST /api/scout-now`**

`web/src/app/api/scout-now/route.ts`:

```ts
import { db } from "@/db";
import { requireSession } from "@/lib/session";
import { enqueueScoutJob } from "@/lib/scout";

export async function POST() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    const r = await enqueueScoutJob(db);
    return Response.json(r, { status: r.enqueued ? 201 : 200 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
```

Add a route test in `scout.test.ts` (session mocked like the settings tests): 201 with topics set; 200 `{enqueued:false}` on the second call.

- [ ] **Step 4: Run tests, lint, commit**

`npm test` (report count), `npm run lint`. Commit: `feat: scout job enqueue helper and scout-now endpoint`.

---

### Task A2: Daily cron route + vercel.json

**Files:**
- Create: `web/src/app/api/cron/scout/route.ts`, `web/vercel.json`
- Modify: `web/.env.example`, `web/src/app/api/cron/scout/cron.test.ts` (new test file)

- [ ] **Step 1: Failing tests** — `cron.test.ts`: with `vi.stubEnv("CRON_SECRET", "s3cret")`: GET with `Authorization: Bearer s3cret` and topics set → 200 + job row; wrong/missing bearer → 401; unset CRON_SECRET env → 401 (fails closed).

- [ ] **Step 2: Implement**

```ts
import { db } from "@/db";
import { enqueueScoutJob } from "@/lib/scout";
import { safeEqual } from "@/lib/session";

export async function GET(request: Request) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const r = await enqueueScoutJob(db);
    return Response.json(r);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
```

`web/vercel.json`:

```json
{
  "crons": [{ "path": "/api/cron/scout", "schedule": "0 8 * * *" }]
}
```

(Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when the env var exists. Hobby allows daily crons; timing is approximate — fine, the job waits in queue for the worker anyway.)

`.env.example`: add `CRON_SECRET=` with a comment (`openssl rand -hex 24`; used by Vercel Cron to authenticate the daily scout enqueue).

- [ ] **Step 3: proxy check** — `/api/cron/scout` has no session cookie: the proxy returns 401 JSON for unknown `/api/*` paths without a cookie. Add `pathname === "/api/cron/scout"` to the public list in `web/src/proxy.ts` (its own bearer guard is the gate, same pattern as `/api/agent`). Add/extend a comment.

- [ ] **Step 4: tests green, lint, commit** — `fix: daily scout cron route`.

---

### Task A3: Scout-aware capture + Trends score badges

**Files:**
- Modify: `web/src/app/api/ideas/route.ts`, `web/src/app/api/ideas/ideas.test.ts`, `web/src/components/idea-card.tsx`, `web/src/app/(authed)/page.tsx`

- [ ] **Step 1: Failing tests** — extend `ideas.test.ts`:
  - bearer-token POST with `{url, source: "scout", meta: {score: 87, topic: "ai audio"}}` → 201, idea row has `source: "scout"` and `meta.score` 87 (merged with enrichment meta, enrichment values win on collision except score/topic which must survive).
  - SESSION-path POST with `source: "scout"` → 400 (only the bearer token may claim scout provenance).
  - bearer POST with out-of-range score (e.g. 101) → 400.

- [ ] **Step 2: Implement** — in `ideas/route.ts`: extend the url-branch body schema with optional `source: z.literal("scout")` and `meta: z.object({ score: z.number().min(0).max(100).optional(), topic: z.string().max(80).optional() }).optional()`; reject those fields unless the request was bearer-authenticated (track which auth path `authorized()` took — refactor it to return `"token" | "session" | Response`); on insert, spread `{...enriched.meta, ...bodyMeta}` and set `source`.

- [ ] **Step 3: UI** — `idea-card.tsx`: when `idea.meta.score` is a number, render a small badge `✦ {score}` (rounded-full border border-border px-2 text-xs text-text-dim) next to the author; when `idea.source === "scout"`, tooltip/label "scouted". `(authed)/page.tsx`: pass through (Idea type gains `source?: string`); in Trends mode add a "Get more" pill button beside the mode switch that POSTs `/api/scout-now`, shows the returned reason when `enqueued:false` ("scout already pending" / "no topics configured" — link to Settings in the second case), and a subtle "scout requested — the worker picks it up when your Mac is active" note on 201.

- [ ] **Step 4: tests green, lint, tsc, commit** — `feat: scout-aware capture and trends score badges`. Push.

---

## Self-review checklist
Spec coverage (spec §11 M1.5 public touchpoints): scout-now ✓ (A1), cron + CRON_SECRET + dedupe + topics snapshot ✓ (A1/A2), ideas source/meta for bearer callers ✓ (A3), Trends badges + Get more ✓ (A3). No automation code added ✓. Placeholders: none. Types consistent with existing schema/enums.
