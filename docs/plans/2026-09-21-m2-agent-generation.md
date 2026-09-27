# PostEcho M2 — Agent + Generation (Create tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostEcho *produce*: a local agent on the owner's Mac turns ideas and YouTube videos into post drafts with Claude (owner's subscription, zero API cost), and the Create tab lets the owner keep, refine, slop-check and prepare them.

**Architecture:** Two halves. **Web** (Vercel, `web/`): new job kind `generate_from_idea`, an agent-readable tone profile endpoint, result materialization (drafts written by the result handler, idempotent by `jobId`), a drafts API, a server-side slop check via `jev-judge`, and the Create tab UI. **Agent** (`agent/`, in this repo): a TypeScript CLI that long-polls the existing job protocol, fetches YouTube transcripts locally, calls **Claude Code headless** with JSON-schema-validated output, and posts results back. No browser automation anywhere; if a transcript is unavailable the job fails with a clear message and the owner pastes it manually — never IP/cookie tricks.

**Tech Stack:** existing web stack (Next.js 16.3.5, Drizzle, PGlite tests, zod 4, vitest); agent: Node 20, TypeScript, tsx, zod, vitest, `youtube-transcript@1.3.1`, Claude Code CLI 2.1.66 (`claude -p`).

**Verified on the owner's Mac (2026-09-21):** `claude --version` → 2.1.66; headless flags available: `-p`, `--output-format json`, `--json-schema <schema>`, `--model <alias>`, `--system-prompt <prompt>`, `--no-session-persistence`, `--allowedTools <list>`, `--permission-mode`. `youtube-transcript` 1.3.1 (updated 2026-04) and `youtubei.js` 18.0.0 exist on npm.

**Conventions:** same as M1/M1.5 — TDD, zod at boundaries, `{error}` envelopes + `console.error`, PGlite tests via `vi.mock("@/db")`, token utility classes, pill buttons, stage only your files, commit trailer per system reminder. Live dev server on :3210 may hold `web/.pglite`: never run `db:migrate:dev` while it does; no `next build`; no `.next` deletion.

---

## Part A — Web

### Task A1: Schema — `generate_from_idea` kind, draft provenance
**Files:** `web/src/db/schema.ts`, new migration `0005_*`, `web/src/db/schema.test.ts`
- [ ] Add `"generate_from_idea"` to `jobKind` enum.
- [ ] `drafts`: add `jobId: uuid("job_id")` (nullable; materialization idempotency), `meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull()` (slop results, platform flags), index `drafts_idea_id_idx` on `ideaId`.
- [ ] `npm run db:generate` → 0005; verify SQL (ALTER TYPE ADD VALUE, ALTER TABLE ADD COLUMN ×2, CREATE INDEX). Test: insert a draft with jobId/meta, insert a job of the new kind.
- [ ] Commit `feat(db): generate_from_idea kind, draft jobId/meta`.

