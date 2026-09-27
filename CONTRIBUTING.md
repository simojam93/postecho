# Contributing to PostEcho

Thanks for looking. PostEcho is a self-hosted tool for one owner per install, and contributions that keep it
simple and useful are welcome: bug fixes, new sources, a better setup on your platform, another AI writer.
For anything bigger than a fix, open an issue first so we can agree on the shape.

## Set up

You need Node 22.9 or newer, on macOS or Linux. Claude Code is only needed to generate posts: the sample
data covers every screen, so most UI work doesn't need it.

```bash
npm run setup   # installs web/ and agent/, writes the env files, prepares the local database
npm run demo    # sample data in the local database
npm run dev     # the web app on http://localhost:3000, then the agent
```

## Checks

Run these before opening a pull request. CI runs them too, along with the three commands above on Linux.

```bash
npm test                                                # scripts, web and agent
cd web && npx next typegen && npx tsc --noEmit && npm run lint
cd agent && npx tsc --noEmit -p .
```

The tests use PGlite and fakes, so they need no network and no key. Every change comes with its tests.

## Where things live

| Path | What's there |
| --- | --- |
| `web/src/app/` | Pages and API routes (Next.js App Router). `api/agent/*` is what the agent talks to. |
| `web/src/components/` | The UI, one folder per section: `write/`, `plan/` (Calendar), `settings/`, `videos/`, `onboarding/`. |
| `web/src/lib/` | The logic: `scout-run.ts` (a search), `sources/` (one adapter per source), `drafts.ts`, `schedule.ts`, `materialize.ts` (turns the agent's results into rows). |
| `web/src/db/schema.ts`, `web/drizzle/` | The Drizzle schema and its migrations: add new ones with `npm run db:generate`, never edit old ones. |
| `agent/src/` | The daemon: `handlers.ts` (one per job kind), `prompts.ts`, `claude.ts` (runs `claude -p`). |
| `docs/specs/`, `docs/plans/` | The design and the plan behind each feature. |

## Adding a source

A source is one file in `web/src/lib/sources/` that implements `SourceAdapter` (`adapter.ts`):

1. It has a `name`, a `label`, a short `tag`, and `requiredEnv` for the keys it needs.
2. It has a `search(query, { fetcher, limit, env })` that returns posts.
3. You register it in `registry.ts`, and give it its label in `labels.ts`.
4. If it needs a key, add a guide in `web/src/lib/connection-guides.ts`, so Settings can explain how to get one.

It must use an official API or a public feed. Test it with a fake `fetcher`, as the other adapters do.

## Plugging in another AI writer

Today all the writing goes through the agent. Each handler calls
`deps.runClaudeJson({ prompt, system, schema, parse })`: a prompt goes in, and JSON that matches the
schema comes out. `agent/src/claude.ts` does this with `claude -p` on the owner's Claude plan.

Another writer would implement the same function and be chosen in `agent/src/main.ts`, alongside the
Claude runner. It could be a local model, another CLI or another API. The prompts in `prompts.ts` don't
depend on Claude, so they carry over. Open an issue first, so we agree on how it's chosen and configured.

## The project's rules

- **Official APIs and open sources only.** No scraping, no browser automation, nothing that posts as the
  owner: every post goes out through X's and LinkedIn's own schedulers, by a person.
- **Free to host.** Nothing may need a paid service to run, beyond the Claude plan that does the writing.
  Paid services like Jev and X's API stay optional.
- **Keys stay on the server.** They are never returned to the browser and never logged.
- **No hard deletes of the owner's data.** Removing something hides it or archives it.
- **Short copy, said once.** UI text is in English and never repeats what a title, a tooltip or a
  placeholder already says.

## Pull requests

- One change per pull request, with a commit message that starts with its kind: `feat`, `fix`, `docs`,
  `test`, `ci` or `chore`.
- Say what changed and why, with a screenshot for any UI change.
- By contributing, you agree that your work is released under the [MIT license](LICENSE).

Please follow the [code of conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).
