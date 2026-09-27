# Additional discovery-source adapters

Seven new source adapters live under `web/src/lib/sources/` (`adapter.ts`
defines the shared `SourceAdapter` interface; `registry.ts` exports them
all as `EXTRA_ADAPTERS`). Together with the original Hacker News/Bluesky
adapters (wrapped into the same shape by `builtin.ts`), all nine are wired
into the scout pipeline via `sources/all.ts`'s `ALL_ADAPTERS`/
`getEnabledAdapters` and `lib/scout-run.ts` — see that file's doc comment
for how the per-source query-variant/top-N result rules apply uniformly
across all nine. Every adapter shares the same contract: default result
limit 25, an 8s fetch timeout, `text` capped at 600 chars (HTML entities
decoded, tags stripped), results deduped by `url`, and any network/parse
failure degrading to `{ posts: [], status: "error" }` (one `console.warn`)
rather than throwing. A missing required env var degrades to `{ posts: [],
status: "disabled" }` without making any request.

## arXiv (`arxiv.ts`)

Searches arXiv's public Atom API (`export.arxiv.org/api/query`) across all
fields and returns papers linking to their abstract page (not the PDF).
Each result's `text` is the paper's title plus a truncated abstract; the
author field joins every listed author's name. **No key needed** — this
is a fully public, unauthenticated API with no published rate limit
beyond "be reasonable" (arXiv asks for no more than one request per few
seconds from a single client, which our usage pattern respects). No
practical limits for our volume.

## GitHub (`github.ts`)

Searches GitHub's repository search API (`api.github.com/search/
repositories`, sorted by stars) and returns each match's full name,
description, star/fork counts, owner, and last-push date. **No key
required** — unauthenticated requests get 60 requests/hour, which is
plenty at our volume. An optional `GITHUB_TOKEN` (a classic or fine-grained
personal access token, free, from github.com → Settings → Developer
settings → Personal access tokens; no scopes needed for public search)
raises that ceiling to 5,000/hour if we ever need it, but nothing is
gated on it — `github`'s adapter has no `requiredEnv`.

## dev.to (`devto.ts`)

Pulls articles from the Forem/dev.to public API (`dev.to/api/articles`).
**No key needed.** Limitation: dev.to's API has no full-text search
endpoint, only tag/username/"top" filters — so this adapter is tag-based,
not a true text search. It takes the first whitespace-delimited token of
the query (lowercased, non-alphanumeric characters stripped) and filters
by that as a tag, sorted by reactions within the last 30 days (`top=30`).
A multi-word query like "audio mixing tips" only ever filters on `audio`.

## Mastodon (`mastodon.ts`)

Reads a public Mastodon instance's hashtag timeline (`/api/v1/timelines/
tag/<hashtag>`, unauthenticated — this endpoint only ever returns public
posts). **No key needed.** Same tag-based limitation as dev.to: it uses
the query's first token as the hashtag, on a single instance. Defaults to
`mastodon.social` (the largest general-purpose instance); an optional
`MASTODON_INSTANCE` env var (e.g. `fosstodon.org`) points it at a
different one instead. `limit` is capped at 40 (the endpoint's documented
maximum) regardless of what's requested.

## YouTube (`youtube.ts`)

Searches videos via the YouTube Data API v3 (`youtube/v3/search`).
Returns each video's title, description, channel, publish date, and a
`youtube.com/watch?v=` link. **Requires `YOUTUBE_API_KEY`** — free from
the Google Cloud Console (console.cloud.google.com → APIs & Services →
enable "YouTube Data API v3" → Credentials → API key). The free quota is
10,000 units/day; a search call costs 100 units, so ~100 searches/day
before hitting the quota. `metrics` is intentionally empty — view/like
counts need a separate `videos.list` call per result, which this adapter
skips to avoid spending extra quota on every search. `maxResults` is
capped at 50 (the API's own maximum).

## Reddit (`reddit.ts`)

Uses Reddit's official OAuth "application-only" flow (`grant_type=
client_credentials`) to search posts (`oauth.reddit.com/search`, sorted by
top-this-month, links only, not comments). Returns each post's title,
a truncated selftext, author, score, comment count, and permalink.
**Requires `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`** — free, from
reddit.com/prefs/apps → "create app" → choose type "script"; the client ID
is shown under the app name, the secret next to "secret". An optional
`REDDIT_USERNAME` env var personalizes the required User-Agent string
(defaults to "postecho" if unset) — Reddit's API rules require a
descriptive, unique User-Agent, not a second credential. The OAuth access
token is cached in-process until it's close to expiry (Reddit's tokens
typically last 1 hour) rather than re-fetched on every search. Rate limit
for OAuth script apps is 100 queries/minute, far above our volume.

## Product Hunt (`producthunt.ts`)

Queries Product Hunt's v2 GraphQL API (`api.producthunt.com/v2/api/
graphql`). **Requires `PRODUCTHUNT_TOKEN`** — a free developer token from
producthunt.com/v2/oauth/applications (create an application, then use its
own access token directly; no user OAuth flow needed for read-only
queries). Important limitation: PH's `posts` field has no full-text search
argument (only `order`/`topic`/date-range filters) — so this adapter
fetches a fixed pool of the 50 most-voted recent posts and filters
client-side by whether any query token appears in the post's name,
tagline, or description. Results reflect "currently popular posts that
mention the query," not a relevance-ranked search of PH's full catalog.
Returns each matching post's name, tagline/description, vote count,
comment count, and a `producthunt.com/posts/<slug>` link (no author field
— PH posts don't have one canonical author the way a repo or article
does). PH's standard API rate limit is 6,250 complexity points per
15 minutes, comfortably above our per-search cost.

## Env vars (in `.env.example`)

```
# GitHub repo search (lib/sources/github.ts). OPTIONAL: unauthenticated
# search works fine (60 req/h); set this to raise the ceiling to 5,000/h.
# Get one at github.com → Settings → Developer settings → Personal access
# tokens (no scopes needed for public repo search).
GITHUB_TOKEN=

