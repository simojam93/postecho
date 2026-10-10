# Posts from a repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write X posts, LinkedIn posts and X articles from a local folder or a public GitHub repository, read by Claude Code on the owner's computer.

**Architecture:** Two new job kinds. `pick_folder` opens the OS folder picker on the agent's machine. `repo_posts` resolves the source (folder as is, or a shallow clone of a public GitHub repo under `~/.postecho/repos/`), runs Claude Code in that directory with only `Read`, `Glob` and `Grep`, and returns posts in the chosen format. The web stores the source as an idea of kind `repo` and each result as an idea of kind `repo_post`, the same pattern as video posts. Articles get two draft columns.

**Tech Stack:** Next.js 16 (web), Drizzle on Postgres/PGlite, zod, Vitest; the agent is Node + tsx, `claude -p`.

Spec: `docs/specs/2026-10-10-posts-from-a-repo-design.md`.

---

## The contract between web and agent

Both halves are built against these shapes. Nothing else crosses the wire.

```ts
// Job kind "pick_folder", payload {}.
// Result: { path: string } | { cancelled: true }
// Fails with "No folder picker on this computer: type the path instead." when there's no picker.

// Job kind "repo_posts", payload:
type RepoPostsPayload = {
  ideaId: string;                       // the "repo" idea
  source: { type: "folder"; path: string } | { type: "github"; url: string };
  brief: string;                        // may be ""
  format: "x" | "linkedin" | "article";
  count: number;                        // 1-6
};
// Result:
type RepoPostsResult = {
  posts: Array<{ text: string; title?: string }>; // title only for articles
  repoName: string;                     // "postecho", "owner/name"
};
// Progress phases reported: "fetching" (clone/update, github only), "reading", "writing".
```

Limits, enforced by the agent's schema and again by the web's zod: X text ≤ 280, LinkedIn text 600-1,200
(accept up to 4,000 on the web), article title ≤ 100, article body ≤ 12,000.

---

## Part A: the agent (`agent/`)

### Task A1: Claude runs in a directory with read tools

**Files:** Modify `agent/src/claude.ts` (types `SpawnFn`, `RunClaudeJsonOptions`, `buildArgs`, `spawnClaude`), `agent/src/handlers.ts` (`RunClaudeJsonFn` type); Test `agent/src/claude.test.ts`.

- [ ] Write failing tests: with `cwd: "/tmp/repo"` and `readOnlyTools: true`, the spawn gets `cwd: "/tmp/repo"` in its options and the args contain `--allowedTools` followed by `Read Glob Grep` (and no empty `--allowedTools ""`). Without them, args and options are unchanged from today (`--allowedTools ""`, no cwd).
- [ ] Run `cd agent && npx vitest run src/claude.test.ts`: the two new tests fail.
- [ ] Implement: add `cwd?: string` and `readOnlyTools?: boolean` to `RunClaudeJsonOptions`; widen `SpawnFn` options to `{ stdio: ...; cwd?: string }`; `buildArgs(model, schema, system, readOnlyTools)` ends with `"--allowedTools", readOnlyTools ? "Read Glob Grep" : ""`; `spawnClaude` passes `cwd`.
- [ ] Run the agent suite (`npx vitest run`) and `npx tsc --noEmit -p .`: all pass.
- [ ] Commit: `agent: Claude can read one directory, with read tools only`.

### Task A2: Resolving the source

**Files:** Create `agent/src/repo-source.ts`, `agent/src/repo-source.test.ts`.

