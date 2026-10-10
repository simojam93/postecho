# Schedule in a row — design

Date: 2026-10-10. Status: approved by the owner ("compose crea quelli ready to be scheduled, in calendar (che
magari diventa schedule come nome, dimmi tu) invece fai il discorso dello scheduling in modo sistematico").

## Goal

Compose many posts, then schedule them all in one sitting. Compose is where posts are written; Schedule
(today's Calendar, renamed) is where the ready ones are lined up and handed to X's and LinkedIn's own
schedulers one after the other, with each composer opened already filled in.

## What the owner sees

- **Names.** The section Calendar becomes **Schedule** (nav label, page title, onboarding and README). Its
  route stays `/calendar`. The week and month views stay inside it.
- **In Compose**, a finished post has **Ready**, next to Schedule. Ready takes the post out of Compose's
  strip of posts in progress and puts it in Schedule's list. A ready post opened from that list can be
  sent back with **Back to Compose**.
- **In Schedule**, a list at the top, **Ready to schedule**, shows the ready posts in the order they were
  made ready. Each row has the post's start, its platforms (X, LinkedIn or both) and a proposed time,
  which the owner can change. Rows can be reordered by changing times. The list is hidden when empty.
- **Proposed times.** From the owner's posting times (the existing posting-times setting), the first free
  slots from now on, one post per slot. A slot is taken by a post already scheduled at that time on that
  platform, or by another ready post. Changing one time doesn't move the others.
- **Schedule all** opens a guided sequence over the list, one post at a time:
  - "Post 2 of 6", the text, and the proposed time.
  - **Open X**: copies the X text and opens X's composer filled in (the same intent the single-post
    Schedule uses today). The owner sets the time in X's scheduler.
  - **Scheduled for …** confirms, with the time editable, and records it exactly as today's
    single-post schedule does.
  - Then, when the post has a LinkedIn version, the same for LinkedIn.
  - Then the next post, automatically.
  - **Skip** leaves the post in the list and moves on. **Stop** ends the sequence; what was confirmed stays
    scheduled.
  - At the end: "6 scheduled" and the week, with the new posts in it.
- Articles aren't part of this: X has no scheduler an app can open for them.

## How it works

- A draft gets a ready state. Use the existing draft model: a nullable `readyAt` timestamp on `drafts`
  (migration). Ready sets it; Back to Compose clears it; recording a schedule for every platform the post
  has clears it too, and the post then shows in the week as scheduled posts do today.
- Compose's strip and the In progress list exclude drafts with `readyAt` set.
- The proposed times are computed on the web from the posting-times setting and the scheduled posts, in a
  small pure function with tests (`lib/schedule-queue.ts`), the same time zone handling as the existing
  schedule code.
- The guided sequence reuses the single-post flow's pieces: the X intent and LinkedIn opener, the
  clipboard copy and the record-the-time call (`schedule-dialog.tsx` and its routes). No new way to
  schedule.
- Nothing posts by itself, as everywhere in PostEcho.

## Testing

- The slot function: free slots from now, skipping taken ones per platform, one per post, a changed time
  staying put, no posting times set (falls back to the next full hours).
- Routes: marking ready, back to Compose, the ready list, recording a schedule clearing `readyAt`.
- Components: Ready in Compose, the list in Schedule, the sequence's steps (X only, LinkedIn only, both,
  skip, stop), the rename in the nav and onboarding.
- Live: three posts made ready from Compose, Schedule all, the composers open in turn, and the week shows
  them.
