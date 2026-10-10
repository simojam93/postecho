# Media from a repo Implementation Plan

**Goal:** Give a post from a repo media when the owner asks: images already in the repository, a card made from
the post, screenshots of the app or a brag-slim video (the last two only for a folder on this computer).

**Architecture:** One new job kind, `post_media`, payload `{ draftId, repoId, source, kind, postText, format }`.
The agent makes the files in `~/.postecho/media/<draftId>/` and answers `{ items: [{ file, kind, caption? }] }`;
the web appends them to `drafts.meta.media` (jsonb, no column) with `kept: false` and the job's id. The wake
server serves, reveals and deletes those files on 127.0.0.1 behind the same origin check. Screenshots and video
run Claude Code with wider tools, only for folders, with a 40-minute budget on the agent and a 45-minute
stale-claim window on the web. Cards are drawn from an HTML template with playwright-core and the system Chrome.

Spec: `docs/specs/2026-10-11-media-from-a-repo-design.md`.

Every task: failing test first, see it fail, implement, see it pass, one commit. The agent part first.

---

## Agent

### Task 1: Claude Code with the tools a kind needs

**Files:** `agent/src/claude.ts`, `agent/src/handlers.ts` (RunClaudeJsonFn type).

`RunClaudeJsonOptions` gains `tools?: string` (the `--allowedTools` value; the hardening flags
`--setting-sources user --strict-mcp-config` come with it, as with `readOnlyTools`), `addDirs?: string[]`
(`--add-dir`, so Claude can write into the media directory outside the repository) and `timeoutMs?: number` (this
call's own time, still capped by the job's deadline).

**Tests:** `claude.test.ts`: `tools` + `addDirs` give the hardening flags, `--allowedTools "Read Glob Grep Bash
Write"` and `--add-dir <dir>`; `timeoutMs` replaces CLAUDE_TIMEOUT_MS and is still capped by the deadline.

### Task 2: A budget per job

**Files:** `agent/src/worker.ts`.

`jobBudgetMs(job)`: 40 minutes for a `post_media` job whose payload kind is `screenshots` or `video`, 9 minutes
otherwise. A long job's Claude calls get the whole remaining budget as their time (`timeoutMs`).

**Tests:** `worker.test.ts`: `jobBudgetMs` per kind; a screenshots job's runClaudeJson gets a deadline ~40 min
out and a `timeoutMs`; a card job's deadline stays 9 min.

### Task 3: The media directory and its paths

**Files:** `agent/src/media/paths.ts` (new).

`MEDIA_DIR` (`~/.postecho/media`), `mediaDirFor(base, draftId)` (a draft id is letters, digits and dashes) and
`mediaFilePath(base, draftId, file)` (a plain file name: no slash, no `..`, no absolute path, the result inside
the draft's directory, else null), `contentTypeOf(file)`, `IMAGE_EXTENSIONS`.

**Tests:** `media/paths.test.ts`: good names resolve inside; `../x`, `/etc/passwd`, `a/b.png`, `..`, an empty
name and a bad draft id are refused; content types.

### Task 4: The card template and its renderer

**Files:** `agent/src/media/card.ts` (new), `agent/package.json` (`playwright-core`).

`cardHtml({ headline, line?, number?, repoName, width, height })`: pure HTML, escaped, dark background, light
text, the repository's name small at the bottom, no PostEcho logo. `CARD_SIZES` (landscape 1600×900, portrait
1080×1350). `renderCardPng(html, size, out)`: playwright-core, `chromium.launch({ channel: "chrome" })`; without
Chrome a clear sentence.

**Tests:** `media/card.test.ts`: the HTML holds the escaped headline, line, number and repo name at the given
size, no "PostEcho"; optional parts left out; a launcher that fails like a missing Chrome gives the sentence
(the renderer takes an injectable launcher).

### Task 5: post_media's handler

**Files:** `agent/src/media/post-media.ts` (new), `agent/src/prompts.ts` (four prompts),
`agent/src/schemas.ts` (images, card, screenshots and video replies), `agent/src/handlers.ts` (HANDLERS,
HandlerDeps `media`), `agent/src/main.ts` (real deps).

- Payload check; `screenshots` and `video` refused for anything but a folder, whatever the web sent.
- images: read-only Claude in the repository, up to 6 paths; the agent copies the ones inside the repository
  (realpath), with an image extension and under 10 MB.
- card: Claude writes the card's words from the post (no tools); rendered 1600×900, plus 1080×1350 for LinkedIn.
- screenshots: Claude in the folder with `Read Glob Grep Bash Write`, `--add-dir` the media directory; the agent
  records the new PNGs there (up to 4) with Claude's captions.
- video: Claude with those plus `Skill Edit` runs brag-slim, told to write brag.mp4 and brag.jpg into a work
  folder inside the media directory; the agent moves them to `video-<token>.mp4/.jpg`, drops the work folder and
  records them. Missing brag.mp4 is a failure with a sentence.
