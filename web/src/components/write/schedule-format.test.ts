import { describe, expect, it } from "vitest";
import { formatRomeSlot, fromDatetimeLocal, toDatetimeLocal, xIntentUrl } from "./schedule-format";

describe("formatRomeSlot", () => {
  const now = "2026-09-22T12:00:00Z";

  it("labels a slot within the coming six days by weekday and Rome time", () => {
    expect(formatRomeSlot("2026-09-22T15:00:00.000Z", now)).toBe("Tue 17:00"); // CEST
    expect(formatRomeSlot("2026-09-28T08:00:00.000Z", now)).toBe("Mon 10:00"); // six days out, still weekday-only
    expect(formatRomeSlot("2026-01-15T16:00:00.000Z", "2026-01-15T10:00:00Z")).toBe("Thu 17:00"); // CET
  });

  it("reads midnight as 00, not 24, on the next Rome day", () => {
    expect(formatRomeSlot("2026-09-22T22:00:00.000Z", now)).toBe("Wed 00:00");
  });

  it("spells out the date beyond six days (and for a slot well in the past)", () => {
    expect(formatRomeSlot("2026-10-14T15:00:00.000Z", now)).toBe("Wed 14 Oct 17:00");
    expect(formatRomeSlot("2026-09-01T15:00:00.000Z", now)).toBe("Tue 1 Sept 17:00");
  });

  it("accepts `now` as a Date too", () => {
    expect(formatRomeSlot("2026-09-23T08:00:00.000Z", new Date(now))).toBe("Wed 10:00");
  });
});

describe("datetime-local helpers", () => {
  it("round-trips an instant through the browser-local input value", () => {
    for (const iso of ["2026-09-23T15:00:00.000Z", "2026-01-05T08:07:00.000Z", "2026-03-29T15:00:00.000Z"]) {
      const value = toDatetimeLocal(iso);
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(fromDatetimeLocal(value)).toBe(iso);
    }
  });

  it("accepts a value with seconds", () => {
    expect(fromDatetimeLocal(toDatetimeLocal("2026-09-23T15:00:00.000Z") + ":00")).toBe("2026-09-23T15:00:00.000Z");
  });

  it("rejects empty and malformed values", () => {
    expect(fromDatetimeLocal("")).toBeNull();
    expect(fromDatetimeLocal("2026-09-23")).toBeNull();
    expect(fromDatetimeLocal("garbage")).toBeNull();
    expect(fromDatetimeLocal("2026-13-45T25:61")).toBeNull();
  });
});

describe("xIntentUrl", () => {
  it("URL-encodes the text into the official post intent", () => {
    expect(xIntentUrl("hello world & #ai\nnew line")).toBe(
      "https://x.com/intent/post?text=hello%20world%20%26%20%23ai%0Anew%20line",
    );
  });
});
