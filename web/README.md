# PostEcho — web

The Next.js app: Find Ideas, Write, Calendar and Settings, the job queue the agent works from, and the
API behind them. The root [README](../README.md) has the full picture.

## Quick start

From the repository root: `npm run setup`, then `npm run dev`. To work on the web app alone, run
`npm run dev` here: it reads `web/.env.local`, which the setup writes.

Without `DATABASE_URL` the app uses a local PGlite database in `web/.pglite`, so no external setup is
needed. `npm run demo` fills it with sample data. Set `DATABASE_URL` (Neon) only to put the app online:
see [docs/deploy.md](../docs/deploy.md).

## Tests

```bash
npm test
```

Vitest with PGlite, an in-process Postgres, and `vi.mock("@/db")`. No network and no real database needed.

## Environment variables

[`.env.example`](.env.example) lists them all, with how to generate each one.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | online only | Neon Postgres connection string |
| `ADMIN_PASSWORD` | yes | The owner's login password |
| `SESSION_SECRET` | yes | Encrypts the session cookie (32+ characters) |
| `AGENT_TOKEN` | yes | Shared with the agent on your Mac |
| `CAPTURE_TOKEN` | optional | Lets outside feeders add ideas on `/api/ideas` |
| `CRON_SECRET` | online only | Authenticates the daily scout run |
| `TYPESAFE_API_KEY` | optional | Jev: ranking, spam and the human score |
