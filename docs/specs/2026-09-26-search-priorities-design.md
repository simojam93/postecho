# What comes first in Find Ideas, and learning from how posts did

Date: 2026-09-26 · Status: approved in chat (owner: "ottimo, vai pure e costruisci")

## Why

Search is where PostEcho earns its keep. The ideas that turned into posts so far were a real
story with numbers (Hacker News: a solo founder's $46k a month) and practical problems
(dev.to), and the owner's per-seat pricing post, an opinion, took off on LinkedIn. Today's
ranking is mostly topic relevance (45%), so flat but on-topic posts (repos, releases) crowd the
top: 28 of 128 saved cards were GitHub repos, and none of them became a post.

## What the owner decided

1. **Content first, topic as a gate.** A strong story or a strong opinion beats a flatter post
   that is more on topic, as long as it stays in the owner's area. The human score stays out
   of ranking: the owner rewrites everything anyway.
2. **Five kinds of post, ordered by the owner.** Settings shows them as a list to drag, with
   up and down arrows as well. Position is priority. It is a push, not a strict sort: a very
   strong post of a lower kind can still beat a weak one of a higher kind. Default order, the
   owner's:
   1. Real stories with numbers
   2. Strong opinions
   3. Practical problems
   4. News and launches
   5. Tools and guides (there for other people once PostEcho is open source)
3. **Plain words.** The new parts never say "Jev" or "rank": anyone must understand them.
4. **Nothing new on the result cards.** The kind stays behind the scenes, with no label. The
   **Aa** button leaves the card too: "Learn from its style" moves to a right-click menu on the
   card, or a long press on a phone.
5. **A tap in Plan, both ways.** Posts that are out get "How did it do?", with 👍 Did well and
   👎 Didn't land. A vote can be changed or removed. A "To rate (N)" pill collects the posts
   that have been out for more than a day and have no vote yet.
6. **Learning.** A 👍 makes the idea behind the post a "more like this" example, and a 👎 a
   "less like this" one. Votes come before ♥ and Skip, because they are real results. Good on
   one platform and bad on the other counts as good. Settings shows the count per kind ("3 did
   well · 1 didn't"). PostEcho never reorders the list by itself.

## Design

### 1. jev-judge 0.2.0: kinds, as a generic option

jev-judge is the owner's MIT library (`~/jev-judge`), vendored into PostEcho as a tarball. The
new ability is generic: the caller names its own kinds of post and how much it wants each.

```ts
type PostKind = { label: string; description: string; weight: number }; // weight 0..1
```

- **`judgePosts(client, { topic, posts, taste?, kinds?, options? })`.** When `kinds` is
  passed, each post gets one more question in the same `systemOne` call:
  `kind_${i} = { type: "choice", instructions: "Which kind of post is post <id>?", criteria:
  { [label]: description } }`.
- **What each judgment gains.** When `kinds` was passed (the fields are absent otherwise):
  - `kind: string | null`: the most probable label;
  - `kindFit: number | null`: Σ p(label) × weight(label), from 0 to 1. With no
    probabilities, the chosen label counts as p = 1.
- **`JudgeWeights` gains an optional `kind`** term, applied to `kindFit × 100`. The four
  weights must still add up to about 1. Default weights when `kinds` is passed:

  | | relevance | quality | taste | kind |
  | --- | --- | --- | --- | --- |
  | with taste | 0.15 | 0.25 | 0.25 | 0.35 |
  | without taste | 0.20 | 0.35 | 0 | 0.45 |

  Without `kinds`, the defaults and results are exactly those of 0.1.0.
- **Missing kind answer.** The rank uses the other terms, reweighted to add up to 1, so the
  post is neither rewarded nor penalized.
- **`options.relevanceGate: { floor, full }`.** The rank is multiplied by
  clamp((relevance − floor) / (full − floor), 0, 1). It needs 0 ≤ floor < full ≤ 100, or
  the call throws before contacting Jev.
- **Validation of `kinds`,** before any call: 2 to 12 entries, unique non-empty labels,
  weights from 0 to 1.
- **New export `classifyPosts(client, { posts, kinds, options? })`** returns
  `[{ id, kind, kindFit }]`. It asks only the kind question, chunked 8 posts per call with 4
  concurrent calls, and shares the question builder with `judgePosts`.
- **Release.** A README section "Rank by the kinds of post you want", and version 0.2.0. In
  PostEcho, `web/vendor/jev-judge-0.2.0.tgz` replaces the 0.1.0 tarball.

### 2. PostEcho: the kinds (`lib/find-kinds.ts`)

| id | Name in Settings | Example | Description for Jev |
| --- | --- | --- | --- |
| `story` | Real stories with numbers | "How I got to 1,000 users in 3 months" | A first-hand story with concrete numbers: revenue, users, growth, costs, a before and after. |
| `opinion` | Strong opinions | "Per-seat pricing is dead" | A strong, arguable opinion or prediction that people will agree or disagree with. |
| `problem` | Practical problems | "My AI assistant keeps bringing back a bug I fixed" | A practical problem, question or pain someone has, that invites an answer or a how-to. |
| `news` | News and launches | "Company X releases version 2" | An announcement, a launch, a release, a funding round or other news. |
| `tool` | Tools and guides | "A new open source repo, a tutorial, a list" | A tool, library or repo, a tutorial, a guide or a curated list. |
| `other` | (hidden) | | None of the above: a joke, a meme, a bare link, an empty or off-format post. |

- **Weight by position:** 1, 0.9, 0.8, 0.5, 0.3. `other` always weighs 0.15. The first three
  stay close, because the owner likes all of stories, opinions and problems. The last two drop
  well below.
- **`normalizeOrder(stored)`** keeps the known ids in their stored order, drops unknown ids
  and duplicates, and appends the missing ids in default order. A broken setting therefore
  becomes a valid order.
- **`jevKinds(order)`** turns an order into jev-judge's `PostKind[]`, plus `other`.
- **Relevance gate:** `{ floor: 10, full: 35 }`, lenient on purpose. Jev measures relevance
  against the search's own words, not against the owner's whole area. Relevance is an
  expected value over Jev's five levels (0, 25, 50, 75, 100):
  - off topic (under 10) sinks;
  - "tangentially related" (25) keeps 60% of its rank;
  - from 35 up, the topic no longer holds a post back.
- **Calibration, 2026-09-26.** The first values (steps of 0.2, gate 20–50) were run on the
  128 saved ideas. They buried the owner's own used ideas whenever those were judged against a
  search's narrower topic. The dev.to problem post, for example, fell from 62 to 29. With
  these values, the top 20 of the saved ideas are 13 stories, 4 opinions, 2 news and 1
  problem, with no repos.

### 3. Settings

- **The order lives in kv** as `findOrder`, default `["story","opinion","problem","news","tool"]`.
  PUT /api/settings accepts it as an array of the five ids, each once. Save settings sends it
  with the rest (`settingsPayload`).
- **GET /api/settings** adds two things:
  - `kindCounts`: `{ [id]: { good, bad } }` from rated ideas (see §6);
  - `rated` in `tasteCounts`.
- **Sources tab, top: a group "What to show you first".**
  - Hint: "Drag to reorder. Types higher up come first in your searches. PostEcho also
    learns from what you like, dismiss and rate in Plan."
  - One row per kind: drag handle, position number, name, example in quotes, the count when
    there is one ("3 did well · 1 didn't"), and up and down arrow buttons.
  - Drag uses native drag and drop on desktop. The arrows cover touch and the keyboard.
- **The three technical settings move into an "Advanced" disclosure,** closed by default, at
  the end of the Sources tab. Their labels lose "✦ rank": "Minimum score", "Results per
  search", "Candidates per source". The group hint drops "Jev".

### 4. Search (`lib/scout-run.ts`)

- **Each run** loads `findOrder` once and calls `judgePosts` with `kinds: jevKinds(order)`
  and `options.relevanceGate`. The weights are jev-judge's defaults with kinds.
- **Each saved idea** keeps `meta.postKind` and `meta.kindFit` next to today's score, quality,
  tasteFit and rank.
- **Everything else stays as it is:** the minimum score, the global top N, the rounds, and
  the degraded path when Jev fails.

### 5. Plan ratings

- **Migration 0012,** additive: enum `post_outcome ('good','bad')`, plus nullable
  `scheduled_posts.outcome` and `scheduled_posts.rated_at`.
- **`rateSchedule(db, id, outcome | null, now)`.**
  - Only for a post that is out: `published` or `posted_manually`, with `publishAt ≤ now`.
    Any other post gets code `not_out`, which is HTTP 409 "this post isn't out yet".
  - `null` clears the outcome and `rated_at`.
- **PATCH /api/scheduled-posts/:id** also accepts `{ outcome: "good" | "bad" | null }`,
  alone, never mixed with an edit. After the response (`after()` from `next/server`), when
  the draft's idea has no `meta.postKind`, PostEcho classifies it with `classifyPosts` and
  stores the result. This is best effort: a failure is logged and the vote stays.
- **GET /api/scheduled-posts?toRate=1** returns the posts that are out, not rated, and whose
  `publishAt` falls between 60 days ago and 24 hours ago, newest first, up to 50.
- **The card of a post that is out** shows "How did it do?", with 👍 Did well and
  👎 Didn't land as toggles (`aria-pressed`). Tapping the pressed one clears the vote. Posts
  scheduled on the platform get the row once their time has passed.
- **The Plan header gets a "To rate (N)" pill** next to Archive, hidden at zero. It swaps
  the day list for the list of posts to rate. A vote takes a card off that list at once, and
  both the list and the month are fetched again.

### 6. Learning (`lib/taste.ts`)

- **Rated ideas.** Take the ideas behind rated posts, leaving out YouTube ideas and ideas with
  no content, as today. An idea is good when any of its posts is 👍, and bad when every rated
  post is 👎. They are ordered by their latest vote.
- **Taste examples.**
  - `kept` starts with the good rated ideas, then used or ♥ ideas by recency. Ideas rated bad
    are left out, and no idea appears twice.
  - `skipped` starts with the bad rated ideas, then dismissed ideas.
  - Both lists stay capped at 15 items of 400 characters.
- **`kindCountsOf(rated)`** counts good and bad per kind id over the rated ideas (`loadRatedIdeas`) that have a
  `meta.postKind` among the five.

### 7. The card's right-click menu (`components/idea-card.tsx`)

- **The Aa button goes.** A right-click anywhere on the card opens a small menu at the
  pointer with one item: "Learn from its style", or "Stop learning from its style" when the
  post is already in the style inspiration. The menu exists only when today's Aa would have
  shown.
- **The browser keeps its own menu** when the target is inside a link, an input or a textarea,
  or when there is selected text inside the card.
- **Phones: a long press** of 500 ms on touch opens it. Moving more than 10 px or lifting the
  finger cancels it, and opening swallows the next click. On coarse pointers the card turns
  off text selection and the iOS callout.
- **The menu itself.**
  - It is fixed and clamped to the viewport, with `role="menu"` and focus on its item.
  - Esc, a click outside, scrolling, resizing or losing focus closes it, and focus goes back
    where it was.
  - The keyboard's context-menu key on a focused button in the card opens it at the card's
    corner.
- **The AI-style confirm stays** before learning from a post that reads as AI.
- **Settings › Voice copy:** "Posts by other people whose style you like: right-click a card in
  Find Ideas (long-press on a phone) and pick Learn from its style."

## Errors

- **No kind answer from Jev:** no kind, and the rank comes from the other signals.
- **A missing or broken `findOrder`:** it is normalized, falling back to the default order.
- **Voting on a post that isn't out:** 409, and the buttons aren't shown then anyway.
- **The kind can't be backfilled:** it's logged, and the vote stands.
- **Fewer results clear the minimum:** the search already retries up to 4 rounds, then shows
  what it has. The calibration below may lower the minimum score from its default of 60.

## Testing

- **Before switching on: calibration,** in a one-off script that is deleted afterwards and
  writes nothing. It re-judges the saved scout ideas with the new kinds and the gate, prints
  the old and new rank and the kind, and lists the top 20. What to check:
  - the ideas behind the Plan posts (SubmitHub and the two dev.to ones) land near the top;
  - how many ideas still pass 60.

  If they don't, adjust the gate or the minimum score.
- **Automated tests.**
  - jev-judge: the kind question, the `kindFit` math, a missing kind answer, the gate and its
    validation, kinds validation, the defaults with and without taste, `classifyPosts`, and
    the unchanged 0.1.0 tests.
  - PostEcho, the kinds: weights by position, `normalizeOrder`, `jevKinds`.
  - PostEcho, Settings: `findOrder` validation, `settingsPayload`, and the reorder helper.
  - PostEcho, search: the run passes the kinds and stores `postKind`.
  - PostEcho, ratings: `rateSchedule` (out or not, change, clear), the to-rate query (24 h,
    60 days, unrated only), and the PATCH route's outcome branch.
  - PostEcho, learning: taste order (good first, bad first, good wins, YouTube left out) and
    `kindCountsOf`.
  - PostEcho, the right-click menu: when the browser's menu stays, and when a long press
    fires.
  - PostEcho, rendering: the rating row appears only on posts that are out.
- **After deploy,** the owner and Claude run one real search together and read the top 20.

## Rollout

1. jev-judge 0.2.0: tests, build, pack, then vendor it into PostEcho.
2. Migration 0012 in production. It is additive.
3. Deploy with `vercel deploy --prod --yes --scope <your-team> --cwd web`.
4. Check in production:
   - Settings returns `findOrder`;
   - a search stores `postKind`;
   - a vote on a post that is out saves;
   - the To rate pill counts.

## Not in this round

- The list reordering itself from votes.
- Weights per source.
- Kind labels or kind filters on cards.
- Reading real engagement numbers from X or LinkedIn.
