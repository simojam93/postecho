# postecho-agent

A small TypeScript CLI daemon that runs on the owner's Mac. It long-polls
`postecho-web` for jobs and executes them locally via **Claude Code headless**
(`claude -p`, the owner's Claude subscription — no API key, no per-token
cost). See `docs/plans/2026-09-21-m2-agent-generation.md` (Part B)
and spec §2.2 for the full design.

Kinds served: `generate_from_video`, `generate_from_idea`, `revise_draft`,
`image_prompt`, `analyze_style`, `video_ideas`, `learn_style`.

## Setup

`npm run setup` at the repository root writes `agent/.env`, and `npm run dev` there
starts the agent together with the web app. To set it up by hand instead:

```bash
cd agent
npm install
cp .env.example .env
```

Edit `.env`:

- `POSTECHO_URL` — where `postecho-web` runs (default `http://localhost:3000`).
- `AGENT_TOKEN` — copy the value of `AGENT_TOKEN` from `web/.env.local` (it must
  match the web app's own `AGENT_TOKEN`, since that's what authenticates every
  request this agent makes).
- `CLAUDE_BIN` / `CLAUDE_MODEL` — usually fine as-is (`claude`, `sonnet`).
- `POLL_WAIT_SECONDS` / `POLL_IDLE_SECONDS` / `CLAUDE_TIMEOUT_MS` — tuning knobs, defaults are sane. By default the agent asks for a job every 5 seconds and each request returns at once, so a hosted web app isn't kept running while it waits. Opus gets twice the Claude time, a whole-video read twice again, and no job runs past 9 minutes.

Requires Node 22.9 or newer and a logged-in Claude Code CLI on this Mac. Two ways to
authenticate the headless `claude -p` calls:

- **Interactive login** — run `claude` once and `/login`. Simple, but the stored
  token can expire while the daemon runs unattended (`claude auth status` may
  still say `loggedIn: true` even then — it reads the stored credential without
  checking it against the API).
- **Long-lived token (recommended for launchd)** — run `claude setup-token` and
  put the printed token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. The spawned
  `claude -p` child inherits it.

Whichever you pick, `npm run doctor` below tells you clearly whether the login
works headless right now. Note the CLI uses whatever account it is logged into
— check `claude auth status` if you have more than one Claude account.

## Running

```bash
npm run doctor   # sanity-checks the Claude CLI headless path (see below)
npm run dev      # starts the long-poll loop (Ctrl-C to stop, graceful)
npm test         # vitest
npm run lint     # tsc --noEmit
```

`npm run doctor` sends one trivial `{ ok: boolean }`-schema prompt through
`claude -p` and prints the CLI version and elapsed time — it's the fastest way
to confirm the subscription login works headless before trusting the agent
with real jobs. It does not require `postecho-web` to be running; if it also
reaches out for a heartbeat, a failure there is reported but non-fatal.

## Running as a background daemon (launchd)

Install it once (substituting your own absolute path to this directory):

```bash
sed -e 's|/ABSOLUTE/PATH/TO/postecho/agent|'"$PWD"'|g' \
  launchd/com.postecho.agent.plist.example > ~/Library/LaunchAgents/com.postecho.agent.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.postecho.agent.plist
```

Then:

- **Check it's alive:** `launchctl print gui/$UID/com.postecho.agent | grep state`
- **Logs:** `launchd/agent.out.log` and `launchd/agent.err.log` (paths set in the
  plist). The agent never logs prompt or transcript contents, only sizes and
  durations, so these are safe to leave on disk.
- **Restart** after editing `.env` or pulling new code:
  `launchctl kickstart -k gui/$UID/com.postecho.agent`
- **Stop / uninstall:** `launchctl bootout gui/$UID/com.postecho.agent`
  (`launchctl load` / `unload` are the older equivalents and still work).

The job keeps running with no terminal window open, starts again at login, and
retries on its own while `postecho-web` is unreachable (it logs `claimJob
failed: fetch failed` and backs off), so the web app and the agent can start in
any order. It uses the Claude Code credentials in the login keychain, so the
Mac has to be logged in — not just powered on.

The plist sets `KeepAlive` (restarts the process if it exits) and `RunAtLoad`
(starts it on login), matching the "always available while the Mac is on"
design goal.

## Design notes

- **No browser automation, ever.** Generation happens through the sanctioned
  Claude Code CLI surface; transcripts come from the public
  `youtube-transcript` library. If a transcript can't be fetched, the job
  fails with a message asking the owner to paste it in the app — never a
  proxy/IP/cookie workaround.
- **Never logs prompt or transcript contents** — only sizes and durations, so
  logs are safe to keep around for debugging timeouts.
- Single job concurrency, heartbeat every 60s, fresh profile fetch per job (so
  a tone-of-voice edit takes effect on the very next job, not the next
  restart).
