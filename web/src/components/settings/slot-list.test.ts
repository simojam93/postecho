import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_SLOTS, nextSlot, normalizeSlots, SlotList } from "./slot-list";

describe("default slots with a time picker and + (2026-09-27)", () => {
  it("a picker and a × per slot, and + to add one", () => {
    const html = renderToStaticMarkup(createElement(SlotList, { platform: "X", slots: ["17:30", "22:30"], onChange: () => {} }));
    expect(html.match(/<input type="time"/g)).toHaveLength(2);
    expect(html).toContain('value="17:30"');
    expect(html).toContain('value="22:30"');
    expect(html).toContain('aria-label="Remove 22:30 from X"');
    expect(html).toContain(">+ Add slot</button>");
  });

  it("no + once there are as many as the app takes", () => {
    const six = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
    expect(six).toHaveLength(MAX_SLOTS);
    expect(renderToStaticMarkup(createElement(SlotList, { platform: "X", slots: six, onChange: () => {} }))).not.toContain("Add slot");
  });

  it("a new slot comes an hour after the latest, 09:00 for the first, never on one that's there", () => {
    expect(nextSlot([])).toBe("09:00");
    expect(nextSlot(["17:30", "10:00"])).toBe("18:30");
    expect(nextSlot(["23:30"])).toBe("00:30");
    expect(nextSlot(["23:30", "00:30"])).toBe("01:30");
  });

  it("saves valid times once each, earliest first", () => {
    expect(normalizeSlots(["22:30", "17:30", "17:30", ""])).toEqual(["17:30", "22:30"]);
  });
});
