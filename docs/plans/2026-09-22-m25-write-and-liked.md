# PostEcho M2.5 — Write & Liked (Find Ideas / Create redesign) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the two working tabs around how the owner actually uses them (owner direction, 2026-09-22): Find Ideas gets a permanent **Liked** shelf next to the disposable **Trends** and **Videos** views, and Create becomes **Write** — one post at a time, entered by pressing **Use** on an idea.

**Architecture:** No schema change. Ideas keep their statuses (`new` = Trends/Videos, `kept`/`used` = Liked, `archived`/`dismissed` = gone). Drafts keep theirs: `candidate` = a take Claude proposed, `kept` = the take the owner picked (the post in progress), `discarded` = hidden, `used` = published (M3). Write is a new single-post page over the existing drafts API; the current two-column Create list goes away.

**Tech Stack:** Existing PostEcho stack (Next.js 16.3.5 App Router, Drizzle + PGlite tests, vitest 4, zod 4, Tailwind v4 tokens). Design language unchanged: dark, silver accent, pill buttons, X-style preview cards.

**Owner's words (keep them in mind):** "trends e videos fanno la parte operativa e devono essere rapidamente ripulibili, liked rimangono quelli di valore" · "in create lavori sempre ad un post per volta se clicchi use in find ideas" · "togli anche le note dalla pagina find ideas".

---

### Task W1: Find Ideas — Liked view, disposable Trends, no notes

**Files:** `web/src/app/(authed)/page.tsx`, `web/src/components/idea-card.tsx`, `web/src/components/searches-strip.tsx` (wire `onDeleted`), `web/src/app/api/ideas/clear/route.ts` (+ test)

