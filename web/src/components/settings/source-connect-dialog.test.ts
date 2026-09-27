import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceConnectDialog, type SourceRow } from "./source-connect-dialog";

// Static renders (react-dom/server, node env) — createElement since vitest includes *.test.ts only.
const row = (over: Partial<SourceRow> & { name: string; label: string }): SourceRow => ({
  enabled: false, ready: true, off: true, keyedBy: "none", requiredEnv: [], ...over,
});
const render = (source: SourceRow, connected = false, connection: { connected: boolean; via: "app" | "server" | null; hint: string | null } | null = null) =>
  renderToStaticMarkup(createElement(SourceConnectDialog, {
    source, xStatus: { connected, hint: connected ? "…abcd" : null }, xPostsPerSearch: 20,
    onXKeyChanged: async () => {}, connection, onKeysChanged: () => {}, onConnect: async () => null, onClose: () => {},
  }));

describe("a source's Connect window (2026-09-25)", () => {
  it("a public source: nothing to set up, one Connect", () => {
    const html = render(row({ name: "hackernews", label: "Hacker News" }));
    expect(html).toContain("Hacker News is public: there&#x27;s nothing to set up.");
    expect(html).toContain(">Connect Hacker News</button>");
  });

  it("a source that needs a key: its steps and a real Connect; one already keyed turns back on (2026-09-26)", () => {
    const ready = render(row({ name: "bluesky", label: "Bluesky", keyedBy: "server", requiredEnv: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"] }), false,
      { connected: true, via: "server", hint: "me.bsky.social" });
    expect(ready).toContain("Connected on the server · me.bsky.social.");
    expect(ready).toContain(">Connect Bluesky</button>");
    const missing = render(row({ name: "youtube", label: "YouTube", keyedBy: "server", ready: false, requiredEnv: ["YOUTUBE_API_KEY"] }), false,
      { connected: false, via: null, hint: null });
    expect(missing).toContain("Enable the YouTube Data API v3");
    expect(missing).toContain(">Connect YouTube</button>");
    expect(missing).toContain(">Close</button>");
  });

  it("X: your key and budget only here; Connect once a key is saved, Save when editing", () => {
    const x = row({ name: "x_post", label: "X", keyedBy: "owner", ready: false, requiredEnv: ["X_BEARER_TOKEN"] });
    const noKey = render(x);
    expect(noKey).toContain('placeholder="Bearer token"');
    expect(noKey).toContain(">Save key</button>");
    expect(noKey).toMatch(/<button[^>]*disabled=""[^>]*>Connect X<\/button>/);
    expect(render(x, true)).toMatch(/<button(?![^>]*disabled="")[^>]*>Connect X<\/button>/);
    expect(render(x, true)).toContain("Key saved · …abcd");
    expect(render({ ...x, enabled: true, ready: true, off: false }, true)).toContain(">Save</button>");
  });
});
