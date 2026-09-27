import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiv } from "@/lib/sources/arxiv";
import { bluesky, hackernews } from "@/lib/sources/builtin";
import { devto } from "@/lib/sources/devto";
import { github } from "@/lib/sources/github";
import { lemmy } from "@/lib/sources/lemmy";
import { lobsters } from "@/lib/sources/lobsters";
import { mastodon } from "@/lib/sources/mastodon";
import { producthunt } from "@/lib/sources/producthunt";
import { x } from "@/lib/sources/x";
import { youtube } from "@/lib/sources/youtube";
import { ALL_ADAPTERS, adapterByName, getEnabledAdapters } from "@/lib/sources/all";

function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const FULLY_KEYED_ENV = testEnv({
  BLUESKY_IDENTIFIER: "me.bsky.social",
  BLUESKY_APP_PASSWORD: "app-pass",
  YOUTUBE_API_KEY: "yt-key",
  REDDIT_CLIENT_ID: "id",
  REDDIT_CLIENT_SECRET: "secret",
  PRODUCTHUNT_TOKEN: "ph-token",
  X_BEARER_TOKEN: "x-token",
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ALL_ADAPTERS", () => {
  it("lists all eleven sources, hackernews and bluesky first, then the eight EXTRA_ADAPTERS in their documented order, X (opt-in, paid) last", () => {
    expect(ALL_ADAPTERS).toEqual([hackernews, bluesky, arxiv, github, devto, mastodon, lobsters, lemmy, youtube, producthunt, x]);
    expect(ALL_ADAPTERS.map((a) => a.name)).toEqual([
      "hackernews", "bluesky", "arxiv", "github", "devto", "mastodon", "lobsters", "lemmy", "youtube", "producthunt", "x_post",
    ]);
  });

  it("gives every adapter a unique name and tag", () => {
    expect(new Set(ALL_ADAPTERS.map((a) => a.name)).size).toBe(ALL_ADAPTERS.length);
    expect(new Set(ALL_ADAPTERS.map((a) => a.tag)).size).toBe(ALL_ADAPTERS.length);
  });
});

describe("getEnabledAdapters", () => {
  it("with no keys configured, enables exactly the seven keyless adapters", () => {
    const enabled = getEnabledAdapters(testEnv());
    expect(enabled.map((a) => a.name).sort()).toEqual(["arxiv", "devto", "github", "hackernews", "lemmy", "lobsters", "mastodon"]);
  });

  it("enables all eleven once every adapter's required env is present", () => {
    const enabled = getEnabledAdapters(FULLY_KEYED_ENV);
    expect(enabled.map((a) => a.name).sort()).toEqual(
      ["arxiv", "bluesky", "devto", "github", "hackernews", "lemmy", "lobsters", "mastodon", "producthunt", "x_post", "youtube"],
    );
  });

  it("enables a gated adapter as soon as just its own required env is present, independent of the others", () => {
    const enabled = getEnabledAdapters(testEnv({ YOUTUBE_API_KEY: "yt-key" }));
    expect(enabled.map((a) => a.name)).toContain("youtube");
    expect(enabled.map((a) => a.name)).not.toContain("bluesky");
    expect(enabled.map((a) => a.name)).not.toContain("reddit");
    expect(enabled.map((a) => a.name)).not.toContain("producthunt");
  });

  it("defaults to process.env when called with no argument", () => {
    vi.stubEnv("YOUTUBE_API_KEY", "yt-key");
    const enabled = getEnabledAdapters();
    expect(enabled.map((a) => a.name)).toContain("youtube");
  });

  it("preserves ALL_ADAPTERS' relative order in its output", () => {
    const enabled = getEnabledAdapters(FULLY_KEYED_ENV);
    expect(enabled).toEqual(ALL_ADAPTERS);
  });
});

describe("adapterByName", () => {
  it("returns the matching adapter for each of the eleven real names", () => {
    for (const adapter of ALL_ADAPTERS) {
      expect(adapterByName(adapter.name)).toBe(adapter);
    }
  });

  it("returns undefined for an unknown name", () => {
    expect(adapterByName("not-a-real-source")).toBeUndefined();
  });
});