Exports:
```ts
export type RepoSource = { type: "folder"; path: string } | { type: "github"; url: string };
export function parseGithubUrl(url: string): { owner: string; name: string } | null;
export type GitRunner = (args: string[], cwd?: string) => Promise<void>; // rejects on non-zero exit
export async function resolveRepo(source: RepoSource, deps: { git: GitRunner; reposDir: string; stat: (p: string) => Promise<{ isDirectory(): boolean } | null> }): Promise<{ dir: string; name: string }>;
```
- [ ] Tests: `parseGithubUrl` accepts `https://github.com/a/b`, `…/a/b.git`, `…/a/b/` and `http://www.github.com/a/b`, rejects other hosts, missing name, and extra paths like `/a/b/tree/main`. Folder: an existing directory resolves to itself with the folder's basename as name; a missing path or a file throws `This folder doesn't exist, or isn't a folder: <path>`. GitHub, first time (stat of `<reposDir>/a__b` is null): git is called with `["clone", "--depth", "1", "https://github.com/a/b.git", "<reposDir>/a__b"]`, name is `a/b`. GitHub, already cloned: git is called with `["fetch", "--depth", "1", "origin"]` then `["reset", "--hard", "FETCH_HEAD"]` in that directory. A failing clone throws `This repository isn't public, or doesn't exist: https://github.com/a/b`.
- [ ] Run, see them fail; implement; run, see them pass; commit `agent: resolve a repo source to a directory`.

### Task A3: The prompt and schemas per format

**Files:** Modify `agent/src/prompts.ts` (add `repoPostsPrompt`), `agent/src/schemas.ts` (add `REPO_X_SCHEMA`, `REPO_LINKEDIN_SCHEMA`, `REPO_ARTICLE_SCHEMA` and `parseRepoPosts(format)`), tests in `agent/src/prompts.test.ts`, `agent/src/schemas.test.ts`.

- [ ] Tests: `repoPostsPrompt({ repoName, brief, format, count })` mentions the repo name, the brief when non-empty, says to explore with Read/Glob/Grep starting from the README and docs, asks for exactly `count` items, and states the format's limit (280 characters; 600-1,200 characters; a title up to 100 characters and a body of 600-1,500 words with short section headings as plain lines). With an empty brief it asks to pick the most interesting recent work. `parseRepoPosts("x")` accepts `{ posts: [{ text }] }` and drops items over 280 characters; `"linkedin"` keeps 600-4,000; `"article"` requires `title` (≤ 100) and `text` (≤ 12,000).
- [ ] Fail, implement, pass, commit `agent: prompts and schemas for posts from a repo`.

### Task A4: The two handlers

