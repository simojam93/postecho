import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { scheduledCount, sequenceDone, sequenceReducer, startSequence, type SequencePost } from "./schedule-all";
import { ScheduleAllDialog } from "./schedule-all-dialog";
import { toDatetimeLocal } from "@/components/write/schedule-format";

const xOnly: SequencePost = { draftId: "a", xText: "Only on X", linkedinText: null, platforms: ["x"], time: "2026-10-12T15:00:00.000Z" };
const linkedinOnly: SequencePost = { draftId: "b", xText: null, linkedinText: "Only on LinkedIn", platforms: ["linkedin"], time: "2026-10-13T07:00:00.000Z" };
const both: SequencePost = { draftId: "c", xText: "Both, X", linkedinText: "Both, LinkedIn", platforms: ["x", "linkedin"], time: "2026-10-13T15:00:00.000Z" };
// Already scheduled on X: only LinkedIn is left.
const leftOnLinkedin: SequencePost = { draftId: "d", xText: "Done on X", linkedinText: "Left on LinkedIn", platforms: ["linkedin"], time: null };

describe("Schedule all's steps (schedule in a row, 2026-10-10)", () => {
  it("one step per platform still to schedule, X before LinkedIn, post by post", () => {
    const state = startSequence([xOnly, linkedinOnly, both, leftOnLinkedin]);
    expect(state.steps.map((s) => [s.draftId, s.platform, s.text])).toEqual([
      ["a", "x", "Only on X"],
      ["b", "linkedin", "Only on LinkedIn"],
      ["c", "x", "Both, X"],
      ["c", "linkedin", "Both, LinkedIn"],
      ["d", "linkedin", "Left on LinkedIn"],
    ]);
    expect(state.steps.map((s) => s.post)).toEqual([0, 1, 2, 2, 3]);
    expect(state.posts).toBe(4);
  });

  it("recording a time moves on to the next step, then the next post; the last one ends it", () => {
    let state = startSequence([both, xOnly]);
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-13T15:00:00.000Z" });
    expect(state.steps[state.at]).toMatchObject({ draftId: "c", platform: "linkedin" });
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-13T15:05:00.000Z" });
    expect(state.steps[state.at]).toMatchObject({ draftId: "a", platform: "x" });
    expect(sequenceDone(state)).toBe(false);
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-12T15:00:00.000Z" });
    expect(sequenceDone(state)).toBe(true);
    expect(state.recorded).toEqual([
      { draftId: "c", platform: "x", publishAt: "2026-10-13T15:00:00.000Z" },
      { draftId: "c", platform: "linkedin", publishAt: "2026-10-13T15:05:00.000Z" },
      { draftId: "a", platform: "x", publishAt: "2026-10-12T15:00:00.000Z" },
    ]);
    expect(scheduledCount(state)).toBe(2);
  });

  it("Skip leaves the whole post and moves to the next one", () => {
    let state = startSequence([both, xOnly]);
    state = sequenceReducer(state, { type: "skip" });
    expect(state.steps[state.at]).toMatchObject({ draftId: "a", platform: "x" });
    // Skipped after X was recorded: its LinkedIn is left too, X stays scheduled.
    state = startSequence([both, xOnly]);
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-13T15:00:00.000Z" });
    state = sequenceReducer(state, { type: "skip" });
    expect(state.steps[state.at]).toMatchObject({ draftId: "a" });
    expect(scheduledCount(state)).toBe(1);
  });

  it("Stop ends it; what was confirmed stays", () => {
    let state = startSequence([xOnly, linkedinOnly]);
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-12T15:00:00.000Z" });
    state = sequenceReducer(state, { type: "stop" });
    expect(sequenceDone(state)).toBe(true);
    expect(scheduledCount(state)).toBe(1);
  });
});

const NOW = "2026-10-12T08:00:00.000Z";
const render = (posts: SequencePost[], initial?: ReturnType<typeof startSequence>) =>
  renderToStaticMarkup(createElement(ScheduleAllDialog, { posts, now: NOW, initial, onClose: () => {} }));

describe("Schedule all's window", () => {
  it("one post at a time: Post 1 of 3, its text, Open X, and Scheduled for its time", () => {
    const html = render([xOnly, linkedinOnly, both]);
    expect(html).toMatch(/^<dialog/);
    expect(html).toContain(">Post 1 of 3<");
    expect(html).toContain("Only on X");
    expect(html).toContain(">Open X ↗</button>");
    expect(html).toContain("Opens X&#x27;s full composer.");
    expect(html).toContain(`value="${toDatetimeLocal(xOnly.time!)}"`);
    expect(html).toContain(">Scheduled for Mon 17:00</button>");
    expect(html).toContain(">Skip</button>");
    expect(html).toContain(">Stop</button>");
    expect(html).toContain('role="progressbar"');
  });

  it("a LinkedIn step opens LinkedIn, with its own how-to", () => {
    const state = sequenceReducer(startSequence([xOnly, linkedinOnly]), { type: "recorded", publishAt: xOnly.time! });
    const html = render([xOnly, linkedinOnly], state);
    expect(html).toContain(">Post 2 of 2<");
    expect(html).toContain(">Open LinkedIn ↗</button>");
    expect(html).toContain("Opens LinkedIn with your text: use the clock icon next to Post to schedule it.");
    expect(html).toContain("Only on LinkedIn");
  });

  it("an X text over 280 characters can't be opened: skip it", () => {
    const long = { ...xOnly, xText: "x".repeat(281) };
    const html = render([long]);
    expect(html).toContain("The X text is over 280 characters: shorten it in Compose.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open X ↗<\/button>/);
  });

  it("at the end: how many were scheduled, and their days", () => {
    let state = startSequence([xOnly, linkedinOnly]);
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-12T15:00:00.000Z" });
    state = sequenceReducer(state, { type: "recorded", publishAt: "2026-10-13T07:00:00.000Z" });
    const html = render([xOnly, linkedinOnly], state);
    expect(html).toContain(">2 scheduled<");
    expect(html).toContain("Monday 12 October");
    expect(html).toContain("Tuesday 13 October");
    expect(html).toContain("17:00");
    expect(html).toContain(">Done</button>");
    expect(html).not.toContain(">Stop</button>");
  });
});
