# Finishing PostEcho: the welcome, AI tools, PDF and Word

Date: 2026-09-26 · Status: approved in chat. The owner: "facciamo questa al primo ingresso",
"questi due… ok da fare anche", and on GPT: "non mi interessa usarlo con codex, voglio solo che
sia possibile per l'open source". This is the last round before the repo goes public.

## 1. The welcome, on first entry

A window over the app, shown once, right after the first login. It is stored as kv
`onboardedAt`, and Settings › Profile has "Show the welcome again". It has three steps.

1. **What do you post about?** 1 to 3 topics, prefilled from kv `topics`.
   - Next saves them to `topics` and runs one search per topic in the background
     (`POST /api/search`, one after another).
   - Each search that finishes tells Find Ideas to reload (a window event), so the grid fills
     while the owner reads on.
2. **What's connected.** One row per piece, with a green or red dot. Red rows get one line on
   how to connect. The window never asks for keys: they stay on the server, and the step only
   checks and explains.
   - Claude on your Mac, from the agent's heartbeat.
   - Jev, from whether `TYPESAFE_API_KEY` is set on the server.
   - The sources that need a key: Bluesky, YouTube, Product Hunt, and X, which is optional.
   - Reminder emails, optional: `RESEND_API_KEY` and the notification email.

   A "Check again" button refreshes the rows.
3. **How it works.** Find → Write → Plan, one line each, then "Start".

Closing the window, or Start, sets `onboardedAt`, and the window doesn't come back by itself.
`GET /api/setup` returns everything step 2 needs: booleans and names only, never a value.

## 2. The AI tools tab

It replaces the "AI agent" tab.

- **Who writes:** Claude on the owner's Mac through the PostEcho agent (Claude Code, `claude -p`),
  with the agent's status. GPT, through OpenAI's Codex CLI, is listed as "Coming soon". The owner:
  "non mi interessa usarlo con codex, voglio solo che sia possibile per l'open source", then
  "va solo messo tipo coming soon". A Codex runner was built and then reverted, so the code
  holds nothing half-done.
- **Who judges:** Jev, with whether its key is on the server, and what it does: ranks what you
  find, scores how human a post reads, and picks the best takes.

## 3. PDF and Word in References

The browser extracts the text. The file is never uploaded, and only its text reaches the
server, as with .txt and .md today.

- .pdf and .docx are supported. The old .doc is not, and says so.
- A scanned PDF with no text says so.
- The 20,000-character cap stays.

This part is built in a separate worktree and merged.

## Not in this round

- A public demo for reviewers: it comes with the GitHub work, after PostEcho is finished.
- Removing the login: every install holds its owner's data, paid keys and their Mac's Claude.
