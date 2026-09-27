import { describe, expect, it } from "vitest";
import { makeRateLimiter } from "@/lib/rate-limit";

describe("rate limiter", () => {
  it("allows 5 attempts then blocks within the window", () => {
    const t = 0;
    const allow = makeRateLimiter({ max: 5, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 5; i++) expect(allow("1.2.3.4")).toBe(true);
    expect(allow("1.2.3.4")).toBe(false);
  });

  it("resets after the window", () => {
    let t = 0;
    const allow = makeRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    allow("ip"); allow("ip");
    expect(allow("ip")).toBe(false);
    t = 1001;
    expect(allow("ip")).toBe(true);
  });

  it("tracks keys independently", () => {
    const allow = makeRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    expect(allow("a")).toBe(true);
    expect(allow("b")).toBe(true);
    expect(allow("a")).toBe(false);
  });

  it("blocked attempts do not extend the window", () => {
    let t = 0;
    const allow = makeRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    allow("ip"); allow("ip");        // window filled at t=0
    t = 500; expect(allow("ip")).toBe(false); // blocked mid-window
    t = 1001; expect(allow("ip")).toBe(true); // original window expired despite the blocked call
  });
});
