import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupStatus } from "@/lib/setup";
import { CalendarStep, ConnectStep, initialTopic, IntroStep, SearchStep, STARTER_TOPIC, topicOf, welcomeSteps, WriteStep } from "./welcome";

function status(over: Partial<SetupStatus> = {}): SetupStatus {
  return {
    onboardedAt: null,
    topics: [],
    agent: { online: true, lastHeartbeatAt: "2026-09-26T21:00:00.000Z" },
    jev: true,
    keyedSources: [],
    keylessSources: ["Hacker News", "arXiv", "GitHub"],
    ...over,
  };
}
const none = { connected: false, via: null, hint: null } as const;

describe("the welcome, redone (2026-09-27: \"l'onboarding a te sembra chiaro? mmm a me non molto\")", () => {
  it("starts the search field with the saved topic, or the starter search", () => {
    expect(STARTER_TOPIC).toBe("YC interesting posts");
    expect(initialTopic([])).toBe("YC interesting posts");
    expect(initialTopic(["  ", ""])).toBe("YC interesting posts");
    expect(initialTopic([" pricing ", "agents"])).toBe("pricing");
  });

  it("takes the field's text as the topic, tidied; nothing when it's empty", () => {
    expect(topicOf("  indie   SaaS ")).toBe("indie SaaS");
    expect(topicOf("   ")).toBeNull();
  });

  it("what it does, Connect only while Claude on the Mac or Jev is missing, the first search, then Write and Calendar while it runs", () => {
    expect(welcomeSteps(true, true)).toEqual(["intro", "search", "write", "calendar"]);
    expect(welcomeSteps(false, true)).toEqual(["intro", "connect", "search", "write", "calendar"]);
    expect(welcomeSteps(true, false)).toEqual(["intro", "connect", "search", "write", "calendar"]);
  });

  it("a page for Write and one for Calendar (2026-09-27: \"mostrare due altre pagine una per write e una per calendar\")", () => {
    const write = renderToStaticMarkup(createElement(WriteStep, { titleId: "t" }));
    expect(write).toContain("Write: pick a take, make it yours");
    expect(write).toContain(">Picked</p>");
    const calendar = renderToStaticMarkup(createElement(CalendarStep, { titleId: "t" }));
    expect(calendar).toContain("Calendar: your posts by date");
    expect(calendar).toContain("How did it do?");
  });

  it("says what PostEcho does, and draws the loop", () => {
    const html = renderToStaticMarkup(createElement(IntroStep, { titleId: "t" }));
    expect(html).toContain("Turn what you read into your next post");
    for (const part of ["Find Ideas", "Write", "Calendar", "Your posts by date"]) expect(html).toContain(part);
  });

  it("Connect: Claude and Jev in plain words, the optional sources folded away", () => {
    const html = renderToStaticMarkup(createElement(ConnectStep, {
      titleId: "t", status: status({ agent: { online: false, lastHeartbeatAt: null } }),
      connections: { jev: none, bluesky: { connected: true, via: "server", hint: "me.bsky.social" }, youtube: none, producthunt: none },
      onOpen: () => {},
    }));
    expect(html).toContain("Connect two things");
    expect(html).toContain('aria-label="Claude on your Mac: not connected"');
    expect(html).toContain("Writes your posts, on your own Claude plan.");
    expect(html).toContain('aria-label="Jev: not connected"');
    expect(html).toContain("Ranks what a search finds, and scores how human a post reads.");
    expect(html).toMatch(/<details[^>]*>[\s\S]*More sources \(optional\)[\s\S]*Ready without any key: Hacker News, arXiv, GitHub\.[\s\S]*<\/details>/);
    expect(html).toContain('aria-label="Bluesky: connected"');
    expect(html).toContain("finish this later in Settings › AI tools");
    expect((html.match(/>Connect<\/button>/g) ?? []).length).toBe(4); // Claude, Jev, YouTube, Product Hunt
  });

  it("the first search is one field, already written", () => {
    const html = renderToStaticMarkup(createElement(SearchStep, { titleId: "t", value: "YC interesting posts", onChange: () => {}, onSubmit: () => {} }));
    expect(html).toContain("Your first search");
    expect(html).toContain('value="YC interesting posts"');
    expect(html).not.toContain(">Add</button>");
  });
});
