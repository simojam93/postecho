# PostEcho M3 — Scheduling & Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a chosen post in Write, the owner can **Schedule** or **Post now**. Both platforms are human-in-the-loop by design (owner decision 2026-09-22: no LinkedIn developer app / Company Page): a few minutes before the slot ONE email arrives with a one-tap **Post on X** button (the official web intent) and/or a **Post on LinkedIn** button (LinkedIn's composer prefilled via `https://www.linkedin.com/feed/?shareActive=true&text=<urlencoded>`), each with its own **Mark as posted** link. The **Plan** tab shows the calendar of what is queued, emailed, posted by hand, or failed. Automatic LinkedIn publishing through the official API stays possible later as an optional P4.

**Architecture:** No browser automation, no unofficial API — spec §6.3 and the compliance line stand. Everything runs on Vercel and works with the Mac off:
- `scheduled_posts` (exists since M1) is the queue: one row per (draft, platform, publishAt) with `status` queued → emailed | posted_manually | failed | cancelled (`published` is reserved for the optional API path).
- **Timer:** Upstash **QStash** (free tier: 500 messages/day) — when a post is scheduled, publish one QStash message with `notBefore = publishAt − lead` (both platforms) to `POST /api/publish/[scheduledPostId]`; QStash signs every delivery (verify with `@upstash/qstash`'s `Receiver`). Cancelling a schedule deletes the QStash message. Vercel Cron cannot do this on Hobby (daily granularity only).
- **Email (X and LinkedIn):** **Resend** (free tier: 3,000/month; the shared `onboarding@resend.dev` sender delivers only to the Resend account owner's address — `notificationEmail` is set to it; a verified domain would be needed to deliver elsewhere) → subject, the post text (with a copy affordance), a **Post on X** button (`https://x.com/intent/post?text=`) and/or a **Post on LinkedIn** button (`https://www.linkedin.com/feed/?shareActive=true&text=` — a public composer prefill, not an API; if LinkedIn ever drops it the composer just opens empty and the text is right there in the email), and one signed `Mark as posted` link per platform (HMAC of the id with `SESSION_SECRET`, no login needed from the phone). When X and LinkedIn are scheduled for the same slot the two rows share one email.
- **LinkedIn API (optional, deferred — P4):** OAuth 2.0 app the owner creates at linkedin.com/developers with products **Sign In with LinkedIn using OpenID Connect** + **Share on LinkedIn** (scopes `openid profile w_member_social`). Connect from Settings; store `access_token` (60-day lifetime, no refresh on the standard tier → Settings shows "reconnect by <date>") and the member `sub`/URN in `accounts`. Publish with `POST https://api.linkedin.com/rest/posts` (header `LinkedIn-Version: 202509`, `X-Restli-Protocol-Version: 2.0.0`, `author: urn:li:person:<id>`, `commentary`, `visibility: PUBLIC`, `distribution.feedDistribution: MAIN_FEED`, `lifecycleState: PUBLISHED`). Read the current LinkedIn docs before coding — versions rotate.
- **Publisher abstraction:** `web/src/lib/publishers/{x,linkedin}.ts` behind one `Publisher` interface (`composerUrl(text)`, `notify(...)`), so `POST /api/publish/[id]` is platform-agnostic; both current publishers are "email + composer link" — an API-backed LinkedIn publisher would drop in behind the same interface.
- **Dev without QStash/Resend/LinkedIn keys:** each integration is optional and degrades with a clear Settings status; `POST /api/scheduled-posts/[id]/run` (session) triggers a due post by hand, and the email body is logged instead of sent when `RESEND_API_KEY` is unset.

**Tech Stack:** existing (Next.js 16.3.5, Drizzle + PGlite tests, vitest 4, zod 4, Tailwind v4 tokens). New deps: `@upstash/qstash`, `resend`. Timezone: `Europe/Rome` for display and slot math, UTC in the DB.

**Owner inputs needed (all free):** Upstash account → QStash regional URL + token + current/next signing keys (received 2026-09-22, EU region); Resend API key; LinkedIn developer app → client id + secret, redirect `https://<vercel-domain>/api/linkedin/callback` (and `http://localhost:3210/api/linkedin/callback` for dev); `notificationEmail` already in Settings.

---

### Task P1: Schedule model + API + Write actions

**Files:** `web/src/db/schema.ts` (+ migration), `web/src/lib/schedule.ts` (+ test), `web/src/app/api/scheduled-posts/route.ts` (+ `[id]/route.ts`, `[id]/run/route.ts`, tests), `web/src/components/write/post-editor.tsx`, `web/src/app/api/settings/route.ts` (defaultSlots already exist)

- [ ] Schema: confirm `scheduled_posts` columns — `id, draftId (FK), platform ('x'|'linkedin'), publishAt (timestamptz), status (queued|emailed|published|posted_manually|failed|cancelled), externalId (QStash messageId), publishedUrl, error, emailedAt, publishedAt, createdAt, updatedAt`; add what is missing in one migration (0009).
- [ ] `schedule.ts`: `suggestSlots(db, from, days)` — next free default slots (Settings `defaultSlots` per platform, `Europe/Rome`) minus already-scheduled ones; `createSchedule(db, {draftId, platform, publishAt})` (draft must have text for that platform; X text ≤ 280); `cancelSchedule`; `listSchedules({from, to, status})`.
- [ ] API: `GET /api/scheduled-posts?from&to` → `{ posts }` joined with draft text; `POST /api/scheduled-posts` `{ draftId, platform, publishAt }` → 201 (and enqueue the QStash message when configured — see P2; `externalId` stored); `DELETE /api/scheduled-posts/[id]` → cancelled (+ QStash delete); `POST /api/scheduled-posts/[id]/run` (session) → runs the publish step now (dev/manual). `GET /api/scheduled-posts/slots?platform=` → suggestions.
- [ ] Write: **Schedule** opens a small sheet: platform toggles (X / LinkedIn, enabled only where the draft has text), datetime input prefilled with the next suggested slot per platform, "Suggested: 10:00 · 17:00 · 23:00" chips, confirm → one schedule per platform; the draft becomes `used`. **Post now**: X → open `x.com/intent/post?text=` in a new tab; LinkedIn → open `linkedin.com/feed/?shareActive=true&text=` in a new tab; each followed by a **Mark as posted** button (creates a `posted_manually` row with `publishAt = now`).
- [ ] Tests on PGlite for schedule.ts and the routes (auth, validation, 280 cap, cancel, slots math around midnight and DST).
- [ ] Commit `feat: schedules — model, api, write actions`.

### Task P2: QStash timer + publish webhook

**Files:** `web/src/lib/qstash.ts` (+ test with fake client), `web/src/app/api/publish/[id]/route.ts` (+ test), `web/src/lib/publishers/index.ts`, `web/.env.example`, `web/src/proxy.ts` (public path `/api/publish`)

- [ ] `qstash.ts`: `scheduleMessage({ url, notBefore, body })` / `deleteMessage(id)` using `@upstash/qstash` `Client` when `QSTASH_TOKEN` is set, else a `disabled` no-op that returns `null` (Settings shows "timer off — scheduled posts must be run by hand").
- [ ] `POST /api/publish/[id]`: verify the QStash signature (`Receiver` with `QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`; 401 otherwise) **or** accept a valid session (the `/run` route calls the same handler); idempotent: a row not in `queued` returns 200 with its current status; X → send the email (P3) and set `emailed`; LinkedIn → publish (P4) and set `published` + `publishedUrl`; failures set `failed` + `error` (QStash retries only on 5xx — return 200 after recording a failure so it does not retry forever; return 500 only on transient infra errors).
- [ ] Env: `QSTASH_URL` (regional endpoint — the owner's token is EU-scoped: `https://qstash-eu-central-1.upstash.io`; pass it as the client's `baseUrl`, the SDK otherwise targets the global endpoint and the token is rejected), `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `PUBLIC_BASE_URL` (the deployment URL QStash must call).
- [ ] Commit `feat: qstash timer and publish webhook`.

### Task P3: due-post email (Resend) with X + LinkedIn buttons + mark as posted

**Files:** `web/src/lib/publishers/x.ts` (+ test), `web/src/lib/email.ts` (+ test), `web/src/app/api/mark-posted/route.ts` (+ test), `web/src/app/mark-posted/page.tsx`

- [ ] `email.ts`: `sendMail({to, subject, html, text})` via `resend` when `RESEND_API_KEY` is set (from `onboarding@resend.dev` unless `RESEND_FROM` is set); otherwise log the rendered text and return `{ sent: false }`.
- [ ] `publishers/x.ts`: build the intent URL (`https://x.com/intent/post?text=`, text URL-encoded, refuse > 280 chars), the signed mark-posted link (`/mark-posted?id=&sig=`; HMAC-SHA256 over the id with `SESSION_SECRET`, `safeEqual` compare), and the email (dark, minimal, one big **Post on X** button, the post text in a preview card, the mark-posted link, the scheduled time in `Europe/Rome`). Subject: `Post on X at 17:00 — "<first 40 chars>"`.
- [ ] `GET /api/mark-posted?id&sig` → validates, sets `posted_manually` + `publishedAt`, redirects to `/mark-posted?ok=1` (a tiny public page: "Marked as posted ✓"). Public path in `proxy.ts`. Invalid sig → 404.
- [ ] Lead time from Settings `leadTimeMinutes` (default 5) is applied when scheduling (P1/P2), not here.
- [ ] Commit `feat: x email with web intent and mark-as-posted`.

### Task P4 (OPTIONAL, deferred by the owner on 2026-09-22): LinkedIn connect + API publish

**Files:** `web/src/lib/linkedin.ts` (+ test with fake fetcher), `web/src/app/api/linkedin/{connect,callback,disconnect}/route.ts` (+ tests), `web/src/lib/publishers/linkedin.ts` (+ test), `web/src/app/(authed)/settings/page.tsx`, `web/src/proxy.ts` (public `/api/linkedin/callback`)

- [ ] OAuth: `/api/linkedin/connect` (session) → redirect to LinkedIn authorize with `state` stored in a short-lived signed cookie; `/api/linkedin/callback` → exchange code, fetch `/v2/userinfo` (`sub`, name, picture), store in `accounts` (`provider linkedin`, `accessToken`, `expiresAt`, `externalId = sub`, `displayName`); `/api/linkedin/disconnect`. Env: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `PUBLIC_BASE_URL`.
- [ ] `publishers/linkedin.ts`: `publish({ text })` → `POST /rest/posts` as above; map 401/403 to "reconnect LinkedIn"; return `{ url }` built from the returned `x-restli-id` (`https://www.linkedin.com/feed/update/<urn>`).
- [ ] Settings: "LinkedIn: connected as <name> · expires <date> · Disconnect" or a **Connect LinkedIn** button; a warning when < 7 days to expiry.
- [ ] Commit `feat: linkedin connect and publish`.

### Task P5: Plan tab

**Files:** `web/src/app/(authed)/plan/page.tsx`, new `web/src/components/plan/{month-grid,day-list,schedule-card}.tsx`

- [ ] Month grid (`Europe/Rome`, Monday first) with dots per day colored by status; click a day → day list: default slots as rows (empty slot shows **+** → `/create?ideaId=…` is not right here: **+** opens Write's Schedule sheet needs a post, so instead **+** links to `/create` with `?slot=<iso>` prefilled for the next Schedule action), scheduled cards with platform pill, time, text preview, status badge (queued / emailed / published / posted manually / failed / cancelled), and actions: **Cancel** (queued), **Resend email** (X emailed/failed), **Retry** (failed LinkedIn), **Open** (publishedUrl), **Mark as posted** (X).
- [ ] Empty state: "Nothing scheduled — pick a post in Write and press Schedule."
- [ ] Mobile: month grid compact, day list full width.
- [ ] Commit `feat: plan tab`.

### Task P6: Docs + deploy checklist

**Files:** `docs/specs/2026-09-19-postecho-design.md` §6.3/§8, `web/.env.example`, `README.md`

- [ ] Spec: confirm §6.3 matches what shipped (QStash, Resend test sender, LinkedIn 60-day token), update the availability matrix §8.
- [ ] `.env.example` and README: the full Vercel env list (ADMIN_PASSWORD, SESSION_SECRET, CAPTURE_TOKEN, AGENT_TOKEN, CRON_SECRET, TYPESAFE_API_KEY, BLUESKY_*, PRODUCTHUNT_TOKEN, YOUTUBE_API_KEY, QSTASH_*, RESEND_API_KEY, LINKEDIN_*, PUBLIC_BASE_URL, DATABASE_URL) and the order of first-run steps.
- [ ] Commit `docs: m3 publishing`.

---

## Self-review checklist
X never automated (email + official intent only) ✓ · LinkedIn only via official API with the owner's OAuth grant ✓ · works with the Mac off (QStash + Vercel) ✓ · every integration optional in dev with a visible status ✓ · webhook signature-verified, mark-as-posted link signed ✓ · timezone handled once (Europe/Rome display, UTC storage) ✓ · tests ≥ current count, eslint + tsc clean.
