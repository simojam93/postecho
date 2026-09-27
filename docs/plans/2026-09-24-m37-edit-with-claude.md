# PostEcho M3.7 — Edit with Claude, voice, human score 0–10, AI-style on cards

**Owner's words (2026-09-24):** "una mini chat con la preview copy che ti propone le cose dei tasti, humanize, write in 1st or 3rd person etc." · "chat con suggerimenti (ricordati che serve tutto in inglese)" · "dipende dalla provenienza come consigli tu" · "nel ricreare il post [LinkedIn] dovrebbe tenere o riprendersi il contesto del post originale ma tenendo in conto anche le modifiche di X" · "il tab AI slop… magari ho un testo da controllare però poi voglio usarlo per un post" · "sarebbe figo se anche i post cercati nel find ideas avessero un check di jev" · "lo vorrei più chiaro e su base dieci, tipo human 7/10" · Settings image specs and trend topics: "non hanno più senso di esserci".

## Shipped

- **Edit with Claude** (Write, below the texts; replaces Refine and the per-platform Slop check / Humanize buttons): a thread per post — each request above the version it produced, what changed, its human score, Restore for older versions — suggestions (Humanize, Update LinkedIn from X lit when X moved on, Write X/LinkedIn from the other, Write as mine / as a reaction, Shorter, Stronger hook) and a pen input. Every reply is a revise_draft job with `mode`, `voice`, the idea's source (full deep read first, 8000 chars) and the requests so far; the agent answers with only the changed fields plus Jev's score per platform (decision 3: one check per reply, the full loop only on Humanize; Humanize lights up when a platform reads as AI).
- **Update LinkedIn from X**: LinkedIn rewritten so it makes X's point from X's angle ("X leads: never contradict it, don't bring back what it dropped"), with the source for the detail X has no room for. Versions record `meta.xAtLinkedin`, so the suggestion lights up once X changes.
- **Voice** (lib/voice.ts): "mine" (first person, the owner's own) or "reaction" (someone else's post). Default by origin (the owner's note → mine, anything else → reaction), switchable on any post; the switch is remembered on the idea and on the version; generation (from-idea) sends it.
- Revisions now carry the untouched platform server-side (materialize), fixing Refine's old gap too.
- **Human score 0–10** everywhere (lib/human-score.ts): human = round((100 − slopScore)/10), label from the number (Human 7–10, Mixed 4–6, AI 0–3), badges "Human 8/10", the AI slop tab's meter AI → Human, trails "3 → 5 → 8".
- **AI-style on Find Ideas cards**: jev-judge `rateAiStyle` (checkSlop's rubric, 8 posts per call) on the saved results after the card summaries (≈3 calls per search, only while 52 s of the budget are unspent, texts under 80 chars skipped); `meta.aiStyle`, shown as "Human 8/10" next to ✦.
- **AI slop tab → Write**: "Use as a post" (POST /api/drafts/manual: the text unchanged as the chosen take, X if ≤ 280 else LinkedIn, voice mine) and "Write takes from it"; the humanized card has "Use as a post" too.
- **Settings**: Image prompts section and the topic list removed ("Trend topics" is now "Search": the per-search numbers); the daily scout cron removed from vercel.json.

## Notes

- jev-judge update: after `npm pack`, reinstall with `npm install jev-judge@file:vendor/jev-judge-0.1.0.tgz` — a plain `npm install` kept the cached tarball because the lockfile's integrity still matched the old one.
- Tests: web 1007+, agent 142, jev-judge 82.
