# Media from a repo — design

Date: 2026-10-11. Status: approved by the owner ("screenshot e video dal codice solo su repo mie, il resto
solo card o immagini già presenti nelle repo di altri").

## Goal

Give a post media, one post at a time, when the owner asks: images already in the repository, a card made
from the post, real screenshots of the app, or a short video made with the owner's brag-slim skill. Nothing
is added automatically.

## What the owner sees

- In Compose, a post from a repo (any format) has **Add media**. It opens a small menu:
  - **Images from the repo**: available for every repo source.
  - **A card**: available for every repo source.
  - **Screenshots**: only for a folder on this computer (the owner's own code).
  - **A video**: only for a folder on this computer.
- Each choice starts a job and shows its steps like every wait in PostEcho. Images and cards take seconds to
  a minute; screenshots a few minutes; a video 10-30 minutes.
- Results appear as thumbnails under the post. The owner keeps the ones they want (**Keep**) and removes the
  rest. A kept item shows **Show in Finder**.
- In Schedule's "Schedule all" sequence, a post's kept media appear next to **Open X** / **Open LinkedIn**
  with **Show in Finder**, so the file can be dragged into the composer. Neither platform lets an app attach
  a file, so this step stays manual.
- Posts written from other sources (searches, videos) don't get Add media in this piece.

## Why the split

Screenshots and videos need the project to run, which means running its code. That's fine for the owner's
own folders and not for a stranger's repository, so a GitHub source only gets images already in it and
cards.

## How it works

### Files stay on the computer

- Media files live in `~/.postecho/media/<draftId>/`. Nothing is uploaded: no storage cost, nothing on
  Vercel.
- The agent's wake server (127.0.0.1, same origin check) serves them to the page:
  - `GET /media/<draftId>/<file>` returns the file with its content type.
  - `POST /media/reveal` with `{ draftId, file }` runs `open -R` on it (macOS); elsewhere it answers 501.
  - Paths are confined to the media directory (no `..`, no absolute paths).
- The draft keeps the list in `drafts.meta.media`: `[{ file, kind: "image" | "card" | "screenshot" |
  "video", caption?, kept: boolean, jobId }]`. No migration.

### Jobs (agent)

One new job kind, `post_media`, with the payload `{ draftId, repoId, source, kind, postText, format }`,
where `kind` is `images`, `card`, `screenshots` or `video`. The agent checks that `screenshots` and `video`
only run for `source.type === "folder"` and refuses otherwise. The result is
`{ items: [{ file, kind, caption? }] }`.

- **images**: Claude Code reads the repository (read tools only, as for posts) and returns up to 6 image
  paths relative to the repo that fit the post, best first, with a one-line reason. The agent copies those
  files into the media directory (only common image formats, each under 10 MB).
- **card**: Claude returns the card's content as JSON (a headline under 60 characters, an optional
  supporting line, an optional big number). The agent renders it to a 1600×900 PNG (and 1080×1350 for
  LinkedIn posts) from an HTML template in the agent, with Playwright and the system Chrome. The look is
  neutral: dark background, light text, the repository's name small at the bottom. No PostEcho logo.
- **screenshots** (folders only): Claude Code runs in the folder with `Read Glob Grep Bash Write`, told to
  start the app the way its README or package scripts say, open the screens the post talks about with
  Playwright, and save up to 4 PNGs into the media directory, then stop what it started. The same hardening
  as posts (`--setting-sources user --strict-mcp-config`).
- **video** (folders only): Claude Code runs the brag-slim skill on the folder (`Skill` plus the tools the
  skill needs), with the post's text as the angle and the media directory as the output, then the agent
  keeps `brag.mp4` and `brag.jpg` from it.
- **Time.** `images` and `card` use today's budget. `screenshots` and `video` are long jobs: a 40-minute
  budget on the agent, and the web's stale-claim window for them becomes 45 minutes (per kind, not global).
- Progress phases: `reading`, `making`, `saving`.

### Web

- `POST /api/drafts/:id/media` with `{ kind }` checks the draft comes from a repo post, the kind is allowed
  for the source, and the agent serves `post_media` (the same 409 as for repo posts); it inserts the job
  with the `X-PostEcho-Job` header.
- The result adds items to `drafts.meta.media` (`kept: false`). `PATCH /api/drafts/:id` takes
  `media: [{ file, kept }]` to keep or remove; removing also asks the agent to delete the file through a
  `DELETE /media/<draftId>/<file>` on the wake server, called by the page.
- Compose renders thumbnails from `http://127.0.0.1:<port>/media/...`; when the agent can't be reached, it
  says the media are on the computer where the agent runs.

## Testing

- Agent: path confinement and origin checks on the media routes; the kind-by-source rule; each kind's
  handler with fakes (Claude, the renderer, the file copy); the card template; the long-job budget.
- Web: the route's checks (source, kind, agent), materialization into `meta.media`, keep/remove, the
  per-kind stale window, the Add media menu showing only the allowed kinds, thumbnails and Show in Finder,
  and media in the Schedule sequence.
- Live: a card and images for a post from `simojam93/jev-judge`; screenshots and a video for a post from
  `~/dev/postecho`.

## Made in the background (2026-10-11)

Owner: "sul post 2 di 10 voglio fare un video e lo lascio a creare mentre creo il resto".

- **Two lanes on the agent.** In wake mode the agent claims in two lanes, each one job at a time:
  `media` (screenshots and videos) and `rest` (everything else). The claim route takes `lane=media|rest`;
  without it, any job, as older agents ask. So a 30-minute video never holds up the next post.
- **A notice when it's ready.** `GET /api/jobs/active` names the post of a screenshots or video job
  (`media: { kind, ideaId, title }`). When one the page saw running ends, a notice in the corner of every
  page says "Video ready to check in “…”" (or that it didn't work), with Open (Compose, on that post)
  and ×. With PostEcho in the background, a notification of the Mac says it too: the page asks for that
  permission once, when the owner starts screenshots or a video.
- Under the wait: "Go on with your other posts: PostEcho tells you when it's ready."
- **A lost claim.** The heartbeat lists the jobs the agent is running; a claim over a minute old that isn't
  in it is marked failed ("The agent stopped before finishing. Try again."), so a post isn't blocked by
  "already making media" until the 45-minute sweep.
