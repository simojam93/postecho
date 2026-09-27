// npm run media (maintainers): the README's screenshots and GIF, from the sample data.
// Needs the app running with it (npm run demo, then npm run dev) and `npm install` at the root for Playwright.
// Usage: node scripts/capture-media.mjs [--only=<name>] [--no-gif]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseEnv } from "./lib/env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}docs/media`;
const base = process.env.POSTECHO_URL ?? "http://localhost:3000";
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7);
const { ADMIN_PASSWORD } = parseEnv(readFileSync(`${root}web/.env.local`, "utf8"));
if (!ADMIN_PASSWORD) throw new Error("No ADMIN_PASSWORD in web/.env.local: run npm run setup first.");

// A fixed id from web/src/lib/demo-seed.ts: the post whose version is chosen.
const CHOSEN_IDEA = "00000000-0000-4000-8000-000000000031";

const VIEWPORT = { width: 1512, height: 827 };
/** Next's dev-mode button stays out of the pictures. */
const HIDE_DEV_TOOLS = `addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = "nextjs-portal { display: none !important; }";
  document.head.appendChild(style);
});`;
mkdirSync(out, { recursive: true });

async function logIn(page) {
  await page.goto(`${base}/login`);
  await page.locator("input[type=password]").fill(ADMIN_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** A dot where the pointer is, so the GIF shows what gets clicked (headless recordings have no cursor). */
const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
      "background:rgba(230,232,236,.85);box-shadow:0 0 0 4px rgba(230,232,236,.25);pointer-events:none;left:-40px;top:-40px;transition:transform .12s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.7)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; }, true);
  });`;

async function glideAndClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("nothing to click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await page.waitForTimeout(250);
  await locator.click();
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark" });
  await context.addInitScript(HIDE_DEV_TOOLS);
  const page = await context.newPage();
  await logIn(page);

  const shots = [
    { name: "find-ideas", go: async () => { await page.goto(`${base}/`); await page.getByText("Show HN: Tokens.fyi").waitFor(); } },
    { name: "video-posts", go: async () => { await page.goto(`${base}/`); await page.getByRole("button", { name: "Video posts" }).click(); await page.getByText("A design system isn't done").waitFor(); } },
    { name: "write", go: async () => {
      await page.goto(`${base}/create?ideaId=${CHOSEN_IDEA}`);
      await page.locator("#your-post").waitFor();
      // The takes at the top, the post and its AI bar below.
      await page.getByText(/^Takes/).first().evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 12));
    } },
    { name: "calendar", go: async () => { await page.goto(`${base}/calendar`); await page.getByRole("button", { name: "Next day" }).click(); await page.getByRole("button", { name: "Next day" }).click(); await page.getByText("Tokens before components").first().waitFor(); } },
  ];
  // The recording reuses this session, so the GIF starts on the app, not on the login.
  const session = await context.storageState();
  for (const shot of shots) {
    if (only && only !== shot.name) continue;
    await shot.go();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${shot.name}.png` });
    console.log(`saved docs/media/${shot.name}.png`);
  }
  await context.close();

  if (!args.has("--no-gif") && (!only || only === "hero")) {
    const videoDir = `${out}/.video`;
    rmSync(videoDir, { recursive: true, force: true });
    const rec = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", storageState: session, recordVideo: { dir: videoDir, size: VIEWPORT } });
    await rec.addInitScript(HIDE_DEV_TOOLS);
    const p = await rec.newPage();
    await p.addInitScript(CURSOR);
    await p.goto(`${base}/`);
    await p.getByText("Show HN: Tokens.fyi").waitFor();
    await p.waitForTimeout(1800);
    await glideAndClick(p, p.getByRole("button", { name: "Video posts" }));
    await p.getByText("A design system isn't done").waitFor();
    await p.waitForTimeout(1800);
    await glideAndClick(p, p.getByRole("link", { name: /^Write/ }));
    await p.getByRole("button", { name: "Pick this" }).first().waitFor();
    await p.waitForTimeout(1400);
    await glideAndClick(p, p.getByRole("button", { name: "Pick this" }).first());
    await p.waitForTimeout(2400);
    await glideAndClick(p, p.getByRole("link", { name: /^Calendar/ }));
    await p.getByRole("button", { name: "Next day" }).waitFor();
    await p.waitForTimeout(900);
    await glideAndClick(p, p.getByRole("button", { name: "Next day" }));
    await p.waitForTimeout(500);
    await glideAndClick(p, p.getByRole("button", { name: "Next day" }));
    await p.waitForTimeout(2200);
    await rec.close();
    const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
    renameSync(`${videoDir}/${webm}`, `${out}/hero.webm`);
    rmSync(videoDir, { recursive: true, force: true });
    const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.6", "-i", `${out}/hero.webm`,
      // A touch faster than real time, 10 fps and 1100 px wide: under 5 MB, still sharp on GitHub.
      "-vf", "setpts=PTS/1.15,fps=10,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80[p];[b][p]paletteuse=dither=sierra2_4a",
      `${out}/hero.gif`], { stdio: "inherit" });
    if (ff.status !== 0) throw new Error("ffmpeg failed");
    rmSync(`${out}/hero.webm`);
    console.log("saved docs/media/hero.gif");
  }
} finally {
  await browser.close();
}