**Files:** Modify `agent/src/handlers.ts` (add `handleRepoPosts`, `handlePickFolder`, register both in `HANDLERS`; extend `HandlerDeps` with `resolveRepo` and `pickFolder`), `agent/src/main.ts` (wire real deps; add `repo_posts` to `LONG_READS`), create `agent/src/pick-folder.ts` (`osascript -e 'POSIX path of (choose folder)'` on darwin, exit code 1 with "User canceled" means cancelled, other platforms throw the spec's sentence), tests in `agent/src/handlers.test.ts`.

- [ ] Tests: `handleRepoPosts` validates the payload (count 1-6, format enum), reports `fetching` only for github, then `reading`/`writing`, calls `runClaudeJson` with `cwd` = the resolved dir, `readOnlyTools: true`, the format's schema, and returns `{ posts, repoName }` trimmed to `count`. `handlePickFolder` returns `{ path }`, or `{ cancelled: true }` when the picker reports cancel. `SERVED_KINDS` includes both kinds.
- [ ] Fail, implement, pass; run the whole agent suite and `tsc`; commit `agent: repo_posts and pick_folder jobs`.

## Part B: the web (`web/`)

### Task B1: Schema and migration

**Files:** Modify `web/src/db/schema.ts` (append `repo`, `repo_post` to `ideaKind`; `repo_posts`, `pick_folder` to `jobKind`; nullable `articleTitle text`, `articleText text` on `drafts`); create `web/drizzle/0015_posts_from_a_repo.sql` following `0013`/`0014` (one `ALTER TYPE … ADD VALUE` per value, then `ALTER TABLE "drafts" ADD COLUMN …`), update `web/drizzle/meta/_journal.json` the way the earlier migrations did (`npm run db:generate` if the repo uses it; otherwise copy the journal entry pattern).

- [ ] Run `npm --prefix web run db:migrate:dev` against a scratch PGlite (copy `web/.pglite` aside first and restore it after) and the web test suite; commit `web: schema for repo sources, repo posts and articles`.

### Task B2: The agent's kinds

**Files:** Modify `web/src/app/api/agent/heartbeat/route.ts` (store `body.kinds` as setting `agentKinds` when it is an array of strings), `web/src/lib/settings.ts` (the new key), create `web/src/lib/agent-kinds.ts` with `agentServes(kind): Promise<boolean>` (true when the setting is missing, so an unknown older state doesn't block; false only when the list exists and lacks the kind); tests next to them.

- [ ] Tests: heartbeat with `{ kinds: ["a","b"] }` stores them; `agentServes` true/false cases. Fail, implement, pass, commit `web: remember which jobs the agent can do`.

### Task B3: Routes

**Files:** Create `web/src/app/api/repos/route.ts` (POST create), `web/src/app/api/repos/pick/route.ts` (POST creates a `pick_folder` job, returns `{ jobId }`), `web/src/lib/repo-source.ts` (shared `parseGithubUrl` identical in behavior to the agent's, and `repoIdeaUrl(source)`), materialization in `web/src/lib/materialize.ts` (`repo_posts` result → `repo_post` ideas; `pick_folder` result is read by the page from `jobs.result`), `keepRepoPost` in `web/src/app/api/drafts/from-idea/route.ts` (Use on a `repo_post`: a `kept` draft with `xText` / `linkedinText` / `articleTitle`+`articleText` per format, no job); tests for each.

POST `/api/repos` body: `{ source: { type: "folder", path } | { type: "github", url }, brief?: string, format: "x"|"linkedin"|"article", count?: 1-6 }`. It returns 409 `{ error: "Update the agent: git pull, then restart npm run dev." }` when `agentServes("repo_posts")` is false; otherwise upserts the `repo` idea (url `file://<path>` or the normalized GitHub URL, title = basename or `owner/name`, `meta.sourceType`) and inserts the job, returning `{ ideaId, jobId }`.

- [ ] Tests for: validation errors (bad URL, empty path, count out of range), the 409, idea reuse on the same source, the job payload, materialization (archives earlier `new` posts of the same repo idea, inserts in order with `meta.format`, `meta.title` for articles, `meta.repoId`), and Use for each format. Fail, implement, pass, commit `web: create posts from a repo`.

### Task B4: The page

**Files:** Modify `web/src/components/nav.tsx` (label "Create posts"), `web/src/app/(authed)/page.tsx` (mode `"repo"` first in `MODES`, label "From a repo", tip "Posts and articles from a folder or a GitHub repo"; its input row and results), create `web/src/components/repos/repo-form.tsx` (Choose a folder button → POST `/api/repos/pick`, poll the job, fill the path; path field; GitHub field; brief input; format segmented control X post / LinkedIn post / X article; count 1-6; Create), `web/src/components/repos/repo-chips.tsx` (sources used, like `VideoChips`), and reuse `VideoIdeas`'s card list for results if it takes generic items, otherwise a small `repo-posts.tsx` with the same card styling; the one-line privacy note under the source.

- [ ] Component tests in the style of `video-chips.test.ts` for the form's validation and payload; run the web suite and `npm --prefix web run build`; commit `web: Create posts, with a From a repo tab`.

### Task B5: Articles in Write

**Files:** the Write editor components under `web/src/components/write/` that render `xText`/`linkedinText`, the drafts PATCH route, `revise_draft` payload (web side sends `articleText` as the text to revise when the draft is an article).

- [ ] A draft with `articleTitle` shows a title input and a long textarea instead of the X/LinkedIn boxes, with Copy (title, blank line, body) and Open X Articles (`https://x.com/compose/articles`). Tests for the PATCH route saving both fields and for the editor choosing the article layout. Commit `web: articles in Write`.

## Part C: live check

- [ ] Run the agent suite, the web suite, `npm --prefix web run build` and `node --test "scripts/**/*.test.mjs"`.
- [ ] On a scratch copy of the local database: create 3 X posts from `~/dev/postecho` with a brief, one LinkedIn post and one article from `https://github.com/simojam93/jev-judge`; Use one of each; open the article in Write. Restore the owner's database afterwards.
- [ ] Push to `main` only after the owner sees it.
