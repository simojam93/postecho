# Posts from a repo — design

Date: 2026-10-10. Status: approved by the owner ("dai ok").

## Goal

Write posts from a codebase: a folder on the owner's computer, or a public GitHub repository pasted as a
link. The owner says what the post should be about and picks the format: an X post, a LinkedIn post or an X
article. Claude Code reads the repository on the owner's computer and drafts in the owner's voice.

This is the first of three pieces. The next two get their own designs:

2. **Media from the repo**, chosen per post by the owner, never automatic: images and screenshots from the
   repository, and a video made with the owner's brag-slim skill, which needs a long job (10-30 minutes).
3. **A series of posts, scheduled together**: several drafts in a row, then one list to schedule them, with
   X's and LinkedIn's composers opened one after the other.

## What the owner sees

- The first section is renamed from **Find Ideas** to **Create posts** (nav label and page title). The
  route stays `/`.
- A new tab, **From a repo**, comes first, before Trends, Video posts and Liked. The search, the video
  posts and Liked work as today.
- **The source.** Two ways, side by side:
  - **Choose a folder**: the agent opens the operating system's folder picker on the owner's computer and
    sends back the path. Where there is no picker (Linux without one, or the agent is offline), a text
    field takes a path.
  - **A GitHub link**: a public repository URL (`https://github.com/owner/name`, with or without `.git`).
- Sources already used appear as chips, like the videos today, newest first. Removing a chip only hides it.
- **The brief.** One input for what the post is about ("the launch of tier gating", "what we learned about
  onboarding"). It may stay empty: then the posts pick the most interesting recent work.
- **The format**: X post, LinkedIn post or X article. **How many**: 1 to 6, default 3.
- **Create** starts a job. The progress shows its steps, the way every wait does: getting the repository,
  reading it, writing.
- The results are cards, like video posts. **Use** keeps one and opens it in Write. Dismiss hides it.
- One line under the source, said once: the repository's content goes to Claude to write the posts.

## Articles

- An X article is a title and a body of up to about 1,500 words, in plain paragraphs with short section
  headings.
- Write shows an article as a title field and a long text area, with the same AI bar (ask for a change,
  Humanize, Voice) working on the body.
- Publishing: **Copy** puts the title and body on the clipboard, and **Open X Articles** opens
  `https://x.com/compose/articles`. X has no way for an app to schedule an article, so the calendar gets a
  manual entry, like any post scheduled elsewhere.
- No LinkedIn version of an article in this piece.

## How it works

### The job

- A new job kind, `repo_posts`, with the payload
  `{ ideaId, source: { type: "folder", path } | { type: "github", url }, brief, format: "x" | "linkedin" |
  "article", count }`.
- The source is an `ideas` row, like a pasted video: a new idea kind `repo`, with `url` set to the GitHub
  URL or to `file://<path>` for a folder, `title` the repository name, and `meta` holding the source type.
  Re-running the same source reuses that row.
- Each result is an idea of a new kind `repo_post`, like `video_idea`, with `content` the text and `meta`
  holding `{ jobId, repoId, format, title? (articles), order }`. **Use** keeps it as a draft without a new
  job, like a video post.
- The job is a long one: it gets the doubled per-call time, inside the 9-minute job budget.

### Getting the repository (agent)

- **Folder**: the path must exist and be a directory. Nothing is copied.
- **GitHub**: the URL must match `https://github.com/<owner>/<name>`. The agent runs
  `git clone --depth 1` into `~/.postecho/repos/<owner>__<name>`, or `git fetch --depth 1` plus a hard reset
  of that clone when it already exists. Private or missing repositories fail with a clear message.

### Reading it (agent)

- Claude Code runs with the repository as its working directory and only read tools allowed: `Read`,
  `Glob` and `Grep`. No Bash, no edits, no network tools. The prompt asks it to look at the README, the
  docs and the code that the brief points to, then write.
- The output is structured as today: a JSON schema with the posts, validated by the agent.
- Limits per format: X posts up to 280 characters, LinkedIn 600-1,200, articles a title up to 100
  characters and a body up to 12,000.

### Picking a folder (agent)

- A short job kind, `pick_folder`, with no payload. On macOS the agent runs
  `osascript -e 'POSIX path of (choose folder)'` and returns the path, or `cancelled`. Elsewhere it fails
  with "no folder picker here", and the page shows the path field.
- The page waits for this job like any other, with a short timeout message if the agent is offline.

### Knowing what the agent can do

- The heartbeat already sends the agent's job kinds. The web now stores them (`agentKinds`). Creating a
  `repo_posts` or `pick_folder` job while the agent's last heartbeat doesn't list that kind shows "Update
  the agent: git pull, then restart npm run dev" instead of a job that waits forever.

## Data changes

- Postgres enums, appended: `idea_kind` gets `repo` and `repo_post`; `job_kind` gets `repo_posts` and
  `pick_folder`.
- `drafts` gets two nullable columns, `article_title` and `article_text`.
- The heartbeat route stores `agentKinds` in settings.

## Errors

- Agent offline: the job waits, with the existing "looks offline" hint.
- Agent too old for the job: the update message above, before any job is created.
- Folder missing, not a directory, or not readable: the job fails with that sentence.
- Clone fails: "This repository isn't public, or doesn't exist."
- Claude Code missing or logged out: the messages added on 2026-10-10.

## Testing

- Agent: unit tests for source resolution (folder checks, URL parsing, clone and update commands through a
  fake runner), for the read-only Claude arguments and working directory, for the prompt per format, and
  for the result schemas and limits.
- Web: tests for the new routes (create, re-run, use, dismiss), materialization into `repo_post` ideas,
  the article fields in drafts, the kind check against the heartbeat, and the renamed nav.
- One live run on this repository and on a public GitHub repository before calling it done.
