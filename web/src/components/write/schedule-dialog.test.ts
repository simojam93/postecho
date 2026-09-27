import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerFor, ScheduleDialog } from "./schedule-dialog";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
const render = (props: Partial<Parameters<typeof ScheduleDialog>[0]> = {}) => renderToStaticMarkup(createElement(ScheduleDialog, {
  draftId: "d1",
  targets: [{ platform: "x", text: "Ready for X" }, { platform: "linkedin", text: "Ready for LinkedIn" }],
  openedFirst: "x",
  now: "2026-09-24T15:00:00.000Z",
  flush: async () => true,
  onScheduled: () => {},
  onClose: () => {},
  ...props,
}));

describe("Write's Schedule window (2026-09-24)", () => {
  it("opens each platform's own composer with the text", () => {
    // X's full composer, where scheduling works (the share intent only posts now — 2026-09-25).
    expect(composerFor("x", "hi there")).toBe("https://x.com/compose/post?text=hi%20there");
    expect(composerFor("linkedin", "hi there")).toBe("https://www.linkedin.com/feed/?shareActive=true&text=hi%20there");
  });

  it("is a window in front of the page: schedule it there, then tell PostEcho the time, no emails", () => {
    const html = render();
    expect(html).toMatch(/^<dialog[^>]*aria-labelledby=/);
    expect(html).toContain(">Schedule</h2>");
    expect(html).toContain("Schedule it with each platform&#x27;s own scheduler, then tell PostEcho the time.");
    expect(render({ targets: [{ platform: "x", text: "only X" }] })).toContain("Schedule it with X&#x27;s own scheduler");
    expect(html).toContain("No emails.");
  });

  it("X, already open from the click: says where its scheduler is, offers it again, and records the time", () => {
    const html = render();
    expect(html).toContain("X is open in a new tab with its full composer. Your text is copied too: paste it if the box is empty, then use the calendar icon to schedule it.");
    expect(html).toContain("Open X again ↗");
    expect(html).toContain("The time you picked on X");
    expect(html).toContain(">Scheduled on X</button>");
  });

  it("LinkedIn has its own row, opened with its own click, and its clock icon", () => {
    const html = render();
    expect(html).toContain("Open in LinkedIn ↗");
    expect(html).toContain("Opens LinkedIn with your text: use the clock icon next to Post to schedule it.");
    expect(html).toContain(">Scheduled on LinkedIn</button>");
  });

  it("with both platforms nothing is opened yet: open X, then LinkedIn, from the window (2026-09-25)", () => {
    const html = render({ openedFirst: null });
    expect(html).toContain("Open in X ↗");
    expect(html).toContain("Opens X&#x27;s full composer. Your text is copied too");
    expect(html).toContain("Open in LinkedIn ↗");
    expect(html).not.toContain("is open in a new tab");
  });

  it("LinkedIn's row reminds to tag the names Claude noted, only when there are some (2026-09-25)", () => {
    const html = render({ targets: [{ platform: "x", text: "x" }, { platform: "linkedin", text: "Loved what Luke Smith (to tag on LinkedIn) said." }] });
    expect(html).toContain("Each name followed by (to tag on LinkedIn): type @ and the name in LinkedIn to tag them, then delete the note.");
    expect(render()).not.toContain("Each name followed by");
  });

  it("an X text over 280 characters can't be opened or recorded", () => {
    const html = render({ targets: [{ platform: "x", text: "x".repeat(281) }] });
    expect(html).toContain("The X text is over 280 characters: shorten it first.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Open X again ↗<\/button>/);
  });
});