- Progress `{ kind: "post_media", media, phase: reading | making | saving }`.

**Tests:** `media/post-media.test.ts` with fakes for Claude and the renderer and a temp media directory: each
kind's result and files, the folder-only refusal before anything runs, images outside the repo / too big / not
an image skipped, the tools and add-dir passed for screenshots and video, the phases. `handlers.test.ts`: ten
kinds served.

### Task 6: The wake server serves the media

**Files:** `agent/src/wake-server.ts`, `agent/src/run.ts`, `agent/src/main.ts`.

`GET /media/<draftId>/<file>` (the file, its content type), `DELETE /media/<draftId>/<file>` (204),
`POST /media/reveal` `{ draftId, file }` (`open -R` on macOS, 501 elsewhere). Same origin check, the preflight
allows DELETE. Paths confined (Task 3).

**Tests:** `wake-server.test.ts`: serves a file with its type; 404 for a missing one; traversal refused
(`..%2F`, encoded slashes); another origin 403; DELETE removes; reveal calls the injected revealer, 501 on
another platform; preflight lists DELETE.

## Web

### Task 7: The post_media job kind

**Files:** `web/src/db/schema.ts`, `web/drizzle/0017_*.sql` + meta (drizzle-kit generate).

**Tests:** `agent.test.ts`: an agent can claim a `post_media` job (fails before the enum has it).

### Task 8: A longer stale window for long media jobs

**Files:** `web/src/app/api/agent/jobs/route.ts`, `web/src/lib/media.ts` (new, pure: kinds, item shape,
`STALE_CLAIM_MS`, `LONG_STALE_CLAIM_MS`).

**Tests:** `agent.test.ts`: a screenshots job claimed 20 minutes ago stays claimed, a card job claimed 20 minutes
ago is requeued, a video job claimed 50 minutes ago is requeued.

### Task 9: POST/GET /api/drafts/:id/media and the result

**Files:** `web/src/app/api/drafts/[id]/media/route.ts` (new), `web/src/lib/draft-media.ts` (new: the draft's repo
source), `web/src/lib/materialize.ts` (`post_media`).

GET answers `{ kinds, media, job }` (the kinds allowed for the source, the items, the latest media job). POST
`{ kind }` checks the draft comes from a repo post, the kind is allowed for its source and the agent serves
`post_media` (409), then inserts the job with the job header. The result appends items (`kept: false`, `jobId`),
once per job.

**Tests:** `media.test.ts` (route): 404 for an unknown draft, 400 for a post not from a repo, 400 for
screenshots on a GitHub source, 409 when the agent doesn't serve it, 201 with the header and the payload; GET's
kinds per source. `materialize` test: items appended, a second post of the same result adds nothing, bad shape
refused.

### Task 10: Keep and remove

**Files:** `web/src/app/api/drafts/[id]/route.ts`.

`PATCH { media: [{ file, kept }] }`: the list the page wants; items left out are removed, `kept` set, unknown
files ignored, other meta untouched.

**Tests:** `drafts.test.ts`: keep one, remove one, meta.slop untouched.

### Task 11: Add media in Compose

**Files:** `web/src/components/write/post-media.tsx` (new), `web/src/lib/media-client.ts` (new: the wake port,
the media URL, reveal and delete calls), `web/src/components/write/post-editor.tsx`,
`web/src/components/write/article-editor.tsx`, `web/src/components/work-status.ts` (post_media is Compose work).

`MediaView` (pure) and `PostMedia` (fetching). Add media opens a menu with only the allowed kinds; a running job
shows its steps (`mediaSteps`); thumbnails with Keep and Remove; a kept item shows Show in Finder; when a
thumbnail can't load, one line says the media are on the computer where the agent runs.

**Tests:** `post-media.test.ts`: the menu per source, the steps per phase, thumbnails from 127.0.0.1, Keep/Remove,
Show in Finder only when kept, the offline line; `post-editor.test.ts`: Add media only for a repo post.

### Task 12: Media in Schedule all

**Files:** `web/src/lib/drafts.ts` (ReadyPost `media`: kept items), `web/src/components/plan/ready-list.tsx`
(type), `web/src/components/plan/schedule-all.ts`, `web/src/components/plan/schedule-all-dialog.tsx`,
`web/src/components/plan/plan-view.tsx`.

**Tests:** `drafts.test.ts`: the ready list carries kept media only; `schedule-all.test.ts`: each step carries
its post's media; `schedule-all-dialog` render test of the media strip: thumbnails and Show in Finder.

### Task 13: Checks and live

`cd agent && npx vitest run && npx tsc --noEmit -p .`, `cd web && npx vitest run && npx tsc --noEmit && npm run
build`, `node --test "scripts/**/*.test.mjs"`. Live on a scratch copy (never the owner's database or agent): a
card and images from `simojam93/jev-judge`. Screenshots and video are not run live here.
