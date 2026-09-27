import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { editChanges, isEditable, LINKEDIN_SCHEDULED_TIP, MovedRow, RateCard, ScheduleCard, ScheduleEditDialog, SourceLink } from "./schedule-card";
import type { PlanPost, PlanStatus } from "./plan-calendar";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
function post(status: PlanStatus, over: Partial<PlanPost> = {}): PlanPost {
  return {
    id: "p1", draftId: "d1", platform: "x", text: "The scheduled text", status, publishAt: "2030-01-15T16:00:00.000Z",
    publishedUrl: null, error: null, emailedAt: null, publishedAt: null, ideaTitle: null, ...over,
  };
}
const render = (p: PlanPost) => renderToStaticMarkup(createElement(ScheduleCard, {
  post: p, now: "2030-01-15T10:00:00.000Z", busy: null, error: null, onAction: () => {}, onEdit: async () => null,
}));

describe("Plan's Edit (2026-09-24)", () => {
  it("is offered on queued, emailed and failed posts, never on posted, published or canceled ones", () => {
    for (const status of ["queued", "emailed", "failed"] as const) {
      expect(isEditable(status)).toBe(true);
      expect(render(post(status))).toContain(">Edit</button>");
    }
    for (const status of ["posted_manually", "published", "canceled"] as const) {
      expect(isEditable(status)).toBe(false);
      expect(render(post(status, { publishedUrl: "https://x.com/me/status/1" }))).not.toContain(">Edit</button>");
    }
  });

  it("saves only what changed", () => {
    const p = post("queued");
    expect(editChanges(p, "2030-01-15T16:00:00.000Z", "The scheduled text")).toBeNull();
    expect(editChanges(p, "2030-01-16T09:00:00.000Z", "The scheduled text")).toEqual({ publishAt: "2030-01-16T09:00:00.000Z" });
    expect(editChanges(p, "2030-01-15T16:00:00.000Z", "New text")).toEqual({ text: "New text" });
    expect(editChanges(p, null, "New text")).toEqual({ text: "New text" });
  });
});

describe("the Edit dialog (2026-09-24: \"una finestra davanti\")", () => {
  const dialog = (p: PlanPost) => renderToStaticMarkup(createElement(ScheduleEditDialog, {
    post: p, now: "2030-01-15T10:00:00.000Z", onSave: async () => null, onClose: () => {},
  }));

  it("is a modal dialog in front of the page, not part of the card", () => {
    expect(render(post("queued"))).not.toContain("<dialog");
    const html = dialog(post("queued", { ideaTitle: "Karpathy on Software 3.0" }));
    expect(html).toMatch(/^<dialog[^>]*aria-labelledby=/);
    expect(html).toContain("backdrop:bg-black/70");
    expect(html).toContain("Edit X post");
    expect(html).toContain("Karpathy on Software 3.0");
  });

  it("edits the time and the text, with the X counter, Cancel and Save changes", () => {
    const html = dialog(post("queued"));
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("The scheduled text</textarea>");
    expect(html).toContain("18/280");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain(">Save changes</button>");
    expect(html).toContain('aria-label="Close"');
  });

  it("says an emailed post is queued again, and LinkedIn has room and no counter", () => {
    expect(dialog(post("emailed"))).toContain("Saving queues it again, and a new email comes at the new time.");
    const li = dialog(post("queued", { platform: "linkedin", text: "A longer LinkedIn post" }));
    expect(li).toContain("Edit LinkedIn post");
    expect(li).not.toContain("/280");
    expect(li).toContain('rows="12"');
  });
});

describe("a post scheduled on X itself, in Plan (2026-09-24)", () => {
  it("reads as scheduled, says it goes out by itself, and offers Edit on X and Remove", () => {
    const html = render(post("scheduled"));
    expect(html).toContain(">scheduled</span>");
    expect(html).toContain("Scheduled on X: it goes out by itself.");
    expect(html).toContain(">Remove</button>");
    expect(html).not.toContain("Mark as posted");
  });
});