# Mastodon hashtag search (lib/sources/mastodon.ts). OPTIONAL: defaults to
# mastodon.social. Set to another public instance's hostname (e.g.
# fosstodon.org) to search there instead.
MASTODON_INSTANCE=

# YouTube Data API v3 search (lib/sources/youtube.ts). REQUIRED for this
# source to run — without it, YouTube search is skipped (disabled, no
# request made). Free from console.cloud.google.com: enable "YouTube Data
# API v3", then Credentials → API key. Free quota: 10,000 units/day (a
# search call costs 100 units, ~100 searches/day).
YOUTUBE_API_KEY=

# Reddit's official OAuth "application-only" search (lib/sources/
# reddit.ts). REQUIRED (both) for this source to run — without them,
# Reddit search is skipped. Free from reddit.com/prefs/apps → create an
# app of type "script"; REDDIT_CLIENT_ID is shown under the app name,
# REDDIT_CLIENT_SECRET next to "secret".
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
# REDDIT_USERNAME: OPTIONAL — personalizes the required User-Agent string
# Reddit's API rules ask for (defaults to "postecho" if unset). Not a
# credential; just identifies the app/author in the User-Agent header.
REDDIT_USERNAME=

# Product Hunt v2 GraphQL API (lib/sources/producthunt.ts). REQUIRED for
# this source to run — without it, Product Hunt search is skipped. Free
# developer token from producthunt.com/v2/oauth/applications (create an
# application, use its own access token — no user OAuth flow needed for
# read-only queries).
PRODUCTHUNT_TOKEN=
```

(arXiv, GitHub, and dev.to need no new required env vars — arXiv and
dev.to need none at all, and GitHub's `GITHUB_TOKEN` above is optional.)
