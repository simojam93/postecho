# PostEcho goes open source — design

Date: 2026-09-27. Status: approved by the owner ("vai mi piace tutto mettilo su").

## Goal

Publish PostEcho as a public repository that anyone can run in a few commands and that says something to a
non-technical reader, a recruiter or an HR person, within a minute: what it does, why it's different, and
who built it. It is the first of four pieces of work; the others reuse its style.

## Owner decisions

- **Demo:** screenshots and a GIF made from sample data. No live demo, no video.
- **Setup:** one command on a Mac for a local install, plus a short guide for putting it online.
- **Names:** every repository in lowercase kebab-case: `postecho`, `jev-judge`, `better-prompter`,
  `cycling-routes`. The product keeps its casing in titles (PostEcho).
- **cycling-routes** stays public, in the same style. **free-tools** goes private.
- **No build timeline** in the README or the case study (owner: "togli quella parte e fine").
- **Publishing** happens only on the owner's explicit go, PostEcho together with jev-judge, since the
  README links to it.

## The four pieces, in order

1. **PostEcho** (this design).
2. **jev-judge:** the same README style, then public.
3. **GitHub in one style:** names, descriptions, topics, pinned repositories, free-tools private,
   better-prompter and cycling-routes brought in line.
4. **The owner's profile README.**

## 1. Repositories and history

- The private `PostEcho` repository is renamed `postecho-archive`. It stays private and keeps the whole
  history (247 commits). GitHub names are case-insensitive, so the rename frees `postecho`.
- Locally, the `origin` remote is renamed `archive` before anything is pushed, and the local history goes
  there. The new public `postecho` gets one orphan commit of the cleaned tree, authored by Simone Lovera, with his public git address. From then on, work continues on the public repository.

## 2. Clean-up before publishing

- Every tracked file is scanned for keys, tokens, passwords, personal emails, phone numbers and private
  URLs, including the specs and plans. Anything found is removed or rewritten.
- `docs/{specs,plans,reviews}` become `docs/specs`, `docs/plans` and `docs/reviews`.
  References in code comments and READMEs follow.
- The env files, `.pglite`, `.claude` and build output stay ignored, as today.

## 3. Setup in one command

From the repository root:

- **`npm run setup`**
  - checks Node and the Claude Code CLI; without Claude Code it warns and goes on;
  - installs `web/` and `agent/`;
  - writes `web/.env.local` and `agent/.env`:
    - generated `SESSION_SECRET`, `AGENT_TOKEN`, `CAPTURE_TOKEN` and `CRON_SECRET`;
    - a password the user types, or one generated and printed once;
    - no `DATABASE_URL`, so the app uses the local PGlite database;
    - the agent pointing at `http://localhost:3000`;
  - migrates the local database.

  It never overwrites an env file that already exists.
- **`npm run dev`** starts the web app and the agent together, with prefixed output. Ctrl-C stops both.
- **`npm run demo`** fills the local database with sample data, so the whole app can be seen without any
  key. It refuses to run when a `DATABASE_URL` is set, so it can't touch a real database.
- **`docs/deploy.md`** covers putting it online: Vercel, Neon, the env vars, the daily cron, and the agent
  pointing at the deployed URL.

## 4. Sample data and images

- The sample data is invented but believable: no post or data of the owner, no real accounts or handles.
  It covers:
  - Trends results with ✦ ranks and Human scores;
  - a pasted video with its 12 ready posts;
  - posts in progress with takes and a chosen version;
  - scheduled posts across the week;
  - an archive.
- Screenshots at 1512×827 in the dark theme: Find Ideas, Video posts, Write and Calendar.
- One GIF of 10–15 seconds with the core flow: search, pick, write, schedule.
- The screenshots and the GIF are captured with Playwright against the local app running the sample
  data, and the GIF is assembled with ffmpeg. They are stored in `docs/media/`, and the GIF is kept
  under about 5 MB.

## 5. The README, in English

**The top, for anyone:**
- mark, name, one line on what it does, and badges for CI and licence;
- the GIF;
- "What it does": Find, Write, Calendar, one plain sentence and one screenshot each;
- "What makes it different", in five or six plain bullets:
  - it writes like you;
  - it tells you how human a text reads;
  - it shows every step while it works;
  - it runs on your own Claude plan;
  - it uses no scraping, only official APIs;
  - it costs €0 a month;
- "Built by": Simone Lovera, CPO at Forte AI, designed and built with Claude Code, with links to the case
  study and the profile.

**The bottom, for developers:**
- quick start in three commands, and the requirements;
- how to put it online (`docs/deploy.md`);
- how it works: a Mermaid diagram of the web app on Vercel, the agent on the Mac, the job queue, Jev and
  the sources;
- the repository map, the stack and the tests;
- jev-judge and the licence.

## 6. The case study (`docs/case-study.md`, in English)

- **The problem and who it's for.**
- **The principles**, taken from the owner's working rules.
- **Six decisions and why:**
  1. Edit opens X's own scheduler instead of duplicating it.
  2. No "fits you" nudge on the cards.
  3. Every wait shows its steps and seconds.
  4. A video becomes 12 ready X posts in the owner's voice.
  5. The archive keeps the workspace clean.
  6. One AI bar instead of a row of chips.
- **The AI in plain words:** Claude writes on the owner's own plan, Jev judges, and a person decides.
- **The constraints:** €0 a month, official APIs only, no scraping.
- **Images** from section 4.

## 7. Continuous integration

- `.github/workflows/ci.yml` runs on every push and pull request, on Node LTS, with no secrets.
- For `web/`: install, type check, lint and tests.
- For `agent/`: install, type check and tests.
- The README shows its badge.

## 8. Repository metadata at publishing

- A description and topics.
- No homepage, because the owner's instance is private.
- A 1280×640 social preview built from the brand mark.

## Out of scope here

- jev-judge's README and publishing (piece 2).
- The GitHub-wide renames and the profile README (pieces 3 and 4).
- A live demo, a video, an npm package, a Deploy button.

## Success criteria

- From the top of the README, a non-technical reader knows within a minute what PostEcho does and why
  it's notable.
- A developer on a Mac goes from `git clone` to the app running with sample data in three commands.
- The public tree has no secret or personal data and a single commit, and CI is green.
