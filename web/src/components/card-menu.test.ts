import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLongPress, keepsBrowserMenu, LONG_PRESS_MS } from "./card-menu";
import { IdeaCard, type Idea } from "./idea-card";
import { StyleInspirationSection } from "./settings/style-inspiration-section";

const target = (onLinkOrField: boolean) => ({ closest: () => (onLinkOrField ? {} : null) }) as unknown as EventTarget;

describe("the card's own menu (2026-09-26: \"togli anche Aa… selezionabile con tasto destro sulla card\")", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves the browser's menu on links and fields, and on selected text", () => {
    expect(keepsBrowserMenu(target(true), false)).toBe(true);
    expect(keepsBrowserMenu(target(false), true)).toBe(true);
    expect(keepsBrowserMenu(target(false), false)).toBe(false);
    expect(keepsBrowserMenu(null, false)).toBe(false);
  });

  it("a long press opens it after half a second; a drift or a lift cancels it", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const press = createLongPress(fire);
    press.down(10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledWith(10, 10);
    // The click that ends the press is swallowed, once.
    expect(press.takeFired()).toBe(true);
    expect(press.takeFired()).toBe(false);

    press.down(10, 10);
    press.move(30, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.down(10, 10);
    press.up();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("the card has no Aa button any more", () => {
    const idea: Idea = {
      id: "i1", url: "https://example.com/1", kind: "devto", title: "A post", content: "Some text", author: "someone",
      status: "new", source: "scout", createdAt: "2026-09-26T10:00:00.000Z", meta: { rank: 70 },
    };
    const html = renderToStaticMarkup(createElement(IdeaCard, { idea, onStatus: async () => {}, onUse: async () => {}, onStyle: async () => {} }));
    expect(html).not.toContain(">Aa</button>");
    expect(html).toContain(">Use</button>");
    expect(html).toContain(">Dismiss</button>");
  });

  it("Settings says where Learn from its style went", () => {
    const html = renderToStaticMarkup(createElement(StyleInspirationSection, { analyzedAt: null }));
    expect(html).toContain("right-click a card in Trends");
  });
});
