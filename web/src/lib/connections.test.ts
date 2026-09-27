import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevClient } from "jev-judge";
import { createTestDb } from "@/test/db";
import { getSetting } from "@/lib/settings";
import { connectionStatuses, jevApiKey, loadAppKeys, removeServiceKeys, saveServiceKeys, serviceEnv, testService } from "@/lib/connections";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "a-session-secret-that-is-long-enough-1234");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("YOUTUBE_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("connections made in the app (2026-09-26: \"semplicissime per gli utenti\")", () => {
  it("keeps a pasted key sealed, says where it lives, and takes it back out", async () => {
    const db = await createTestDb();
    await saveServiceKeys(db as never, "youtube", { YOUTUBE_API_KEY: " yt-key-1234 " });
    const stored = await getSetting(db as never, "appKeys");
    expect(JSON.stringify(stored)).not.toContain("yt-key-1234");
    expect(await loadAppKeys(db as never)).toEqual({ YOUTUBE_API_KEY: "yt-key-1234" });
    expect((await connectionStatuses(db as never)).youtube).toEqual({ connected: true, via: "app", hint: "…1234" });
    await removeServiceKeys(db as never, "youtube");
    expect((await connectionStatuses(db as never)).youtube).toEqual({ connected: false, via: null, hint: null });
  });

  it("a key on the server still counts, and one pasted in the app wins over it", async () => {
    const db = await createTestDb();
    const base = { TYPESAFE_API_KEY: "server-key-aaaa", BLUESKY_IDENTIFIER: "me.bsky.social", BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop" } as unknown as NodeJS.ProcessEnv;
    const before = await connectionStatuses(db as never, base);
    expect(before.jev).toEqual({ connected: true, via: "server", hint: "…aaaa" });
    expect(before.bluesky).toEqual({ connected: true, via: "server", hint: "me.bsky.social" });
    await saveServiceKeys(db as never, "jev", { TYPESAFE_API_KEY: "app-key-bbbb" });
    expect((await serviceEnv(db as never, base)).TYPESAFE_API_KEY).toBe("app-key-bbbb");
    vi.stubEnv("TYPESAFE_API_KEY", "server-key-aaaa");
    expect(await jevApiKey(db as never)).toBe("app-key-bbbb");
    await removeServiceKeys(db as never, "jev");
    expect(await jevApiKey(db as never)).toBe("server-key-aaaa");
  });

  it("tests each service with one small call, and says what to fix", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }));
    const refused = (status: number) => vi.fn(async () => ({ ok: false, status, text: async () => "" }));
    expect(await testService("youtube", { YOUTUBE_API_KEY: "k" }, { fetcher: ok })).toBeNull();
    expect(await testService("youtube", { YOUTUBE_API_KEY: "k" }, { fetcher: refused(403) })).toMatch(/YouTube Data API v3/);
    expect(await testService("producthunt", { PRODUCTHUNT_TOKEN: "t" }, { fetcher: refused(401) })).toMatch(/Developer Token/);
    expect(await testService("bluesky", { BLUESKY_IDENTIFIER: "me.bsky.social", BLUESKY_APP_PASSWORD: "p" }, {
      fetcher: vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ accessJwt: "a", refreshJwt: "r", did: "did:plc:1", handle: "me.bsky.social" }) })),
    })).toBeNull();
    expect(await testService("bluesky", { BLUESKY_IDENTIFIER: "me.bsky.social", BLUESKY_APP_PASSWORD: "p" }, { fetcher: refused(401) })).toMatch(/app password/);

    const jevOk = { systemOne: vi.fn(async () => ({ answers: { slop: { score: 1, confidence: 0.9 }, filler: { noul: 0.1 } } })) } as unknown as JevClient;
    expect(await testService("jev", { TYPESAFE_API_KEY: "k" }, { jev: () => jevOk })).toBeNull();
    const jevRefused = { systemOne: vi.fn(async () => { throw new Error("401 Unauthorized"); }) } as unknown as JevClient;
    expect(await testService("jev", { TYPESAFE_API_KEY: "k" }, { jev: () => jevRefused })).toMatch(/refused the key/);
  });
});
