/**
 * A card made from a post (media from a repo, 2026-10-11): Claude writes the words, this template lays them
 * out, and the system Chrome draws it to a PNG. The look is neutral so the post is the owner's, not
 * PostEcho's: a dark background, light text, where the post comes from small at the bottom, no logo.
 */

export type CardSize = { width: number; height: number };

/** 1600×900 fits X and LinkedIn; a LinkedIn post also gets the taller 1080×1350, which fills its feed. */
export const CARD_SIZES = {
  landscape: { width: 1600, height: 900 },
  portrait: { width: 1080, height: 1350 },
} as const satisfies Record<string, CardSize>;

export type CardContent = {
  /** Under 60 characters. */
  headline: string;
  /** A supporting line. */
  line?: string;
  /** A big number, like "3×" or "40 min". */
  number?: string;
  /** Small at the bottom: the repository ("postecho", "owner/name") or the post's source; empty for none. */
  footer: string;
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The card's HTML at `width`×`height`. Pure: the words are escaped, nothing is loaded from the network. */
export function cardHtml(card: CardContent & CardSize): string {
  const { width, height } = card;
  const portrait = height > width;
  const pad = Math.round(width * (portrait ? 0.09 : 0.07));
  const headlineSize = Math.round(width * (portrait ? 0.075 : 0.05));
  const numberSize = Math.round(width * (portrait ? 0.16 : 0.1));
  const lineSize = Math.round(headlineSize * 0.5);
  const footSize = Math.round(width * (portrait ? 0.026 : 0.017));
  const number = card.number?.trim();
  const line = card.line?.trim();
  const footer = card.footer.trim();
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; }
  body {
    background: #0b0c0e;
    color: #e6e8ec;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    padding: ${pad}px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: ${Math.round(pad * 0.4)}px;
    position: relative;
    overflow: hidden;
  }
  .number { font-size: ${numberSize}px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .headline { font-size: ${headlineSize}px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.12; max-width: 92%; }
  .line { font-size: ${lineSize}px; line-height: 1.35; color: #9a9ea6; max-width: 88%; }
  .footer { position: absolute; left: ${pad}px; bottom: ${Math.round(pad * 0.6)}px; font-size: ${footSize}px; color: #6b7079; letter-spacing: 0.02em; }
</style></head><body>
${number ? `  <div class="number">${escapeHtml(number)}</div>\n` : ""}  <div class="headline">${escapeHtml(card.headline.trim())}</div>
${line ? `  <div class="line">${escapeHtml(line)}</div>\n` : ""}${footer ? `  <div class="footer">${escapeHtml(footer)}</div>\n` : ""}</body></html>`;
}

/** What the page shows when there's no Chrome to draw with. */
export const CHROME_MISSING = "Cards are drawn with Google Chrome, and it isn't installed on this computer. Install Chrome, then try again.";

/** The parts of a Playwright browser the renderer uses, so tests can pass a fake. */
export type CardBrowser = {
  newPage: (opts: { viewport: CardSize; deviceScaleFactor: number }) => Promise<{
    setContent: (html: string, opts: { waitUntil: "load" }) => Promise<unknown>;
    screenshot: (opts: { path: string; type: "png" }) => Promise<unknown>;
  }>;
  close: () => Promise<unknown>;
};

/** The system Chrome through playwright-core, which downloads no browser of its own. */
async function launchChrome(): Promise<CardBrowser> {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ channel: "chrome", headless: true }) as unknown as Promise<CardBrowser>;
}

const NO_CHROME = /distribution 'chrome' is not found|executable doesn't exist|chrome.*not found/i;

/** Draws `html` at `size` into the PNG at `out`. */
export async function renderCardPng(
  html: string,
  size: CardSize,
  out: string,
  { launch = launchChrome }: { launch?: () => Promise<CardBrowser> } = {},
): Promise<void> {
  let browser: CardBrowser;
  try {
    browser = await launch();
  } catch (e) {
    if (e instanceof Error && NO_CHROME.test(e.message)) throw new Error(CHROME_MISSING);
    throw e;
  }
  try {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: out, type: "png" });
  } finally {
    await browser.close();
  }
}
