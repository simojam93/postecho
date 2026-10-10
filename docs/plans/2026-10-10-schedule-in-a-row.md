# Schedule in a row Implementation Plan

**Goal:** Compose many posts, mark them Ready, then schedule them all in one sitting from Schedule (Calendar
renamed), one platform composer after the other.

**Architecture:** A nullable `drafts.readyAt` (migration 0016). Ready and Back to Compose go through the existing
`PATCH /api/drafts/:id` (`ready: boolean`). The ready list is its own route, `GET /api/drafts/ready` (the drafts
route's `view=` comment says a second view moves to its own route). Proposed times come from a pure
`lib/schedule-queue.ts` built on plan-calendar.ts's client-safe Rome wall clock. The guided sequence reuses
schedule-dialog.tsx's `openComposer`, its how-to line and a shared `recordSchedule` (the mark-posted call), which
the single-post window now uses too. Recording every platform of a ready post clears `readyAt`
(lib/schedule.ts's markPostedManually).

Spec: `docs/specs/2026-10-10-schedule-in-a-row-design.md`.

Every task: failing test first, see it fail, implement, see it pass, one commit.

---

### Task 1: Calendar becomes Schedule

**Files:** `web/src/components/nav.tsx`, `web/src/components/plan/plan-view.tsx` (heading),
`web/src/components/onboarding/welcome.tsx` (loop, step page), `web/src/components/write/schedule-dialog.tsx`,
`web/src/components/write/post-editor.tsx`, `web/src/components/archive.tsx`, `web/src/app/post/[id]/*`,
`web/src/app/mark-posted/confirm-button.tsx`, `web/src/components/settings/settings-panel.tsx`, `lib/schedule.ts`
error copy, `README.md`, `docs/case-study.md`. Route stays `/calendar`.

**Tests:** `nav.test.ts` (Schedule, no Calendar), `welcome.test.ts` (loop and step page say Schedule),
`schedule-dialog.test.ts`, `archive.test.ts` (See in Schedule).

### Task 2: drafts.readyAt

**Files:** `web/src/db/schema.ts`, `web/drizzle/0016_*.sql` + meta (drizzle-kit generate),
`web/src/components/write/types.ts` (`readyAt?`).

**Tests:** `drafts.test.ts`: a draft row has `readyAt: null` by default (fails before the migration).

### Task 3: Ready, Back to Compose, the ready list, and scheduling clears it

**Files:** `web/src/app/api/drafts/[id]/route.ts` (`ready`), `web/src/app/api/drafts/ready/route.ts` (new),
`web/src/lib/drafts.ts` (`listReadyPosts`, in-progress excludes ready ideas), `web/src/lib/schedule.ts`
(markPostedManually clears `readyAt` once every platform with text is recorded).

**Tests:** `drafts.test.ts`: PATCH `{ ready: true }` sets it and `{ ready: false }` clears it; an article can't be
made ready (409); the in-progress view leaves a ready post out; `GET /api/drafts/ready` lists ready posts oldest
ready first with the platforms still to schedule, without articles; `scheduled-posts.test.ts`: recording X only of
an X+LinkedIn ready post keeps it ready with LinkedIn left, recording both clears it.

### Task 4: Proposed times

**Files:** `web/src/lib/schedule-queue.ts` (new): `proposeTimes`, `queueOrder`.

**Tests:** `schedule-queue.test.ts`: first free slots from now, skipping slots taken on that platform, one post
per slot, a changed time stays put and moves no other, no posting times falls back to the next full hours,
canceled posts don't take a slot, rows ordered by time.

### Task 5: Shared single-post pieces

**Files:** `web/src/components/write/schedule-dialog.tsx`: export `howTo`, add `recordSchedule` (time check +
mark-posted POST) and use it in `ScheduleDialog`.

**Tests:** `schedule-dialog.test.ts`: `recordSchedule` posts `{ draftId, platform, publishAt }`, refuses a past or
empty time without a request, returns the server's error.

### Task 6: Ready in Compose

**Files:** `web/src/components/write/post-editor.tsx` (Ready by Schedule; Back to Compose on a ready post),
`web/src/app/(authed)/create/page.tsx` (after Ready, on to the next post, with a status line linking to Schedule).

**Tests:** `post-editor.test.ts`: Ready next to Schedule, disabled without text; a ready post shows Back to
Compose instead.

### Task 7: Ready to schedule in Schedule

**Files:** `web/src/components/plan/ready-list.tsx` (new), `web/src/components/plan/plan-view.tsx` (fetches
`/api/drafts/ready` and the coming scheduled posts, keeps changed times, mounts the list on top).

**Tests:** `ready-list.test.ts`: hidden when empty; each row the post's start linking to Compose, its platforms,
its time input; rows in time order; Schedule all.

### Task 8: Schedule all

**Files:** `web/src/components/plan/schedule-all.ts` (pure steps and reducer), `web/src/components/plan/schedule-all-dialog.tsx`
(the window), wiring in `plan-view.tsx` (refetch and jump to the first new day at the end).

**Tests:** `schedule-all.test.ts`: steps for X only, LinkedIn only, both; open then record moves on; Skip goes to
the next post; Stop ends; the end counts what was scheduled. Render: "Post 2 of 6", Open X, Scheduled for, the
end's "N scheduled" and its week.

### Finish

`cd web && npx vitest run`, `npx tsc --noEmit`, `npm run build`; `cd agent && npx vitest run`.
