<p align="center">
  <img src="web/src/app/icon.svg" width="72" alt="">
</p>

<h1 align="center">PostEcho</h1>

<p align="center">
  Find what's worth posting about, write it in your own voice, and schedule it on X and LinkedIn.<br>
  Self-hosted and open source, on your own Claude plan.
</p>

<p align="center">
  <a href="https://github.com/simojam93/postecho/actions/workflows/ci.yml"><img src="https://github.com/simojam93/postecho/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e6e8ec" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/media/hero.gif" width="100%" alt="Trends, a video's posts, picking a take in Write, and the week in Calendar">
</p>

> **Who it's for:** anyone who posts on X and LinkedIn and wants a writing assistant they host themselves,
> one owner per install. The writing runs on [Claude Code](https://docs.claude.com/en/docs/claude-code/overview),
> so you need a Claude plan; the agent is the one place another AI would plug in
> ([how](CONTRIBUTING.md#plugging-in-another-ai-writer)). [Jev](https://typesafe.ai) is optional: it ranks
> what a search finds and scores how human a draft reads.

## What it does

**Find.** Search a topic and PostEcho looks through about ten open sources, from Hacker News and GitHub
to Bluesky and arXiv. What it finds comes back best first, ranked by Jev, a model built to judge text.

![Find Ideas: a search for design systems, best first](docs/media/find-ideas.png)

**Turn a video into posts.** Paste a YouTube link: PostEcho reads the whole video and writes twelve X
posts from it, in your voice, as your own ideas.

![Video posts: twelve ready X posts from one video](docs/media/video-posts.png)

**Write.** Use an idea and Claude writes three takes in your voice. Pick one, then change it in a chat:
shorter, more personal, a LinkedIn version.

![Write: three takes, the chosen one, and the chat to change it](docs/media/write.png)

**Calendar.** Schedule on X's and LinkedIn's own schedulers and see your week. Once a post is out,
PostEcho asks how it did, and the next search learns from the answer.

![Calendar: the week, and the posts scheduled on X and LinkedIn](docs/media/calendar.png)

## What makes it different

- **It writes like you.** Claude works from your best posts, your reference material and a style guide
  that improves from the takes you keep. You approve every change to it.
- **It tells you how human a text reads.** Jev scores your drafts out of 10 for how human they read, and
  Humanize rewrites one until it does.
- **It shows its work.** Anything that takes more than a few seconds says what it's doing, step by step,
  with the time it's taking.
- **It runs on your own Claude plan.** The writing happens in Claude Code on your computer: no API key, no
  bill per word.
- **No scraping, no autopilot.** Only official APIs and open sources, and nothing goes out without you:
  you schedule each post on X and LinkedIn yourself.
- **Free to host.** It runs on your computer, or online on Vercel's and Neon's free tiers. The services it
  uses bill you themselves: see [what it costs](#what-it-costs).

## Built by

[Simone Lovera](https://github.com/simojam93), CPO at [Forte AI](https://www.forte-ai.com), designed and
built PostEcho with Claude Code. The [case study](docs/case-study.md) tells the design decisions behind
it.

---

## Run it

You need macOS or Linux, Node 22.9 or newer, and
[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) logged in for the writing.

```bash
git clone https://github.com/simojam93/postecho && cd postecho
npm run setup   # installs, writes the keys, prepares the local database
npm run demo    # optional: sample data to look around
npm run dev     # then open http://localhost:3000
```

The setup asks for a password, or makes one. Everything runs on your machine with a local database, with no
account to create. Jev and the extra sources are optional: add their keys in Settings, which says what each
one adds. Without Jev, a search still saves what the sources find, unranked. To put PostEcho online, see
[docs/deploy.md](docs/deploy.md).

## What it costs

PostEcho itself is free, and so is hosting it. The services it uses bill you directly:

| | What for | Cost |
| --- | --- | --- |
| **Claude** | Writing: takes, edits, Humanize, a video's posts | Your Claude plan (Pro or Max), which Claude Code runs on |
| **Jev** by TypeSafe | Optional: ranking a search, spam, the human score, Humanize's target | TypeSafe's pricing |
| **X's API** | Optional: searching X | Billed by X per use |
| **Vercel, Neon** | Optional: hosting it online | Free tiers |

## How it works

```mermaid
flowchart LR
  you([You]) --> web["Web app<br/>Next.js on Vercel"]
  web --> db[("Postgres<br/>Neon, or PGlite locally")]
  web -- "puts jobs" --> queue[["Job queue"]]
  agent["Agent on your computer"] -- "takes jobs" --> queue
  agent --> claude["Claude Code<br/>claude -p"]
  web --> jev["Jev, through jev-judge<br/>rank · spam · human score"]
  web --> sources["Open sources<br/>Hacker News · GitHub · Bluesky · arXiv · …"]
```

The web app never writes with a model itself. It puts a job in the queue; the agent on your computer
long-polls for it, runs Claude Code headless on your own plan, reports each step, and sends the result
back. Judging goes through [jev-judge](https://github.com/simojam93/jev-judge), a small MIT library by the
same author: ranking what a search finds, spotting spam, scoring how human a text reads, and learning
your style from what you keep. A built copy is vendored in `web/vendor/`, so one clone is all you need.

| Folder | What's in it |
| --- | --- |
| [`web/`](web/) | The Next.js 16 app: Find Ideas, Write, Calendar, Settings and the API, with Drizzle on Postgres. |
| [`agent/`](agent/) | The daemon for your computer: takes jobs, runs `claude -p`, reports each step. |
| [`scripts/`](scripts/) | `setup` and `dev`, and `media`, which makes the screenshots above from the sample data. |
| [`docs/`](docs/) | The deploy guide, the case study, and the design spec and plan behind every feature. |

**Stack:** TypeScript, Next.js 16, React 19, Tailwind CSS 4, Drizzle ORM, Postgres (Neon) and PGlite,
Vitest, Claude Code, Jev by TypeSafe.

## Tests

```bash
npm test
```

About 1,400 tests across the web app, the agent and the scripts, on PGlite and fakes: no network, no keys.
CI runs them on every push.

## Contributing

Issues and pull requests are welcome: a bug, a new source, a smoother setup on your platform, another AI
writer. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up, run the checks and find your way around,
and the rules the project keeps. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report
vulnerabilities privately, as [SECURITY.md](SECURITY.md) says.

## License

MIT, see [LICENSE](LICENSE).
