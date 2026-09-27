import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { setSetting } from "@/lib/settings";
import { AGENT_ONLINE_MS, loadSetupStatus, markOnboarded } from "@/lib/setup";

afterEach(() => vi.unstubAllEnvs());

describe("what the welcome checks (2026-09-26)", () => {
  it("reports each piece without ever a key's value", async () => {
    const db = await createTestDb();
    vi.stubEnv("TYPESAFE_API_KEY", "ts-secret-value");
    await setSetting(db as never, "topics", ["computer use agents"]);
    const now = new Date("2026-09-26T21:00:00Z");
    await setSetting(db as never, "agentLastHeartbeatAt", new Date(now.getTime() - 60_000).toISOString());

    const status = await loadSetupStatus(db as never, now);

    expect(status).toMatchObject({
      onboardedAt: null,
      topics: ["computer use agents"],
      agent: { online: true },
      jev: true,
    });
    // Keyless sources are counted; the ones needing a key are listed with the env names they need.
    expect(status.keylessSources.length).toBeGreaterThan(3);
    const bluesky = status.keyedSources.find((s) => s.name === "bluesky");
    expect(bluesky).toMatchObject({ ready: false, keyedBy: "server", requiredEnv: ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD"] });
    expect(JSON.stringify(status)).not.toContain("ts-secret-value");
  });

  it("an agent silent for more than three minutes is offline", async () => {
    const db = await createTestDb();
    const now = new Date("2026-09-26T21:00:00Z");
    await setSetting(db as never, "agentLastHeartbeatAt", new Date(now.getTime() - AGENT_ONLINE_MS - 1).toISOString());
    const status = await loadSetupStatus(db as never, now);
    expect(status.agent).toEqual({ online: false, lastHeartbeatAt: expect.any(String) });
  });

  it("marks the welcome done once, keeping the first time", async () => {
    const db = await createTestDb();
    const first = await markOnboarded(db as never, new Date("2026-09-26T21:00:00Z"));
    const again = await markOnboarded(db as never, new Date("2026-09-27T09:00:00Z"));
    expect(first).toBe("2026-09-26T21:00:00.000Z");
    expect(again).toBe(first);
    expect((await loadSetupStatus(db as never)).onboardedAt).toBe(first);
  });
});
