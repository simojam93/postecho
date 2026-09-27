import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentEnvCommand, claudeSteps, KEY_GUIDES } from "@/lib/connection-guides";
import { GuideSteps } from "./guide-steps";
import { KeyConnectForm, statusLine } from "./key-connect";
import { SourceConnectDialog } from "@/components/settings/source-connect-dialog";

describe("every connection explained step by step (2026-09-26)", () => {
  it("each key's guide has its steps, a link to where the key is made, and its fields", () => {
    for (const guide of Object.values(KEY_GUIDES)) {
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.steps.some((s) => s.link?.href.startsWith("https://"))).toBe(true);
      expect(guide.fields.length).toBeGreaterThan(0);
    }
    expect(KEY_GUIDES.bluesky.fields.map((f) => f.name)).toEqual(["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"]);
  });

  it("the Mac's steps install Claude Code, get the agent, write its .env and start it", () => {
    const steps = claudeSteps(agentEnvCommand("https://postecho.example.com", "tok"));
    expect(steps[0].code).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(steps.map((s) => s.code).filter(Boolean)).toContain("npm run doctor && npm run dev");
    expect(steps[3].code).toBe("cat > .env <<'EOF'\nPOSTECHO_URL=https://postecho.example.com\nAGENT_TOKEN=tok\nEOF");
    const html = renderToStaticMarkup(createElement(GuideSteps, { steps }));
    expect(html).toContain("Copy");
    expect(html).toContain('href="https://code.claude.com/docs/en/setup"');
  });

  it("a key's form: what it adds, where the key lives, the steps and the fields", () => {
    const html = renderToStaticMarkup(createElement(KeyConnectForm, { guide: KEY_GUIDES.youtube, status: { connected: false, via: null, hint: null }, onChanged: () => {} }));
    expect(html).toContain("Videos from YouTube in your searches.");
    expect(html).toContain("Not connected yet.");
    expect(html).toContain("YouTube Data API v3");
    expect(html).toContain('type="password"');
    expect(html).toContain(">Connect YouTube</button>");
    expect(statusLine({ connected: true, via: "server", hint: "…1234" })).toBe("Connected on the server · …1234.");
  });

  it("Settings › Sources opens the same guide for a source that needs a key", () => {
    const html = renderToStaticMarkup(createElement(SourceConnectDialog, {
      source: { name: "producthunt", label: "Product Hunt", enabled: false, ready: false, off: false, keyedBy: "server", requiredEnv: ["PRODUCTHUNT_TOKEN"] },
      xStatus: null, xPostsPerSearch: 20, onXKeyChanged: async () => {}, connection: { connected: false, via: null, hint: null },
      onKeysChanged: () => {}, onConnect: async () => null, onClose: () => {},
    }));
    expect(html).toContain("Developer Token");
    expect(html).toContain(">Connect Product Hunt</button>");
    expect(html).not.toContain("environment variables");
  });
});
