import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiTools, analyzeSteps, SettingsPanel, settingsPayload, type Settings } from "./settings-panel";
import { SettingsButton, SettingsLink } from "./settings-provider";
import { countLabel, FindOrderList } from "./find-order";

// Static renders (react-dom/server, node env): the settings load in an effect, so they read "Loading…" here.
describe("Settings, by category (2026-09-25)", () => {
  it("tabs on the left, the tab's settings on the right, one Save settings", () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { mode: "page" }));
    for (const tab of ["Profile", "Voice", "References", "Sources", "AI tools"]) {
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>(<svg.*?</svg>)?${tab}</button>`));
    }
    expect(html).toContain('aria-selected="true"');
    // AI tools apart from the sources; X lives among the sources (2026-09-25).
    expect(html).not.toMatch(/role="tab"[^>]*>(<svg.*?<\/svg>)?(Search|X|Services|Publishing)<\/button>/);
    expect(html).toContain(">Loading…</p>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save settings<\/button>/);
    expect(html).not.toContain('aria-label="Close settings"');
    // Sign out at the bottom left, under the tabs (2026-09-27).
    expect(html).toMatch(/<\/div><button type="button"[^>]*md:mt-auto[^>]*>(<svg.*?<\/svg>)?Sign out<\/button><\/aside>/);
  });

  it("every tab says what it's for; no Start here (2026-09-27: the tour does it)", () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { mode: "page" }));
    expect(html).toContain('data-tip="Your posts, so PostEcho writes like you"');
    expect(html).not.toContain("Start here");
  });

  it("Analyze my posts says its steps while it runs (2026-09-27)", () => {
    expect(analyzeSteps("queued")).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(analyzeSteps("claimed")).toEqual([{ label: "Your Mac picked it up", done: true }, { label: "Writing your style guide", done: false }]);
  });

  it("opens at the tab asked for", () => {
    const html = renderToStaticMarkup(createElement(SettingsPanel, { mode: "page", initialTab: "agent" }));
    expect(html).toMatch(/<h2[^>]*>AI tools<\/h2>/);
  });

  it("saves every field typed here, and nothing the server manages", () => {
    const s = {
      identityName: "S", identityHandle: "@s", identityAvatarUrl: "", topics: [],
      scoutMinScore: 60, scoutResultsTotal: 20, scoutCandidatesPerSource: 12,
      toneExamplesX: "", toneExamplesLinkedin: "", toneForm: { a: 1 }, styleGuide: "", imageSpecs: "",
      agentLastHeartbeatAt: "2026-09-25T10:00:00.000Z", styleGuideAnalyzedAt: null, xPostsPerSearch: 20, disabledSources: ["lemmy"],
      findOrder: ["opinion", "story"], claudeModel: "opus",
    } satisfies Settings;
    const payload = settingsPayload(s);
    expect(payload).toMatchObject({ identityName: "S" });
    // Posting times are Calendar's since 2026-09-27; reminder emails went with the Publishing tab.
    expect(payload).not.toHaveProperty("defaultSlots");
    expect(payload).not.toHaveProperty("notificationEmail");
    expect(payload.findOrder).toEqual(["opinion", "story", "problem", "news", "tool"]);
    expect(payload.claudeModel).toBe("opus");
    // A source's Connect window saves these at once.
    expect(payload).not.toHaveProperty("disabledSources");
    expect(payload).not.toHaveProperty("xPostsPerSearch");
    expect(payload).not.toHaveProperty("agentLastHeartbeatAt");
    expect(payload).not.toHaveProperty("toneForm");
    expect(payload).not.toHaveProperty("styleGuideAnalyzedAt");
  });

  it("the cog opens a window; a Settings link outside the app is the /settings page", () => {
    expect(renderToStaticMarkup(createElement(SettingsButton))).toContain('aria-label="Settings"');
    expect(renderToStaticMarkup(createElement(SettingsLink, { tab: "agent" }, "Settings"))).toContain('href="/settings"');
  });
});

describe("What to show you first (2026-09-26)", () => {
  it("lists the kinds in the saved order, numbered, with arrows that stop at the ends", () => {
    const html = renderToStaticMarkup(createElement(FindOrderList, {
      order: ["opinion", "story", "problem", "news", "tool"], counts: { story: { good: 3, bad: 1 } }, onChange: () => {},
    }));
    expect(html.indexOf("Strong opinions")).toBeLessThan(html.indexOf("Real stories with numbers"));
    expect(html).toContain("3 did well · 1 didn&#x27;t");
    expect(html).toMatch(/aria-label="Move Strong opinions up"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Move Tools and guides down"[^>]*disabled=""/);
    // Plain words: neither the judge's name nor its number.
    expect(html).not.toContain("Jev");
    expect(html).not.toContain("✦");
  });

  it("says nothing about votes before there are any", () => {
    expect(countLabel(undefined)).toBeNull();
    expect(countLabel({ good: 0, bad: 0 })).toBeNull();
    expect(countLabel({ good: 2, bad: 0 })).toBe("2 did well · 0 didn't");
  });
});

describe("AI tools (2026-09-26)", () => {
  const tools = (over: Partial<Parameters<typeof AiTools>[0]> = {}) => renderToStaticMarkup(createElement(AiTools, {
    heartbeatAge: 1, jev: { connected: true, via: "app", hint: "…abcd" }, claudeModel: "sonnet",
    onModel: () => {}, onSetUpClaude: () => {}, onConnectJev: () => {}, ...over,
  }));

  it("Claude with its Mac and its model, GPT coming soon, Jev with its key", () => {
    const html = tools();
    expect(html).toContain("Your Mac is connected · last heartbeat 1 min ago");
    expect(html).toContain(">Setup steps</button>");
    for (const model of ["Sonnet", "Opus", "Haiku"]) expect(html).toContain(`>${model}</span>`);
    expect(html).toMatch(/checked="" value="sonnet"/);
    expect(html).toContain("Coming soon");
    expect(html).toContain("Connected · …abcd.");
    expect(html).toContain(">Change key</button>");
  });

  it("offers to connect what isn't there yet", () => {
    const html = tools({ heartbeatAge: null, jev: { connected: false, via: null, hint: null } });
    expect(html).toContain(">Connect your Mac</button>");
    expect(html).toContain(">Connect Jev</button>");
    expect(html).toContain("Not connected yet.");
  });
});