### Task A2: `GET /api/agent/profile`
**Files:** `web/src/app/api/agent/profile/route.ts` (+ test)
- [ ] Bearer `AGENT_TOKEN` via `requireAgentToken`. Returns `{ identityName, identityHandle, toneExamplesX, toneExamplesLinkedin, toneForm, styleGuide, topics, imageSpecs }` from settings — and explicitly NOT `notificationEmail`. Add `imageSpecs: ""` to `SETTING_DEFAULTS` + settings PUT whitelist (≤4000 chars).
- [ ] Tests: 401 wrong token; 200 shape; email never present. Add `/api/agent/profile` nowhere in proxy (it's under `/api/agent/` — already public path, bearer-gated).
- [ ] Commit `feat: agent profile endpoint`.

### Task A3: Result materialization (the M1 contract gap)
**Files:** `web/src/app/api/agent/jobs/[id]/result/route.ts`, new `web/src/lib/materialize.ts` (+ tests)
- [ ] In the result handler, after auth/uuid/body/claimedAt checks and BEFORE marking the job done, load the job row and call `materialize(db, job, body.result)`:
  - `generate_from_video` | `generate_from_idea`: zod `{ drafts: z.array(z.object({ xText: z.string().max(400).optional(), linkedinText: z.string().max(4000).optional() }).refine(d => d.xText || d.linkedinText)).min(1).max(25) }` → if drafts with this `jobId` already exist → skip (idempotent); else insert rows `{ ideaId: payload.ideaId ?? null, xText, linkedinText, status: "candidate", jobId, meta: { overLimit: xText.length > 280 } }`.
  - `revise_draft`: `{ xText?, linkedinText? }` → insert one draft `{ parentId: payload.draftId, ideaId: parent.ideaId, status: "kept", jobId }`.
  - `image_prompt`: `{ imagePrompt: string(≤2000) }` → `update drafts set imagePrompt where id = payload.draftId`.
  - `analyze_style`: `{ styleGuide: string(≤20000) }` → `setSetting(styleGuide)`.
  - `scout` or unknown: no-op.
  - invalid shape → return 400 `{ error: "invalid result for kind" }` and mark the job `failed` with that error (agent bug, not a retry case).
- [ ] Order: materialize first, then flip status to `done` (no transactions on neon-http; a crash leaves a `claimed` job that re-runs idempotently thanks to `jobId`).
- [ ] Tests per kind, idempotent re-post (drafts not duplicated), invalid shape → 400 + failed, unknown ideaId tolerated (null).
- [ ] Commit `feat: materialize agent results into drafts and settings`.

### Task A4: Drafts API
**Files:** `web/src/app/api/drafts/route.ts`, `web/src/app/api/drafts/[id]/route.ts`, `web/src/app/api/drafts/from-idea/route.ts`, `web/src/app/api/drafts/[id]/revise/route.ts`, `web/src/app/api/drafts/[id]/image-prompt/route.ts` (+ tests), `web/src/lib/drafts.ts`
- [ ] `GET /api/drafts?ideaId=&status=&limit=` (session): rows newest first, joined with `ideas.title/url/kind` as `idea`, and `jobs.status` for the latest job touching the idea (for "writing…" states).
- [ ] `PATCH /api/drafts/:id` (session): `{ xText?, linkedinText?, status?: kept|discarded|used|candidate, favorite? }` zod; 404 on missing/invalid uuid.
- [ ] `POST /api/drafts/from-idea` (session): `{ ideaId, instructions?: string(≤500), count?: 1..5 (default 3) }` → load idea (404 if missing) → insert job `generate_from_idea` payload `{ ideaId, seedText: idea.content ?? idea.title ?? idea.url, seedUrl: idea.url, instructions, count }` → mark idea `used` → 201 `{ job }`.
- [ ] `POST /api/drafts/:id/revise` (session): `{ instruction: string(1..500) }` → job `revise_draft` payload `{ draftId, xText, linkedinText, instruction }` → 201 `{ job }`.
- [ ] `POST /api/drafts/:id/image-prompt` (session): job `image_prompt` payload `{ draftId, xText, linkedinText }` → 201 `{ job }`.
- [ ] Tests for each (session-gated, shapes, 404s, job payloads).
- [ ] Commit `feat: drafts api and generation job triggers`.

### Task A5: Slop check endpoint
**Files:** `web/src/app/api/slop-check/route.ts` (+ test), `web/src/lib/slop.ts`
- [ ] `POST /api/slop-check` (session) `{ text: string(1..5000), platform?: "x"|"linkedin", draftId?: uuid }` → `checkSlop(client, { text, platform })` from `jev-judge` (client created lazily from `TYPESAFE_API_KEY`; missing → 503 `{ error: "slop check disabled: TYPESAFE_API_KEY not set" }`); when `draftId` given, store the result in `drafts.meta.slop = { platform, slopScore, verdict, at }`. DI for the Jev client (module-level `setSlopDeps` like scout-run). Tests: 503 path, result shape, meta persistence, 401.
- [ ] Commit `feat: server-side ai-slop check`.

### Task A6: Jobs API filters
**Files:** `web/src/app/api/jobs/route.ts` (+ test)
- [ ] Add `?id=<uuid>` and `?ideaId=<uuid>` filters (ideaId matches `payload->>'ideaId'`); keep existing behavior. Tests.
- [ ] Commit `feat: jobs api id/ideaId filters`.

### Task A7: Settings — image specs + Analyze my posts
**Files:** `web/src/app/(authed)/settings/page.tsx`, `web/src/app/api/settings/analyze-style/route.ts` (+ test)
- [ ] Textarea "Image specs" (kv `imageSpecs`): style, format, avoid-list hint.
- [ ] Button **Analyze my posts** → `POST /api/settings/analyze-style` (session) → requires ≥3 examples across X+LinkedIn else 400 `{ error: "add a few example posts first" }` → job `analyze_style` payload `{ toneExamplesX, toneExamplesLinkedin, toneForm }` → 201 `{ job }`; page polls `GET /api/jobs?id=` and, on `done`, reloads settings and shows the editable **Style guide** textarea (kv `styleGuide`).
- [ ] Commit `feat: analyze-my-posts and image specs settings`.

### Task A8: Create tab UI
**Files:** `web/src/app/(authed)/create/page.tsx`, `web/src/components/draft-list.tsx`, `web/src/components/draft-editor.tsx`, `web/src/components/slop-badge.tsx`
- [ ] Layout: left column list of drafts (filters: Candidates / Kept / All; grouped by source: video title or idea excerpt), right column editor for the selected draft.
- [ ] Editor: X textarea with live counter (`n/280`, turns `text-danger` over 280), LinkedIn textarea; actions (pills): **Keep**, **Discard**, **★ favorite**, **Refine** (inline instruction input → `POST /revise` → "Claude is rewriting…" polling `GET /api/jobs?id=` every 3s → when done reload and select the new version; version chain shown as "v2 of v1" link), **Image prompt** (→ job → shows prompt in a copyable box), **Slop check** (→ `/api/slop-check` with the X or LinkedIn text → `SlopBadge` shows `verdict · slopScore`; `human` text-ok, `borderline` text-text-dim, `slop` text-danger). **Schedule** / **Post now** disabled with tooltip "arrives with M3".
- [ ] Autosave edits on blur via PATCH; unsaved indicator.
- [ ] `?ideaId=` query param preselects/filters (used by Find Ideas → Use).
- [ ] Empty state: "Nothing here yet — press Use on an idea, or generate posts from a video."
- [ ] Commit `feat: create tab (drafts editor, refine, image prompt, slop check)`.

### Task A9: Find Ideas wiring
**Files:** `web/src/components/idea-card.tsx`, `web/src/app/(authed)/page.tsx`, `web/src/components/generate-posts-panel.tsx`
- [ ] **Use** → `POST /api/drafts/from-idea` → `router.push('/create?ideaId=…')`; Create shows "Claude is writing your take on this…" while the `generate_from_idea` job is queued/claimed (poll), then the candidates.
- [ ] Video cards: show latest job status (queued/running/done/failed with error text, e.g. transcript unavailable → "paste transcript" affordance: a textarea that POSTs `/api/videos` again with `transcript` in payload — add optional `transcript: string(≤200k)` to `/api/videos` body → payload; the agent skips fetching when present). "n candidates → open in Create".
- [ ] Commit `feat: use → create flow and video job states`.

## Part B — Agent (`agent/`)

### Task B1: Scaffold
**Files:** `agent/package.json`, `agent/tsconfig.json`, `agent/.env.example`, `agent/README.md`, `agent/src/config.ts` (+ test)
- [ ] `npm init -y`; name `postecho-agent`, private, type module, engines node ≥20; deps `zod`, `youtube-transcript@^1.3.1`; devDeps `typescript`, `tsx`, `vitest`, `@types/node`. Scripts: `dev` (`tsx --env-file-if-exists=.env src/main.ts`), `doctor` (`tsx --env-file-if-exists=.env src/doctor.ts`), `test`, `lint` (`tsc --noEmit`).
- [ ] `.env.example`: `POSTECHO_URL=http://localhost:3210`, `AGENT_TOKEN=`, `CLAUDE_BIN=claude`, `CLAUDE_MODEL=sonnet`, `POLL_WAIT_SECONDS=25`, `CLAUDE_TIMEOUT_MS=180000`.
- [ ] `config.ts`: zod-parsed env, clear error listing missing vars. README: setup, `npm run doctor`, `npm run dev`, launchd plist template (`agent/launchd/com.postecho.agent.plist.example` with `KeepAlive` and `RunAtLoad`).
- [ ] Root `.gitignore` already covers `.env*`; add `agent/node_modules` implicitly via `node_modules/`.
- [ ] Commit `chore(agent): scaffold`.

### Task B2: Protocol client
**Files:** `agent/src/postecho.ts` (+ test)
- [ ] `claimJob(kinds, waitSec)` → `GET /api/agent/jobs?kinds=…&wait=…` (bearer) → 200 job `{ id, kind, payload, createdAt, claimedAt }` | 204 null; `postResult(jobId, claimedAt, { ok: true, result } | { ok: false, error })`; `heartbeat(kinds)`; `getProfile()` → `GET /api/agent/profile`. Injected fetch; tests with fakes (headers, 204, claimedAt echo, error surfacing).
- [ ] Commit `feat(agent): protocol client`.

### Task B3: Claude runner
**Files:** `agent/src/claude.ts` (+ test), `agent/src/doctor.ts`
- [ ] `runClaudeJson<T>(opts: { prompt: string; system: string; schema: object; parse: (x: unknown) => T })` spawns `claude -p --output-format json --json-schema <schema JSON> --model <CLAUDE_MODEL> --no-session-persistence --system-prompt <system> --allowedTools "" <prompt>` (prompt passed via stdin to avoid arg limits; verify `-p` reads stdin when no positional prompt — check `claude -p --help` and test once live). Parse stdout JSON envelope: prefer `structured_output` when present, else parse `result` string as JSON; `parse()` validates (zod). Timeout `CLAUDE_TIMEOUT_MS` → kill + error; one retry on parse failure with an appended "Return ONLY valid JSON" reminder. Never log the full transcript, only sizes and durations.
- [ ] `doctor.ts`: runs a trivial schema `{ ok: boolean }` prompt ("reply with ok true") and prints CLI version + elapsed → verifies the subscription login works headless. The implementer runs it once live (allowed: owner's subscription, trivial cost) and records the exact envelope shape observed in a code comment.
- [ ] Tests with an injected spawn function (fake child process output), timeout path, retry path.
- [ ] Commit `feat(agent): claude headless runner + doctor`.

### Task B4: Transcript
**Files:** `agent/src/transcript.ts` (+ test)
- [ ] `fetchTranscript(url, { langs: ["en", "it"] })` via `YoutubeTranscript.fetchTranscript(videoId, { lang })` trying each lang, joining segments with spaces, normalizing whitespace, capping 60k chars (note when capped). On any failure throw `TranscriptUnavailable` with a human message. **No retries with proxies/IP tricks/cookies — ever.** If `payload.transcript` is present, use it and skip fetching.
- [ ] Tests with the lib mocked (success, fallback lang, failure → typed error, cap).
- [ ] Commit `feat(agent): youtube transcript fetch with manual fallback`.

### Task B5: Prompts + schemas (pure)
**Files:** `agent/src/prompts.ts`, `agent/src/schemas.ts` (+ tests)
- [ ] `DRAFTS_SCHEMA` `{ drafts: [{ xText, linkedinText }] }`, `REVISE_SCHEMA`, `IMAGE_PROMPT_SCHEMA`, `STYLE_GUIDE_SCHEMA` as JSON Schema objects + matching zod parsers.
- [ ] `systemPrompt(profile)` — identity, style guide (if any), 3 best examples per platform (first 3 non-empty blocks of toneExamples*), hard rules: X ≤ 280 chars, no links in the X body, no hashtags unless `toneForm.hashtags === "yes"`, LinkedIn 600–1200 chars with a strong first line, first person, concrete, no filler, output JSON only matching the schema.
- [ ] `generatePrompt({ sourceKind: "video"|"idea", sourceText, instructions, count, language })`, `revisePrompt({ xText, linkedinText, instruction })`, `imagePrompt({ text, imageSpecs })`, `styleGuidePrompt({ examplesX, examplesLinkedin, toneForm })`.
- [ ] Tests: snapshots of key rule lines, count/language plumbing, examples capped at 3, empty profile safe.
- [ ] Commit `feat(agent): prompts and schemas`.

### Task B6: Main loop + handlers
**Files:** `agent/src/main.ts`, `agent/src/handlers.ts` (+ tests for handlers with fakes)
- [ ] Kinds served: `generate_from_video`, `generate_from_idea`, `revise_draft`, `image_prompt`, `analyze_style`.
- [ ] Loop: heartbeat every 60s → long-poll claim → handler → `postResult` (ok/failed) → repeat; SIGINT graceful; single concurrency; every handler loads the profile fresh via `getProfile()`.
- [ ] Handlers: video → transcript (or payload.transcript) → `runClaudeJson(generatePrompt)` → `{ drafts }`; idea → `generatePrompt` with seedText/seedUrl; revise → `{ xText?, linkedinText? }`; image → `{ imagePrompt }`; style → `{ styleGuide }`. Errors → `ok:false` with message (transcript unavailable message verbatim).
- [ ] Commit `feat(agent): main loop and job handlers`.

### Task B7: Owner-present smoke
- [ ] Web dev server on :3210; `cd agent && cp .env.example .env` (AGENT_TOKEN from `web/.env.local`), `npm run doctor` → ok; `npm run dev`.
- [ ] In the app: Settings → paste tone examples → **Analyze my posts** → style guide appears. Find Ideas → **Use** on a scouted card → Create shows 3 candidates in the owner's voice. Videos → Search a YouTube link → **Generate posts** → candidates. Create → Refine → v2; Slop check → badge. Record outputs in the report.

## Self-review checklist
Spec coverage (spec §2.2 agent kinds, §4 Create, §6.1 video flow incl. transcript fallback, M1 final-review notes: profile endpoint ✓ A2, materialization ✓ A3, job visibility ✓ A6/A9) · slop check ✓ A5 · no browser automation, no evasion ✓ B4 · placeholders: none · types consistent (job kinds enum ↔ agent kinds list ↔ materialize switch).
