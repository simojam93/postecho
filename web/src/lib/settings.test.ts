import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";
import { getSetting, setSetting, SETTING_DEFAULTS } from "@/lib/settings";

describe("settings", () => {
  it("returns default when unset", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "leadTimeMinutes")).toBe(5);
  });

  it("defaults scoutMinScore to 60 and round-trips a new value", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "scoutMinScore")).toBe(60);
    await setSetting(db, "scoutMinScore", 80);
    expect(await getSetting(db, "scoutMinScore")).toBe(80);
  });

  it("defaults scoutResultsPerSource to 5 and round-trips a new value", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "scoutResultsPerSource")).toBe(5);
    await setSetting(db, "scoutResultsPerSource", 3);
    expect(await getSetting(db, "scoutResultsPerSource")).toBe(3);
  });

  it("defaults scoutResultsTotal to 20 and round-trips a new value", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "scoutResultsTotal")).toBe(20);
    await setSetting(db, "scoutResultsTotal", 30);
    expect(await getSetting(db, "scoutResultsTotal")).toBe(30);
  });

  it("defaults scoutCandidatesPerSource to 12 and round-trips a new value", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "scoutCandidatesPerSource")).toBe(12);
    await setSetting(db, "scoutCandidatesPerSource", 20);
    expect(await getSetting(db, "scoutCandidatesPerSource")).toBe(20);
  });

  it("round-trips a value", async () => {
    const db = await createTestDb();
    await setSetting(db, "topics", ["AI audio", "indie SaaS"]);
    expect(await getSetting(db, "topics")).toEqual(["AI audio", "indie SaaS"]);
  });

  it("defaults imageSpecs to empty string and round-trips a new value", async () => {
    const db = await createTestDb();
    expect(await getSetting(db, "imageSpecs")).toBe("");
    await setSetting(db, "imageSpecs", "16:9, minimalist, no text overlays");
    expect(await getSetting(db, "imageSpecs")).toBe("16:9, minimalist, no text overlays");
  });

  it("overwrites on second set", async () => {
    const db = await createTestDb();
    await setSetting(db, "notificationEmail", "a@b.c");
    await setSetting(db, "notificationEmail", "d@e.f");
    expect(await getSetting(db, "notificationEmail")).toBe("d@e.f");
  });

  it("exposes defaults for every key", () => {
    expect(Object.keys(SETTING_DEFAULTS).length).toBeGreaterThanOrEqual(8);
  });

  it("does not leak a mutated default array across dbs", async () => {
    const db1 = await createTestDb();
    const topics = await getSetting(db1, "topics");
    topics.push("mutated");

    const db2 = await createTestDb();
    expect(await getSetting(db2, "topics")).toEqual([]);
  });

  it("round-trips an explicit null value without throwing", async () => {
    const db = await createTestDb();
    await setSetting(db, "agentLastHeartbeatAt", "2026-01-01T00:00:00Z");
    // Should not throw a not-null violation when writing an explicit JS null.
    await setSetting(db, "agentLastHeartbeatAt", null);
    expect(await getSetting(db, "agentLastHeartbeatAt")).toBeNull();
  });
});
