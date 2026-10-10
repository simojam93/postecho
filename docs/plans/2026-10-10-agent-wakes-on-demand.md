# The agent wakes on demand: implementation plan

Spec: `docs/specs/2026-10-10-agent-wakes-on-demand-design.md`.

**Goal:** the agent sends nothing while PostEcho is closed. The page wakes it on the computer when it is open and
when it creates a job.

**Approach:** TDD, one commit per task. The claim, run and report code moves out of `agent/src/main.ts` into a
testable worker, so the poll loop and the new wake mode share it. `main.ts` only wires things together.

## Tasks

1. **Agent settings** (`agent/src/config.ts`, `config.test.ts`). `AGENT_WAKE_PORT` (default 47321, 0 turns the
   wake server off), `AGENT_AWAKE_MINUTES` (default 10), `AGENT_IDLE_CHECK_MINUTES` (default 0, never).
2. **The worker** (new `agent/src/worker.ts`, `worker.test.ts`). `heartbeat()`, `claimAndRun()` (one claim, the
   handler, `postResult`), `drain()` (claim until empty, stops on a stop request or a failed claim) and
   `runPollLoop()` (today's loop, heartbeat every 60 s). `main.ts` runs the poll loop through it, behavior unchanged.
3. **The wake controller** (new `agent/src/wake.ts`, `wake.test.ts`). A state machine with injected clock and
   timers: asleep by default; `/awake` and `/wake` wake it for `AGENT_AWAKE_MINUTES` and drain; a heartbeat on waking
   when the last is over 2 minutes old, then every 2 minutes while awake; a drain that runs past the timeout finishes
   before sleep; the idle check claims while asleep; `stop()` waits for the current job.
4. **The wake server** (new `agent/src/wake-server.ts`, `wake-server.test.ts`). `node:http` on `127.0.0.1`. Origin
   must equal the web app's origin (403 otherwise), the preflight answers with the CORS and Private Network Access
   headers, `POST /awake`, `POST /wake` (204), `GET /status`. A taken port resolves to "not listening" instead of
   throwing.
5. **Wiring and agent docs** (`agent/src/main.ts`, `agent/README.md`, `agent/.env.example`). Wake mode when the port
   is set and free, else the poll loop with a clear log line. SIGINT/SIGTERM finish the current job, close the
   server, then exit.
6. **The job header** (new `web/src/lib/job-header.ts`, route tests). Every route that inserts a job for the owner
   answers with `X-PostEcho-Job: <id>`.
7. **The page wakes the agent** (new `web/src/lib/agent-wake.ts`, `agent-wake.test.ts`, new
   `web/src/components/agent-waker.tsx` in `AppShell`, `web/.env.example`). `/awake` on load, on becoming visible and
   every 60 s while visible; `/wake` after a same-origin `/api/` response that carries the header. Errors are
   swallowed and the last failure is remembered.
8. **The offline hint** (`web/src/components/write/post-state.ts`, `generation-progress.tsx`). It adds "Open
   PostEcho in Chrome on the computer where the agent runs." only when a wake call failed.
9. **Root README.** One sentence in "How it works".

## Checks

`cd agent && npx vitest run && npx tsc --noEmit -p .`, `cd web && npx vitest run && npx tsc --noEmit && npm run
build`, `node --test "scripts/**/*.test.mjs"`.
