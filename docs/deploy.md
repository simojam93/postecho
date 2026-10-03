# Putting postecho online

Locally, postecho needs no account: `npm run setup` and `npm run dev` are enough. To reach it from your
phone, or to keep it running while your laptop sleeps, the web app goes on Vercel and its database on
Neon. The agent stays on your computer, because that's where Claude Code runs on your own plan. Both free
tiers are enough for one person.

## 1. The database

1. Create a project on [Neon](https://neon.tech) and copy the **pooled** connection string.
2. Create the tables from `web/`:

   ```bash
   cd web
   DATABASE_URL="postgres://…" npx drizzle-kit migrate
   ```

   Run the same command again after every update that adds a migration in `web/drizzle/`.

## 2. The web app

1. Create a Vercel project with `web/` as its root directory. The framework preset is Next.js
   (`web/vercel.json`).
2. Add the environment variables. [`web/.env.example`](../web/.env.example) explains each one and how
   to generate it.

   | Variable | |
   | --- | --- |
   | `DATABASE_URL` | the Neon string from step 1 |
   | `ADMIN_PASSWORD` | your login password |
   | `SESSION_SECRET` | `openssl rand -base64 32` |
   | `AGENT_TOKEN` | `openssl rand -hex 24`, shared with the agent |
   | `CAPTURE_TOKEN` | `openssl rand -hex 24` |
   | `CRON_SECRET` | `openssl rand -hex 24`, only for the daily search below |
   | `TYPESAFE_API_KEY` | optional: [Jev](https://typesafe.ai) ranks what searches find and scores how human a text reads |

   The keys of the extra sources (Bluesky, GitHub, Mastodon and the others) are optional too. Settings
   also takes some of them, stored in the database and never sent back to the browser.
3. Deploy:

   ```bash
   vercel deploy --prod --cwd web
   ```

## 3. The agent on your computer

The agent takes jobs from the web app and runs Claude Code headless. Point it at the deployed app in
`agent/.env`:

```bash
POSTECHO_URL=https://your-project.vercel.app
AGENT_TOKEN=the same value as the web app's AGENT_TOKEN
```

On a Mac, to keep it running in the background and have it start again at login, install it as a launchd
daemon: see [`agent/README.md`](../agent/README.md). For unattended runs, `claude setup-token` gives
it a long-lived login.

## 4. A daily search (optional)

`GET /api/cron/scout` runs "Search my topics" for the topics set in Settings, authenticated by
`CRON_SECRET`. To run it every morning, add a cron to `web/vercel.json`:

```json
{
  "framework": "nextjs",
  "crons": [{ "path": "/api/cron/scout", "schedule": "0 6 * * *" }]
}
```

Vercel sends `Authorization: Bearer $CRON_SECRET` on its own when that variable is set. The Hobby
plan allows one run a day.

## What it costs

- **Vercel Hobby and Neon's free tier:** free for a personal project; one person's posts are a few
  megabytes.
- **Claude:** your Claude plan (Pro or Max). The agent calls Claude Code on your computer, with no API key and
  no per-token bill.
- **Jev:** optional, billed by TypeSafe: it ranks what a search finds and scores how human a draft reads.
- **X's API:** optional and billed by X per use, only if you add your own key to search X.
