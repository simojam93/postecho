# PostEcho — v1 Design Spec

**Date:** 2026-09-19 (rev. 5: tab-based UI from owner's mockups, dark theme) · **Status:** draft for review · **Name:** PostEcho (final)

## 1. Overview

PostEcho turns YouTube videos and trending X posts into scheduled posts for X and LinkedIn. Pipeline:

**Find ideas → Create → Plan/Publish**

Design goals, in priority order:

1. **€0/month to run.** Free tiers plus resources the owner already pays for (Claude subscription).
2. **Fully compliant by construction.** No browser automation of any third-party site in this repo: LinkedIn publishes via its official free API; X publishing is **human-in-the-loop** — an email with an official X web-intent button arrives shortly before the scheduled time (one tap opens the X composer pre-filled), or the same intent link opens directly when publishing "now" from the app.
3. Cloud flows (LinkedIn publish, X email) never depend on the owner's Mac; generation runs free on the owner's Mac via their Claude subscription.
4. Usable from iPhone and Mac (PWA); open-source portfolio project.

Non-goals for v1 (§11): multi-user, any X automation, threads, in-app image generation, analytics.

## 2. Components

### 2.1 `postecho-web` — Vercel (always on, free)

Next.js (App Router, TypeScript) PWA on Vercel Hobby. Owns: data (Neon Postgres + Drizzle), schedule triggers (Upstash QStash), email (Resend), the UI, and the job queue the agent consumes.

### 2.2 `postecho-agent` — the owner's Mac (free, in this repo)

A TypeScript CLI daemon (launchd) that long-polls `postecho-web` for jobs and executes them locally via **Claude Code headless** (`claude -p`, the owner's subscription — no API key, no per-token cost). Jobs are typed and return structured JSON:

- `generate_from_video` — fetch the YouTube transcript locally (residential IP avoids datacenter blocks), generate N candidate posts per the tone profile + per-request instructions + language setting.
- `revise_draft` — rewrite one draft per a free-text instruction ("punchier", "shorter hook").
- `image_prompt` — produce an image-generation prompt from a post's text + the owner's saved image specs.
- `analyze_style` — draft the tone-of-voice style guide from the owner's example posts + form answers.

Heartbeat every 60s; single-job concurrency. Headless Claude Code is the sanctioned automation surface of the subscription — claude.ai is never automated in a browser. The protocol is worker-agnostic; future kinds (e.g. `scout`) can be served by other private workers.

## 3. Running costs

| Item | Cost |
|---|---|
| Vercel Hobby, Neon, QStash, Resend | free tiers |
| Generation (Claude Code headless, owner's subscription) | €0 extra (counts against plan limits) |
| X publishing (web intent, posted by the owner) | €0 |
| LinkedIn publishing (official API, `w_member_social`) | free |
| Images: prompt generated in-app, image made manually in nano banana | €0 |
| **Optional, off by default:** direct Anthropic API generation (Mac-off generation) | ~$0.03/video |
| **Future, optional:** Gemini API for one-click image generation | free-tier quota when available, else ~$0.04/image |

## 4. UI

**Dark theme by default** (single dark palette in v1, design tokens ready for a light variant). Minimal, typographic, no mascots or illustration characters. UI copy in English. **Visual language (owner's direction, 2026-09-20):** near-black ground (#08080a), #f5f5f7 text, #7c7c86 dim gray, system font stack, tight bold headings, pill-shaped buttons — but with a **silver accent** (#e6e8ec); never orange. Four tabs (names provisional, owner may rename):

1. **Find Ideas** — **search-first (owner direction, 2026-09-20): the primary CTA is "Search".** Pasting a seed (X post link, article link, free-text idea) and pressing Search derives a keyword query and runs the server-side scout inline (spec §11 M1.5): the query is expanded into variants and fanned out to every enabled open source (Hacker News, Bluesky, arXiv, GitHub, Dev.to, Mastodon, Lobsters, Lemmy; YouTube, Reddit and Product Hunt with free keys), Jev judges every candidate, and the **best 20 across all sources with ✦ rank ≥ 60** are saved (owner direction, 2026-09-22: one global pool, "se 8 sono da HN anche meglio"). The scout keeps searching in rounds — more candidates and query variants each time — until it has 20 or runs out of candidates, rounds (4) or time (about 50s); the result line names how many strong matches were found and after how many candidates. Seeds and notes are saved for provenance but **never shown** in Find Ideas. Three shelves (owner direction, 2026-09-22 — "trends e videos fanno la parte operativa e devono essere rapidamente ripulibili, liked rimangono quelli di valore"):
   - **Trends:** the disposable inbox of new results, grouped under "recent searches" chips (each chip removable with ×, which archives that search's unreviewed results) with a source filter row. Cards render the post in X-post style: source pill, author, text, ✦ rank, link to original, plus ♥ / Dismiss / **Use**. **Clear all** archives every unreviewed result in one click. ♥ moves a card to Liked; Dismiss is a negative taste signal.
   - **Videos:** pasted YouTube videos not yet used. **Generate** (Instructions + language toggle: English default / video's original language + how many posts) enqueues generation and lands on Write.
   - **Liked:** the permanent shelf — everything ♥'d or Used. Never touched by chip removal or Clear all; a used idea stays here with a "used" badge and can be reused.
   - **Use** on any card starts generation for that idea and opens it in **Write**.
2. **Write** (tab formerly "Create") — **one post at a time** (owner direction, 2026-09-22). You arrive by pressing Use. Top to bottom: an **In progress** strip (one chip per idea you started, with a dot while Claude is writing); the **source** (the idea or video, rendered like its Find Ideas card); the **takes** Claude proposed (3 for an idea, 5 for a video) as X-style preview cards with the owner's name/handle/avatar — **Pick this** makes one the post, the others stay as alternatives, **More takes** asks for another batch; and, once a take is picked, the **post editor**: X text with 280-char counter and LinkedIn long-form, autosave, **Refine** ("make it punchier" → `revise_draft` → the revision replaces the chosen take, previous version one click away), **Image prompt** (`image_prompt` → copy for manual use in nano banana), **Slop check** per platform (Jev; badge `verdict · slop N/100`, lower is better), favorite, discard take. **Schedule** (per-platform datetime, suggested from free slots) and **Post now** (LinkedIn: immediate API publish; X: web-intent link + "mark as posted") arrive with M3.
3. **Plan** — calendar (month + day views) of scheduled posts with status colors (queued / emailed / published / posted manually / failed). Day view shows the owner's **default time slots** (from Settings, e.g. 10:00 / 17:00 / 23:00); a "+" on a slot opens Create with the datetime prefilled. Cancel/retry/resend-email from the card.
4. **Settings** — one-time setup: LinkedIn connect (OAuth), notification email, X email lead time (default 5 min), scout topics, default slots per platform, identity for previews (name, handle, avatar URL), **tone of voice**, **image specs** (style, format, avoid-list), agent status (heartbeat, pairing token), dry-run toggle.

### Tone-of-voice setup (Settings → Tone)

1. **Examples first:** paste 5–15 of the owner's best posts, separated per platform — the strongest signal.
2. **Style form:** language per platform, emoji policy, hashtag policy, preferred hook shapes (question / list / one-liner), CTA style, forbidden things.
3. **"Analyze my posts":** runs `analyze_style` → Claude drafts a compact markdown style guide from examples + form; the owner edits and saves it. Every generation/revision prompt then receives: style guide + 3 best examples + per-request instructions.
4. v1.5: ♥-saved candidates can be promoted to examples ("teach it your taste").

## 5. Data model

Neon Postgres, Drizzle schema:

- **`ideas`** — captured/scouted items and processed videos. `id`, `url`, `kind` (`x_post` | `youtube` | `article` | `note`), `title`, `content` (text/transcript cache), `author`, `meta` (jsonb: thumbnail, duration, score), `source` (`manual` | `scout`), `status` (`new` | `used` | `archived` | `dismissed`), `created_at`.
- **`drafts`** — candidate and edited posts. `id`, `idea_id` (nullable), `x_text`, `linkedin_text`, `status` (`candidate` | `kept` | `used` | `discarded`), `favorite` (bool), `parent_id` (nullable, revision chain), `image_prompt` (nullable), `created_at`, `updated_at`.
- **`scheduled_posts`** — `id`, `draft_id`, `platform` (`x` | `linkedin`), `text` (frozen), `scheduled_at`, `status` (`queued` | `published` | `emailed` | `posted_manually` | `failed` | `canceled`), `posted_by` (`api` | `manual`), `qstash_message_id`, `platform_post_id`, `error`, `published_at`.
- **`jobs`** — web↔agent contract. `id`, `kind` (`generate_from_video` | `revise_draft` | `image_prompt` | `analyze_style`; extensible with `scout`), `payload` (jsonb), `status` (`queued` | `claimed` | `done` | `failed`), `result` (jsonb), `created_at`, `claimed_at`, `finished_at`.
- **`accounts`** — LinkedIn OAuth (v1). Tokens encrypted at rest.
- **`kv`** — settings: tone profile (examples, form, style guide), image specs, identity (name/handle/avatar), topics, default slots, notification email, lead time, agent `last_heartbeat_at`.

## 6. Flows

### 6.1 Video → candidate posts

UI (Find Ideas → Videos) enqueues `generate_from_video` {url, instructions, language, count} → agent fetches transcript locally, runs `claude -p` → candidates saved as `drafts (status: candidate)` linked to the video's `ideas` row → grid renders. Transcript failure (rare, local) → UI asks to paste it. **Mac off:** the job queues and the UI says "agent offline — last seen X min ago" (optional paid API mode can serve generation from Vercel, off by default).

### 6.2 Trends → post

X links land in `ideas` (manual paste, `POST /api/ideas` with `CAPTURE_TOKEN`, or future scout) → enriched via free public oEmbed (text, author) → Trends cards → **Use** creates a draft pre-filled with a rewrite instruction ("same topic, my angle, my voice") the owner can run or edit.

### 6.3 Create → schedule/publish

1. Scheduling inserts one `scheduled_posts` row per platform + one QStash delayed message per row → `POST /api/publish` (signature verified, idempotent).
2. **LinkedIn — automatic:** fires at `scheduled_at`, official API adapter publishes → `published` (`posted_by: api`). Works with Mac off.
3. **X — human-in-the-loop:** fires at `scheduled_at − lead_time` (default 5 min) → Resend email: post text, copy block, **"Post on X"** button (official intent `https://x.com/intent/post?text=…`) and a signed **"mark as posted"** link → `emailed` → `posted_manually`. "Post now" in Create opens the intent link directly instead.
4. Plan calendar shows statuses; `emailed` posts nag until marked or canceled.

### 6.4 Web ↔ agent protocol

`AGENT_TOKEN` bearer; `GET /api/agent/jobs?kinds=…&wait=25` long-poll with atomic claim; `POST /api/agent/jobs/:id/result`; heartbeat every 60s; idempotent by job id; stale `claimed` jobs return to `queued`.

### Publisher abstraction

`Publisher` interface, v1 implementations: **`linkedin-api`**, **`x-intent-email`**. Future adapters (optional compliant `x-api`, generic `webhook`) stay additive.

## 7. Auth & security

- Web login: single password (`ADMIN_PASSWORD`) → httpOnly session cookie; rate-limited.
- `AGENT_TOKEN`, `CAPTURE_TOKEN` bearers; QStash signature on `/api/publish`; LinkedIn tokens encrypted (AES-256-GCM); "mark as posted" links signed and single-purpose.
- Secrets only in env; `.env.example` documented for web and agent. The repo never contains credentials and never automates third-party UIs.

## 8. Availability matrix

| Capability | Mac on | Mac off |
|---|---|---|
| Browse ideas, edit drafts, calendar | ✓ | ✓ |
| Generate / refine / image prompt | ✓ (agent, free) | queued; or optional paid API mode |
| LinkedIn scheduled publish | ✓ (cloud, API) | ✓ (cloud, API) |
| X scheduled email (5 min before) | ✓ (cloud) | ✓ (cloud) |

## 9. Error handling

- Email send failure → QStash retries; still-failed → `failed` + "resend email" action.
- LinkedIn publish failure → `failed` + error surfaced, manual retry; 60-day token expiry → reconnect banner ahead of time.
- Agent offline → jobs queue with clear UI state; heartbeat age shown in Settings.
- Dry-run mode (`PUBLISH_DRY_RUN=1`): fake LinkedIn publisher + emails to self.

## 10. Testing

- Unit (Vitest): oEmbed/OG parsing, prompt building (tone guide injection), job claim/idempotency, intent-URL builder (encoding, 280 chars), lead-time math, slot suggestions.
- Publishers and the agent's Claude invocation behind interfaces with fakes; integration test schedule → QStash callback → per-platform branch → status transitions.
- Manual smoke: email intent flow on iPhone; video → candidates round-trip with the real agent.

## 11. Milestones

1. **M1 — Web core:** auth, tab skeleton (dark theme tokens), ideas + enrichment, videos list, settings (identity, email, slots, topics), jobs + agent protocol endpoints.
2. **M1.5 — Trend scout (final design, 2026-09-21): free open sources, server-side, no browser automation anywhere.** X is read only through its official API; the project never automates a browser and never works around a platform's security controls, so browser-based scouting of X was abandoned for good. Instead, pressing **Search** runs the scout inline on the server: the seed is saved, a keyword query is derived, then **open, official, free APIs** are queried — Bluesky public search (`public.api.bsky.app`, no auth) and Hacker News (Algolia API); Reddit is a later optional source — candidates are judged by **Jev via `jev-judge`** (relevance, spam) using `TYPESAFE_API_KEY` on the server, and the top results are inserted as scouted ideas (source `scout`, meta `{score, topic: query, source}`) and shown immediately under a "recent searches" strip derived from scouted ideas. "Search my topics" and the daily cron run the same inline search per Settings topic. **Result rules (owner direction, 2026-09-21):** per source, fetch at least 10–12 candidates (default 25) and show only the **top 5 by Jev rank**; the relevance threshold is a display hint (dimmed "low match"), not a filter. Cards carry a **source tag** (Hacker News / Bluesky / X / Note) and the grid has a **source filter row** combinable with the recent-searches chips. Feedback loop: **♥ keep** (positive taste signal, idea status `kept`), **Use** (positive + go create), **Dismiss** (negative) — these `kept/used` vs `dismissed` texts are what Jev receives as the owner's taste examples. **X stays human-in-the-loop for discovery too:** the owner pastes X posts that catch his eye; the Search box accepts them as seeds. Scout jobs, the private worker repo and presence gating are retired. Cost: Bluesky/HN free, Jev ~cents.
3. **M2 — Agent + generation:** daemon, heartbeat, `generate_from_video` + candidates grid, `revise_draft` with version history, `analyze_style` + tone setup, `image_prompt`. Must also address the M1 final-review contract notes (agent profile endpoint, draft materialization, session-side job visibility). **Plus (owner request, 2026-09-20): an AI-slop check in Create** — a per-draft button calling `POST /api/slop-check` (session-gated), which runs `jev-judge`'s `checkSlop` directly from Vercel using an optional `TYPESAFE_API_KEY` env (official API, ~free, works with the Mac off; feature hidden when the key is absent). UI shows slopScore 0–100 with verdict (human / borderline / slop) so the owner catches AI-sounding drafts before publishing.
4. **M3 — Publishing:** QStash wiring, LinkedIn OAuth + adapter, X intent email + lead time + mark-as-posted + post-now, Plan calendar with slots, dry-run.
5. **M4 — Portfolio polish:** PWA manifest/icons, README (architecture diagram, availability matrix, deploy guide), demo GIF, MIT license.

## 12. Future extensions (out of scope v1)
- Taste loop: promote ♥ candidates to tone examples; relevance scoring on Trends.
- One-click image generation via the **official Gemini API** (`GEMINI_API_KEY`, optional): `image_prompt` result → Gemini image model → image stored in Vercel Blob (free tier) → attached to the draft and to the X email (X intent carries text only, so the owner attaches the image in the composer; LinkedIn can attach via API in a later version). Free-tier quota when Google offers one, otherwise ~$0.04/image. **Gemini's web UI is never browser-automated** — v1 ships the manual flow (one-click prompt → copy → nano banana) by the owner's explicit choice.
- Optional compliant `x-api` adapter; generic `webhook` adapter; iOS Shortcut / Telegram capture; threads; media uploads; analytics.
