# The agent wakes on demand — design

Date: 2026-10-10. Status: approved by the owner ("vai").

## Goal

The agent makes no requests to the web app while PostEcho isn't open, and none while it's open with
nothing to do. The page that creates a job wakes the agent directly, on the owner's computer, so a job
starts at once. On a hosted web app this takes the agent's requests from about half a million a month
(a claim every 5 seconds, day and night) to the ones that carry work.

## How it works

- **Asleep** is the default. The agent process keeps running, but it sends nothing: no claims, no
  heartbeat.
- **A local wake server.** The agent listens on `127.0.0.1` port `AGENT_WAKE_PORT` (default `47321`). It
  answers only requests whose `Origin` is the web app's origin (from `POSTECHO_URL`), and it answers the
  Private Network Access preflight with `Access-Control-Allow-Private-Network: true`.
  - `POST /awake` means the owner has PostEcho open. The agent wakes (or stays awake), sends a heartbeat
    if the last one is over 2 minutes old, and claims jobs until there are none.
  - `POST /wake` means a job was just created. The agent claims jobs until there are none, waking first
    if needed.
  - `GET /status` returns `{ awake, busy }` for the page.
- **Awake** lasts `AGENT_AWAKE_MINUTES` (default 10) after the last request from the page. While awake
  and idle it sends only a heartbeat every 2 minutes, so the app shows it online. After that it goes back
  to sleep. A job running when that time ends is finished and reported first.
- **The page.** The app shell, on every authenticated page:
  - sends `POST /awake` when the page loads, when it becomes visible again, and every 60 seconds while it
    is visible;
  - after any of its own requests to `/api/` that created a job, sends `POST /wake`. The routes that
    create jobs say so with a response header, `X-PostEcho-Job: <id>`, so the shell's fetch wrapper
    finds them all without each component knowing about the agent.
- **Jobs created without the owner** (the style-learning job from a heartbeat, the scout cron) wait until
  the next time PostEcho is opened. That's fine: nobody is waiting for them.
- **A safety net, off by default.** `AGENT_IDLE_CHECK_MINUTES` (default 0, meaning never) makes the asleep
  agent claim once every that many minutes. Useful for someone who creates jobs from a phone while the
  computer sits at home.

## Browsers

- The page is served from the web app's origin and calls `http://127.0.0.1:47321`. Chrome and the
  Chromium browsers allow it after a one-time "local network access" permission. A page on `localhost`
  (the local install) needs no permission.
- Safari blocks calls from an https page to the computer. When the wake call fails and the agent looks
  offline, the existing offline hint adds: "Open PostEcho in Chrome on the computer where the agent
  runs."

## Compatibility

- The claim loop, the job protocol and the result routes don't change. An agent without a wake server
  (an older version) keeps polling as before. A newer agent behind an older web app never gets woken, so
  the agent also wakes for `AGENT_IDLE_CHECK_MINUTES` if set; the release notes say to update both.
- `POLL_WAIT_SECONDS` and `POLL_IDLE_SECONDS` are kept for anyone who prefers polling: with
  `AGENT_WAKE_PORT=0` the wake server is off and the agent polls as it does today.

## Testing

- Agent: the state machine (asleep, awake, the timeout, a job finishing past the timeout), the wake
  server (origin check, preflight headers, the three routes), the claim-until-empty loop, the heartbeat
  cadence, polling mode with `AGENT_WAKE_PORT=0`, and the idle check.
- Web: the `X-PostEcho-Job` header on every route that inserts a job, and the shell's wake calls (on
  load, on visibility, every minute, after a job-creating response), with fetch faked.
- Live: on the local install, a job starts within a second of the click and the agent sends nothing for
  10 minutes after the tab closes. Then the same against the hosted app in Chrome, with a count of the
  requests in an hour of idle.
