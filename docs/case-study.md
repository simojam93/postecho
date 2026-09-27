# PostEcho: a case study

PostEcho finds what's worth posting about, writes it in my voice, and helps me schedule it on X and
LinkedIn. I designed it and built it with Claude Code. This page is about the decisions behind it: what I
wanted, the rules I held it to, and six calls that shaped how it works.

## The problem

Posting regularly is three jobs. You find something worth saying, you say it in your own words, and you
put it out at a good time. The tools I tried did one of two things. Some scrape and post on autopilot,
which breaks the platforms' rules and sounds like a bot. The others give you a blank editor and a
calendar, and leave the hard part to you.

I wanted something in between. It should do the searching and the first draft, sound like me, show its
work, and never post anything I haven't looked at. It had to be free to host, too. PostEcho is a
personal tool: one owner, one password, their own keys. It's open source, so anyone can run their own.

## The rules I held it to

- **Clean before anything.** If a screen looks busy, that's a bug. Remove before adding.
- **Say each thing once.** No copy that repeats what a title, a tooltip or a placeholder already says.
- **Explain only where it's needed.** A short tour for the sections that need one, and a single window
  the first time you open something new.
- **The shortest path.** No step that isn't needed. One click should take you where you meant to go.
- **Don't rebuild what the platforms already do.** X and LinkedIn schedule posts well, so PostEcho uses
  their schedulers.
- **The same problem gets the same solution.** Windows close with × or Esc everywhere, and the Archive is
  the same in two places.
- **Show the work while it happens.** Anything slow says what it's doing.
- **Ready to use, in my voice.** What it writes should be publishable as it is and sound like me.
- **It doesn't nudge.** The product suggests; I decide.

## Six decisions

### 1. Edit opens X's own scheduler

Scheduled posts live in X's and LinkedIn's own schedulers. An editor inside PostEcho would change
PostEcho's copy of a post but not the post itself, so every change would be made twice. Edit therefore
opens the real thing: X's list of scheduled posts, or LinkedIn's post box, since LinkedIn has no direct
link to its list. Neither platform lets an app read those posts back, so afterwards the card asks for the
one thing PostEcho needs to keep the calendar right: *Moved it?*, and the new time.

![Calendar: the posts scheduled on X and LinkedIn, each with Edit on the platform](media/calendar.png)

### 2. No "fits you" nudge

The cards used to carry a green dot when a post matched what I usually keep. It was useful, and that was
the problem: it pushed a choice before I'd read the post. The dot is gone. The ranking still learns from
what I keep and how my posts did, but the choice is visibly mine.

### 3. Every wait shows its steps

A search, three takes and twelve posts from a video take from a few seconds to a couple of minutes. Each
one shows its steps as they happen, with a timer and how long it usually takes, the way Claude Code shows
its work. The sidebar does the same when you're elsewhere: a turning glyph on the tab that's busy, then a
green tick for a moment when it's done.

### 4. A video becomes twelve ready posts, in my voice

This one took three tries. First, PostEcho wrote posts about a video. Then it listed topics to choose
from. The answer was simpler: twelve X posts, ready to publish, each on a different idea from the video
and written as my own view. They don't mention the video or link to it, because I add a credit when I
want one. They never hand me the speaker's story or results. Use opens one straight in the editor, with
no takes to pick, because the choice is already made.

![Video posts: twelve ready X posts from one video, best first](media/video-posts.png)

### 5. The archive keeps the workspace clean

Once a post is scheduled it leaves Write's strip of posts in progress and moves to an Archive. Write
shows only what still needs work. The Archive opens as the same window from Write and from Calendar.

### 6. One AI bar instead of a row of chips

The editor used to have:
- a heading;
- chips for "Shorter" and "Stronger hook";
- a row of versions;
- a hint about tags.

Now there's:
- one input, with the examples in its placeholder;
- one Humanize button;
- a small Voice menu;
- one row of actions.

The page does the same things and reads calmer.

![Write: three takes, the chosen one, and one bar to change it](media/write.png)

## The AI, in plain words

Two models do two different jobs.

- **Claude writes.** It runs as Claude Code on my Mac, headless and on my own plan. It writes from my best
  posts, a style guide and my own reference files.
- **Jev judges.** It is a model by TypeSafe built to answer typed questions with calibrated scores. It
  ranks what a search finds, flags spam and scores how human a text reads, out of 10. Humanize passes a
  draft back and forth between the two until Jev calls it human.
- **I decide.** Nothing is posted for me: every post goes out through X's and LinkedIn's own schedulers.
  The style guide learns from the takes I keep, and each change comes as a proposal I apply or dismiss.

The judging lives in [jev-judge](https://github.com/simojam93/jev-judge), a small open-source library, so
it can be used on its own.

## Constraints

- **Free to host:** Vercel's and Neon's free tiers, or just my Mac. The paid parts are services I already
  use or choose: my Claude plan, Jev, and X's API when I turn it on.
- **Official APIs and open sources only:** no scraping, no browser automation, nothing that acts as me
  on a platform.
- **One owner:** keys stay on the server and are never sent back to the browser.

## How it was built

Spec first. Every feature started as a short design and an implementation plan, and they are all in
[`docs/specs`](specs) and [`docs/plans`](plans). Then came tests, about 1,400 of them, then the change.
When I used it and something felt wrong, I said so and it changed the same day. Most of the decisions
above came from those moments.
