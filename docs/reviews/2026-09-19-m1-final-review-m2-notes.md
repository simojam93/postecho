# M1 Final Review — M2 Contract Notes

M2 contract notes from the M1 final integration review — must be addressed by the M2 plan.

## 1. Agent tone-profile access

`/api/settings` is session-only; the agent (`AGENT_TOKEN`) has no endpoint for
`toneExamplesX`/`toneExamplesLinkedin`, `toneForm`, `styleGuide`, identity, or
`topics`.

**Recommended:** `GET /api/agent/profile` (`requireAgentToken`) returning that
allowlist, explicitly NOT `notificationEmail`. Prefer live-read over
snapshotting tone into job payloads.

## 2. Draft materialization

Nothing writes the `drafts` table today.

**Recommended:** the result handler materializes drafts on `ok:true` for
`generate_from_video` (zod-validate `result: { drafts: [{ xText?, linkedinText? }] }`,
insert with `ideaId` from the job payload, `status: "candidate"`) — insert
drafts FIRST, then flip the job to `done` (no transactions on neon-http, so
ordering here is what makes a crash mid-way safe to retry). Dedupe by
stamping `jobId` on draft rows for retry idempotency.

## 3. Session-side job visibility

There's no `GET /api/jobs` for the UI; the Videos tab can't show
queued/claimed/done/failed status or surface errors.

**Recommended:** `GET /api/jobs?ideaId=` behind `requireSession`. Consider an
attempts counter or a requeue action for failed jobs (a manual
transcript-recovery path).

## 4. Long-poll economics

A resident agent holding `wait=25` keeps a function open ~24/7.

**Recommended:** verify Hobby/Fluid idle billing before repeating the €0
claim; consider an agent-side fallback to `wait=0` interval polling when
idle.
