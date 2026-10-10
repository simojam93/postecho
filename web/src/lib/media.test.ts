import { describe, expect, it } from "vitest";
import { LONG_STALE_CLAIM_MS, mediaKindsFor, mediaOf, STALE_CLAIM_MS } from "./media";

describe("media from a repo (2026-10-11)", () => {
  it("screenshots and a video only for a folder on this computer", () => {
    expect(mediaKindsFor("folder")).toEqual(["images", "card", "screenshots", "video"]);
    expect(mediaKindsFor("github")).toEqual(["images", "card"]);
  });

  it("reads meta.media, leaving out anything that isn't an item", () => {
    expect(mediaOf({})).toEqual([]);
    expect(mediaOf({ media: "nope" })).toEqual([]);
    expect(mediaOf({ media: [
      { file: "card-a.png", kind: "card", kept: true, jobId: "j" },
      { file: "image-a-1.png", kind: "image", caption: "The gate", jobId: "j" },
      { file: 3, kind: "card" },
      { file: "x.png", kind: "gif" },
      null,
    ] })).toEqual([
      { file: "card-a.png", kind: "card", kept: true, jobId: "j" },
      { file: "image-a-1.png", kind: "image", caption: "The gate", kept: false, jobId: "j" },
    ]);
  });

  it("long media jobs get 45 minutes before a claim is stale, others 10", () => {
    expect(STALE_CLAIM_MS).toBe(10 * 60_000);
    expect(LONG_STALE_CLAIM_MS).toBe(45 * 60_000);
  });
});