- [ ] Mode switch becomes three pills: **Trends · Videos · Liked** (same pill style as today's Trends/Videos).
- [ ] **Trends** shows only `status === "new"` scout results whose `kind` is neither `youtube` nor `note` (owner: notes and search seeds are not results). Source filter row and query chips count the same subset. ♥ sets `kept` and the card leaves Trends immediately (optimistic update).
- [ ] **Liked** shows `status in ("kept","used")`, newest `updatedAt` first, every kind except `note`; ♥ is filled and toggles back to `new` (returns to Trends); a `used` idea shows a small "used" badge and keeps **Use** enabled (re-generating takes is allowed). Liked ignores the query chips and source filters; it has its own tiny count in the pill ("Liked · 7").
- [ ] Deleting a search chip (`DELETE /api/searches`, already implemented) never touches Liked — add a note in the strip's confirm text: "Liked items are kept."
- [ ] **Clear all** pill on Trends (right of the mode switch): confirm, then `POST /api/ideas/clear` → archives every `status = "new"` scout idea (`source = "scout"`, kind ≠ youtube). When a query chip is selected, the button reads "Clear this search" and calls `DELETE /api/searches?query=` instead. Reload ideas + chips afterwards.
- [ ] `SearchesStrip` `onDeleted` → page reloads ideas.
- [ ] Tests: route test for `POST /api/ideas/clear` (archives only new scout ideas; leaves kept/used/dismissed and manual seeds alone; 401 without session). Keep `web/src/app/api/ideas/ideas.test.ts` green.
- [ ] Commit: `feat: liked shelf, disposable trends, notes hidden`.

### Task W2: Write — data helpers

**Files:** `web/src/lib/drafts.ts` (+ test), `web/src/app/api/drafts/route.ts` (+ test)

- [ ] `listPostsInProgress(db)`: one entry per `ideaId` that has at least one draft with status `kept` or `candidate`, newest first: `{ ideaId, idea (title/url/kind), chosenDraftId | null, takeCount, latestJobStatus }`. Drafts with `ideaId = null` (none today) go under a single "Other" entry.
- [ ] `GET /api/drafts?view=in-progress` returns that list (session). Existing `GET /api/drafts?ideaId=&status=` stays for the takes and the chosen post.
- [ ] Picking a take: `PATCH /api/drafts/:id { status: "kept" }` (exists). Picking a different take later sets the previous chosen one back to `candidate` — do this client-side with two PATCHes (no new endpoint), and document it in the component.
- [ ] Tests for the helper on PGlite (grouping, ordering, chosen detection, job status).
- [ ] Commit: `feat: posts-in-progress listing for write`.

### Task W3: Write page

**Files:** `web/src/app/(authed)/create/page.tsx` (rewrite; route path stays `/create`), `web/src/components/nav.tsx` (label "Write"), new `web/src/components/write/{in-progress-strip,source-card,takes-row,post-editor}.tsx`; delete `web/src/components/draft-list.tsx` (reuse `draft-editor.tsx` internals for the editor; keep `slop-badge.tsx`, `poll-job.ts`)

- [ ] `/create?ideaId=<id>` opens that idea's post; `/create` with no param opens the most recent post in progress, or the empty state: "Nothing in progress — press Use on an idea in Find Ideas."
- [ ] **In progress strip** (top): one chip per idea from `?view=in-progress`, label = idea title/excerpt (clamped), a dot when a generation job is queued/claimed; the current one highlighted; click switches `?ideaId=`.
- [ ] **Source card**: the idea rendered like a Find Ideas card (source pill, author, text clamped with "more", open ↗). For a video: title + link.
- [ ] **Takes row**: the idea's `candidate` drafts as compact X-style preview cards side by side (horizontal scroll on phone) with **Pick this**; the chosen (`kept`) one is highlighted "Chosen". While `latestJobStatus` is queued/claimed and no takes exist: "Claude is writing your take on this…" (poll `/api/jobs?ideaId=` every 3s, then reload takes). Failed job: error text + the video "paste transcript" affordance where applicable (reuse from `generate-posts-panel.tsx`). **More takes** pill → `POST /api/drafts/from-idea { ideaId, count: 3 }` (or `/api/videos` for a video) → polling as above.
- [ ] **Post editor** (below, only when a take is chosen): X textarea with `n/280` counter (danger over 280), LinkedIn textarea, autosave on blur, "Unsaved" hint; actions: **Refine** (inline instruction → `/revise` → "Claude is rewriting…" → the revision replaces the chosen take: PATCH old chosen → `candidate`, new revision is already `kept`, show "v2 · back to v1" link), **Image prompt**, **Slop check** per platform (badge `verdict · slop N/100`), **★ favorite**, **Discard take** (→ `discarded`, hides it), **Schedule** / **Post now** disabled "arrives with M3".
- [ ] Mobile: single column, takes row scrolls horizontally, editor full width.
- [ ] Commit: `feat: write page (one post at a time)`.

### Task W4: Entry points

**Files:** `web/src/app/(authed)/page.tsx`, `web/src/components/generate-posts-panel.tsx`, `web/src/components/idea-card.tsx`

- [ ] **Use** on any card (Trends, Videos, Liked): `POST /api/drafts/from-idea` then `router.push('/create?ideaId=')` (exists for Trends; make sure Liked cards do the same and the idea stays in Liked as `used`).
- [ ] Videos: **Generate** (`POST /api/videos`) → `router.push('/create?ideaId=')`; the panel's inline job status/candidates link can go (Write shows them).
- [ ] Commit: `feat: use and generate land on write`.

### Task W5: Docs

**Files:** `docs/specs/2026-09-19-postecho-design.md` §4

- [ ] Update §4: Find Ideas = Trends · Videos · Liked (definitions above), search result rule = best 20 across all sources with ✦ rank ≥ 60 and rounds, notes never shown; Create = Write, one post at a time, takes, in-progress strip. Mark the old Create list description as superseded.
- [ ] Commit: `docs: spec §4 for write and liked`.

---

## Self-review checklist
- Liked never affected by chip deletion or Clear all ✓ (W1 tests). Notes hidden everywhere in Find Ideas ✓. One post at a time; alternatives remain as takes ✓. No schema change ✓. Existing agent protocol untouched ✓ (only web routes/UI). Tests ≥ current count, eslint + tsc clean.