describe("Edit on the platform (2026-09-27: \"rimandarti all'editing dei scheduled post sia in X che in Linkedin\")", () => {
  it("opens X's scheduled posts in a new tab, not a window in Calendar", () => {
    const html = render(post("scheduled"));
    expect(html).toMatch(/<a href="https:\/\/x\.com\/compose\/post\/unsent\/scheduled" target="_blank" rel="noopener noreferrer"[^>]*>Edit on X ↗<\/a>/);
    expect(html).not.toContain(">Edit</button>");
  });

  it("opens LinkedIn's post box, saying where its scheduled posts are", () => {
    const html = render(post("scheduled", { platform: "linkedin" }));
    expect(html).toContain('href="https://www.linkedin.com/feed/?shareActive=true&amp;text="');
    expect(html).toContain(`data-tip="${LINKEDIN_SCHEDULED_TIP}"`);
    expect(html).toContain(">Edit on LinkedIn ↗</a>");
  });

  it("asks only for the time afterwards, Save live once it moved", () => {
    const html = renderToStaticMarkup(createElement(MovedRow, {
      post: post("scheduled"), now: "2030-01-15T10:00:00.000Z", onSave: async () => null, onDone: () => {},
    }));
    expect(html).toContain("Moved it?");
    expect(html).toContain('type="datetime-local"');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Save<\/button>/);
    expect(html).not.toContain("<textarea");
  });

  it("leaves PostEcho's own queue to the Edit window", () => {
    for (const status of ["queued", "emailed", "failed"] as const) {
      expect(render(post(status))).not.toContain("Edit on X");
    }
  });
});

describe("the text in Plan (2026-09-25)", () => {
  it("an X post reads whole; a LinkedIn one is clamped, with more", () => {
    expect(render(post("queued"))).not.toContain("line-clamp");
    expect(render(post("queued", { platform: "linkedin", text: "l".repeat(900) }))).toContain("line-clamp-3");
  });
});

describe("the source's link, for a first comment (2026-09-25)", () => {
  it("rides along on every card with a source, to open or copy", () => {
    const html = render(post("scheduled", { sourceUrl: "https://www.plausible.io/blog/bootstrapped" }));
    expect(html).toContain('href="https://www.plausible.io/blog/bootstrapped"');
    expect(html).toContain("plausible.io/blog/bootstrapped ↗");
    expect(html).toContain(">Copy link</button>");
    expect(render(post("posted_manually", { sourceUrl: "https://example.com/" }))).toContain("example.com ↗");
    expect(render(post("queued"))).not.toContain("Copy link");
  });

  it("shows the host and path, the full link in its tooltip", () => {
    const html = renderToStaticMarkup(createElement(SourceLink, { url: "https://news.ycombinator.com/item?id=41" }));
    expect(html).toContain('data-tip="https://news.ycombinator.com/item?id=41"');
    expect(html).toContain("news.ycombinator.com/item ↗");
  });
});

describe("How did it do? (2026-09-26)", () => {
  const rendered = (p: PlanPost) => renderToStaticMarkup(createElement(ScheduleCard, {
    post: p, now: "2030-01-15T10:00:00.000Z", busy: null, error: null, onAction: () => {}, onRate: () => {},
  }));

  it("asks on posts that are out, never on queued, emailed, failed or scheduled ones", () => {
    for (const status of ["posted_manually", "published"] as const) expect(rendered(post(status))).toContain("How did it do?");
    for (const status of ["queued", "emailed", "failed", "scheduled"] as const) expect(rendered(post(status))).not.toContain("How did it do?");
  });

  it("shows the vote pressed", () => {
    const html = rendered(post("posted_manually", { outcome: "good" }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Did well/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?Didn(&#x27;|')t land/);
  });

  it("the To rate list's card asks too", () => {
    const html = renderToStaticMarkup(createElement(RateCard, { post: post("published"), onRate: () => {} }));
    expect(html).toContain("How did it do?");
    expect(html).toContain("The scheduled text");
  });
});
