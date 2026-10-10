import { describe, expect, it, vi } from "vitest";
import { CARD_SIZES, cardHtml, CHROME_MISSING, renderCardPng } from "./card.js";

const base = { headline: "Ship the gate before the feature", footer: "simojam93/jev-judge", ...CARD_SIZES.landscape };

describe("the card template (media from a repo, 2026-10-11)", () => {
  it("has the two sizes: 1600×900, and 1080×1350 for LinkedIn", () => {
    expect(CARD_SIZES.landscape).toEqual({ width: 1600, height: 900 });
    expect(CARD_SIZES.portrait).toEqual({ width: 1080, height: 1350 });
  });

  it("draws the headline, the line, the number and the repository's name at the size given", () => {
    const html = cardHtml({ ...base, line: "Tier checks run before any paid call.", number: "3×" });
    expect(html).toContain("Ship the gate before the feature");
    expect(html).toContain("Tier checks run before any paid call.");
    expect(html).toContain("3×");
    expect(html).toContain("simojam93/jev-judge");
    expect(html).toContain("width: 1600px");
    expect(html).toContain("height: 900px");
    expect(html).not.toMatch(/postecho/i);
  });

  it("is dark with light text, never orange", () => {
    const html = cardHtml(base);
    expect(html).toContain("#e6e8ec");
    expect(html).not.toMatch(/orange|#f97316|#fb923c|#ea580c/i);
  });

  it("leaves out what Claude didn't write, and the footer when there's no name for it", () => {
    const html = cardHtml(base);
    expect(html).not.toContain('class="line"');
    expect(html).not.toContain('class="number"');
    expect(cardHtml({ ...base, footer: "" })).not.toContain('class="footer"');
    expect(cardHtml({ ...base, footer: "  " })).not.toContain('class="footer"');
  });

  it("escapes the words, so a post can't inject markup", () => {
    const html = cardHtml({ ...base, headline: `<script>alert("x")</script> & co`, footer: "a/<b>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
    expect(html).toContain("a/&lt;b&gt;");
  });
});

describe("renderCardPng", () => {
  function fakeBrowser() {
    const page = { setContent: vi.fn(async () => {}), screenshot: vi.fn(async () => Buffer.from("")) };
    const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
    return { page, browser };
  }

  it("draws the HTML at its size into the file, then closes the browser", async () => {
    const { page, browser } = fakeBrowser();
    await renderCardPng("<html></html>", CARD_SIZES.portrait, "/tmp/card.png", { launch: async () => browser });
    expect(browser.newPage).toHaveBeenCalledWith({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    expect(page.setContent).toHaveBeenCalledWith("<html></html>", { waitUntil: "load" });
    expect(page.screenshot).toHaveBeenCalledWith({ path: "/tmp/card.png", type: "png" });
    expect(browser.close).toHaveBeenCalled();
  });

  it("says Chrome is missing in one clear sentence", async () => {
    const launch = async () => { throw new Error("browserType.launch: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app"); };
    await expect(renderCardPng("<html></html>", CARD_SIZES.landscape, "/tmp/x.png", { launch })).rejects.toThrow(CHROME_MISSING);
    expect(CHROME_MISSING).toBe("Cards are drawn with Google Chrome, and it isn't installed on this computer. Install Chrome, then try again.");
  });

  it("closes the browser even when drawing fails", async () => {
    const { page, browser } = fakeBrowser();
    page.screenshot.mockRejectedValueOnce(new Error("disk full"));
    await expect(renderCardPng("<html></html>", CARD_SIZES.landscape, "/tmp/x.png", { launch: async () => browser })).rejects.toThrow("disk full");
    expect(browser.close).toHaveBeenCalled();
  });
});
