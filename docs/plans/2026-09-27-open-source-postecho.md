# PostEcho open source: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostEcho ready for a public repository that anyone can run in three commands and that a non-technical reader understands within a minute.

**Architecture:**
- A root `package.json` with `setup`, `dev`, `demo` and `test`, backed by small Node scripts. Their pure helpers are tested with `node:test`.
- A demo seed in `web/` that fills the local PGlite database with sample data. It is tested against an in-memory database.
- Playwright and ffmpeg make the screenshots and the GIF from that sample data.
- Three documents: the README, `docs/deploy.md` and `docs/case-study.md`.
- A GitHub Actions workflow.
- Publishing is the last task and waits for the owner's explicit go.

**Tech Stack:** Node ≥ 22.9, Next.js 16, Drizzle + PGlite, Vitest, tsx, Playwright, ffmpeg, GitHub Actions.

**Spec:** `docs/specs/2026-09-27-open-source-postecho-design.md` (moved from `docs/specs/` in Task 1).

---

## File map

| File | Responsibility |
| --- | --- |
| `package.json` (new, root) | The four commands anyone runs: `setup`, `dev`, `demo`, `test`. |
| `scripts/lib/env.mjs` (new) | Pure helpers: secrets, the env file contents, the Node version check. |
| `scripts/lib/env.test.mjs` (new) | `node:test` tests for the helpers. |
| `scripts/setup.mjs` (new) | Checks Node and Claude Code; installs `web/` and `agent/`; writes both env files; migrates the local database. |
| `scripts/dev.mjs` (new) | Starts the web app, waits for it, then starts the agent; prefixed output; Ctrl-C stops both. |
| `web/src/lib/demo-seed.ts` (new) | `seedDemo(db, now)`: the sample data, with fixed ids. |
| `web/src/lib/demo-seed.test.ts` (new) | Seeds an in-memory database and checks what every screen needs. |
| `web/scripts/demo.ts` (new) | CLI: refuses when `DATABASE_URL` is set; migrates and seeds `web/.pglite`. |
| `scripts/capture-media.mjs` (new) | Maintainer only: logs in to the local app, saves the screenshots and records the GIF. |
| `docs/media/*` (new) | `hero.gif`, `find-ideas.png`, `video-posts.png`, `write.png`, `calendar.png`, `social-preview.png`. |
| `.github/workflows/ci.yml` (new) | Tests, type checks and lint of `web/`, `agent/` and `scripts/`. |
| `web/vitest.config.ts` | A longer test timeout on CI. |
| `README.md` | Rewritten: the top for anyone, the bottom for developers. |
| `docs/deploy.md` (new) | Putting it online: Vercel, Neon, the env vars, the cron, the agent. |
| `docs/case-study.md` (new) | The design story for recruiters and designers. |
| `agent/README.md`, `web/README.md` | Point to the root setup. |
| `docs/*` → `docs/specs`, `docs/plans`, `docs/reviews` | Plain names. References follow. |

---

### Task 1: Clean-up — plain doc folders and a scan for anything private

**Files:**
- Move: `docs/specs` → `docs/specs`, `docs/plans` → `docs/plans`, `docs/reviews` → `docs/reviews`
- Modify: every file that says `docs/superpowers` (README.md, web/.env.example, agent/README.md, the web files listed by the grep below)

- [ ] **Step 1: Move the folders**

```bash
cd postecho
git mv docs/specs docs/specs && git mv docs/plans docs/plans && git mv docs/reviews docs/reviews
rmdir docs/superpowers
```

- [ ] **Step 2: Rewrite the references**

```bash
grep -rl "docs/" --exclude-dir=node_modules --exclude-dir=.git . | xargs sed -i '' 's#docs/#docs/#g'
grep -rn "docs/superpowers" --exclude-dir=node_modules --exclude-dir=.git . ; echo "left: $?"
```
Expected: `left: 1` (nothing left).

- [ ] **Step 3: Scan every tracked file for secrets and personal data**

```bash
git ls-files -z | xargs -0 grep -nIE "(sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|@forte-ai\.com|simone@|\+39[0-9 ]{8,})" | grep -v "package-lock.json" | head -50
git ls-files -z | xargs -0 grep -nIiE "(password|secret|token)\s*[:=]\s*['\"][^'\"]{8,}['\"]" | grep -viE "(test|example|fake|dummy|placeholder)" | head -30
```
Expected: no real secret. Rewrite any hit that is personal (an email, a private URL, a client name) and re-run until clean. Test fixtures with obviously fake values stay.

- [ ] **Step 4: Point the web README at the root setup**

Replace `web/README.md`'s "Quick start" section with:

```markdown
## Quick start

From the repository root: `npm run setup`, then `npm run dev` (see the root README). To work on the web app
alone: `npm run dev` here, with `web/.env.local` written by the setup.
```

- [ ] **Step 5: Run the web and agent suites, then commit**

```bash
cd web && npx next typegen >/dev/null && npx tsc --noEmit && npx vitest run && cd ../agent && npx vitest run && cd ..
git add -A && git commit -m "chore: plain doc folders, references updated"
```

### Task 2: Setup helpers, tested

**Files:**
- Create: `scripts/lib/env.mjs`
- Test: `scripts/lib/env.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lib/env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, nodeIsRecentEnough, parseEnv, password, secret, webEnv } from "./env.mjs";

test("secrets are long, hex and never repeat", () => {
  const a = secret(), b = secret();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("a generated password is 12 url-safe characters", () => {
  assert.match(password(), /^[A-Za-z0-9_-]{12}$/);
});

test("the web env: the owner's password, fresh secrets, no DATABASE_URL (the local database)", () => {
  const env = parseEnv(webEnv({ adminPassword: "pw-1234", agentToken: "tok" }));
  assert.equal(env.ADMIN_PASSWORD, "pw-1234");
  assert.equal(env.AGENT_TOKEN, "tok");
  for (const key of ["SESSION_SECRET", "CAPTURE_TOKEN", "CRON_SECRET"]) assert.ok(env[key].length >= 32, key);
  assert.equal("DATABASE_URL" in env, false);
});

test("the agent env points at the local app with the same token", () => {
  assert.deepEqual(parseEnv(agentEnv({ agentToken: "tok" })), { POSTECHO_URL: "http://localhost:3000", AGENT_TOKEN: "tok", CLAUDE_BIN: "claude" });
});

test("parseEnv reads KEY=value lines, skips comments, keeps = inside values", () => {
  assert.deepEqual(parseEnv("# c\nA=1\n\nB=x=y\n"), { A: "1", B: "x=y" });
});

test("Node 22.9 or newer", () => {
  assert.equal(nodeIsRecentEnough("22.9.0"), true);
  assert.equal(nodeIsRecentEnough("25.8.1"), true);
  assert.equal(nodeIsRecentEnough("22.8.1"), false);
  assert.equal(nodeIsRecentEnough("20.19.0"), false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test "scripts/**/*.test.mjs"`
Expected: FAIL, `Cannot find module './env.mjs'`.

- [ ] **Step 3: Write the helpers**

```js
// scripts/lib/env.mjs
import { randomBytes } from "node:crypto";

/** A random token, hex. */
export const secret = (bytes = 24) => randomBytes(bytes).toString("hex");

/** A password to log in with, when the owner doesn't type one: 12 url-safe characters. */
export const password = () => randomBytes(9).toString("base64url");

/** KEY=value lines, comments and blanks skipped; a value may contain "=". */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at > 0) env[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return env;
}

/** web/.env.local for a local install: no DATABASE_URL, so the app uses the PGlite database in web/.pglite. */
export function webEnv({ adminPassword, agentToken }) {
  return [
    "# Written by npm run setup. No DATABASE_URL: the app uses the local database in web/.pglite.",
    `ADMIN_PASSWORD=${adminPassword}`,
    `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
    `AGENT_TOKEN=${agentToken}`,
    `CAPTURE_TOKEN=${secret()}`,
    `CRON_SECRET=${secret()}`,
    "# Optional: TYPESAFE_API_KEY for Jev, and the keys of the extra sources (see .env.example).",
    "",
  ].join("\n");
}

/** agent/.env: the local app, the token it shares with it, Claude Code on the PATH. */
export function agentEnv({ agentToken, url = "http://localhost:3000" }) {
  return [`POSTECHO_URL=${url}`, `AGENT_TOKEN=${agentToken}`, "CLAUDE_BIN=claude", ""].join("\n");
}

/** The agent runs with `--env-file-if-exists`, which needs Node 22.9. */
export function nodeIsRecentEnough(version, [major, minor] = [22, 9]) {
  const [a, b] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --test "scripts/**/*.test.mjs"`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib && git commit -m "feat(setup): env helpers, tested"
```

### Task 3: `npm run setup`

**Files:**
- Create: `package.json` (root), `scripts/setup.mjs`

- [ ] **Step 1: The root package.json**

```json
{
  "name": "postecho",
  "private": true,
  "description": "Find what's worth posting about, write it in your own voice, and schedule it on X and LinkedIn.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22.9" },
  "scripts": {
    "setup": "node scripts/setup.mjs",
    "dev": "node scripts/dev.mjs",
    "demo": "npm --prefix web run demo",
    "test": "node --test "scripts/**/*.test.mjs" && npm --prefix web test && npm --prefix agent test",
    "media": "node scripts/capture-media.mjs"
  }
}
```

- [ ] **Step 2: The setup script**

```js
// scripts/setup.mjs
// npm run setup: everything a local install needs, once. Never overwrites an env file that exists.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentEnv, nodeIsRecentEnough, parseEnv, password, secret, webEnv } from "./lib/env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}web`, agent = `${root}agent`;
const say = (line = "") => console.log(line);
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) { say(`\n✗ ${cmd} ${args.join(" ")} failed in ${cwd}`); process.exit(r.status ?? 1); }
};

if (!nodeIsRecentEnough(process.versions.node)) {
  say(`PostEcho needs Node 22.9 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}
if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
  say("! Claude Code isn't installed or isn't on the PATH. The app runs, but nothing gets written until it is:");
  say("  https://docs.claude.com/en/docs/claude-code/overview\n");
}

say("Installing the web app and the agent…");
run("npm", ["install"], web);
run("npm", ["install"], agent);

/** Typed with * shown, when there is a terminal; Enter alone generates one. */
async function askPassword() {
  if (!process.stdin.isTTY) return null;
  process.stdout.write("Choose a password to log in (Enter for a generated one): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let typed = "";
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\r" || ch === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); return typed || null; }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") { if (typed) { typed = typed.slice(0, -1); process.stdout.write("\b \b"); } continue; }
      typed += ch; process.stdout.write("*");
    }
  }
  return typed || null;
}

const webEnvPath = `${web}/.env.local`, agentEnvPath = `${agent}/.env`;
let agentToken = existsSync(webEnvPath) ? parseEnv(readFileSync(webEnvPath, "utf8")).AGENT_TOKEN : undefined;
if (existsSync(webEnvPath)) {
  say("Kept your web/.env.local.");
} else {
  const typed = await askPassword();
  const adminPassword = typed ?? password();
  agentToken = secret();
  writeFileSync(webEnvPath, webEnv({ adminPassword, agentToken }), { mode: 0o600 });
  say(typed ? "Saved your password in web/.env.local." : `Your password: ${adminPassword}  (it's in web/.env.local, change it there)`);
}
if (existsSync(agentEnvPath)) {
  say("Kept your agent/.env.");
} else {
  writeFileSync(agentEnvPath, agentEnv({ agentToken: agentToken ?? secret() }), { mode: 0o600 });
  say("Wrote agent/.env.");
}

say("Preparing the local database…");
run("npm", ["run", "db:migrate:dev"], web);

say("\nDone. Next:");
say("  npm run demo   sample data to look around (optional)");
say("  npm run dev    then open http://localhost:3000");
```

- [ ] **Step 3: Try it in a scratch copy (no terminal: the password is generated)**

```bash
S=$(mktemp -d)/postecho
rm -rf $S && git clone -q . $S && cp package.json $S/ && mkdir -p $S/scripts && cp -R scripts/. $S/scripts/
cd $S && npm run setup </dev/null && test -f web/.env.local && test -f agent/.env && ls web/.pglite >/dev/null && echo SETUP-OK
```
Expected: `SETUP-OK`, with the generated password printed once. A second `npm run setup` says "Kept your web/.env.local." and "Kept your agent/.env.".

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/setup.mjs && git commit -m "feat(setup): npm run setup"
```

### Task 4: `npm run dev`

**Files:**
- Create: `scripts/dev.mjs`

- [ ] **Step 1: The script**

```js
// scripts/dev.mjs
// npm run dev: the web app, then the agent once the app answers. Each line prefixed; Ctrl-C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];

function start(name, cwd, color) {
  const child = spawn("npm", ["run", "dev"], { cwd: `${root}${cwd}`, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${color}${name.padEnd(5)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let rest = "";
    stream.on("data", (buf) => {
      const lines = (rest + buf.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => { stopAll(); process.exitCode = code ?? 0; });
  children.push(child);
}

function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

async function waitForWeb(url = "http://localhost:3000/login", tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

start("web", "web", "\x1b[36m");
if (await waitForWeb()) {
  console.log("\x1b[32mPostEcho is running: http://localhost:3000\x1b[0m");
  start("agent", "agent", "\x1b[35m");
} else {
  console.log("The web app didn't answer on http://localhost:3000 in two minutes: the agent wasn't started.");
}
```

- [ ] **Step 2: Try it in the scratch copy**

```bash
cd $S && (npm run dev > dev.log 2>&1 &) ; for i in $(seq 1 60); do grep -q "PostEcho is running" dev.log && break; sleep 2; done
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login ; grep -c "agent │" dev.log ; pkill -INT -f "scripts/dev.mjs"
```
Expected: `200`, at least one `agent │` line, and both processes gone after the INT.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev.mjs && git commit -m "feat(setup): npm run dev starts the app and the agent"
```

### Task 5: Sample data — `npm run demo`

**Files:**
- Create: `web/src/lib/demo-seed.ts`, `web/src/lib/demo-seed.test.ts`, `web/scripts/demo.ts`
- Modify: `web/package.json` (the `demo` script, `tsx` in devDependencies)

The data is invented: fictional names, `example.com` and made-up video links, no real handle. Fixed ids (`DEMO_IDS`) let the capture script open the right screens.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/demo-seed.test.ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { drafts, ideas, kv, scheduledPosts } from "@/db/schema";
import { DEMO_IDS, seedDemo } from "@/lib/demo-seed";

const now = new Date("2026-09-28T09:00:00Z");

describe("the sample data (npm run demo)", () => {
  it("fills every screen: Trends, a video's 12 posts, posts in Write, the week in Calendar", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const all = await db.select().from(ideas);
    const trends = all.filter((i) => i.kind !== "youtube" && i.kind !== "video_idea" && i.kind !== "note");
    expect(trends.length).toBeGreaterThanOrEqual(9);
    expect(trends.every((i) => typeof i.meta.rank === "number")).toBe(true);
    const videoPosts = all.filter((i) => i.kind === "video_idea");
    expect(videoPosts).toHaveLength(12);
    expect(videoPosts.every((i) => i.meta.format === "post" && i.meta.videoId === DEMO_IDS.video && !i.title)).toBe(true);
    expect((await db.select().from(drafts).where(eq(drafts.ideaId, DEMO_IDS.takesIdea))).filter((d) => d.status === "candidate")).toHaveLength(3);
    const week = await db.select().from(scheduledPosts);
    expect(week.length).toBeGreaterThanOrEqual(4);
    const settings = Object.fromEntries((await db.select().from(kv)).map((r) => [r.key, r.value]));
    expect(settings.onboardedAt).toBeTruthy();
    expect(settings.seenHints).toEqual(["sources", "settings", "videos"]);
  });

  it("is invented: no real address or handle, links on example.com or a made-up video", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const rows = await db.select().from(ideas);
    for (const row of rows) if (row.url) expect(row.url).toMatch(/^https:\/\/(example\.com|www\.youtube\.com\/watch\?v=demo)/);
    expect(JSON.stringify(rows)).not.toMatch(/@forte|simone/i);
  });

  it("can run twice: the second time changes nothing", async () => {
    const db = await createTestDb();
    await seedDemo(db as never, now);
    const before = (await db.select().from(ideas)).length;
    await seedDemo(db as never, now);
    expect(await db.select().from(ideas)).toHaveLength(before);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run src/lib/demo-seed.test.ts`
Expected: FAIL, `Cannot find module '@/lib/demo-seed'`.

- [ ] **Step 3: Write the seed**

`web/src/lib/demo-seed.ts` exports:
- `DEMO_IDS`: fixed uuids for the video, the idea whose three takes are waiting, the idea with a chosen version, and the scheduled drafts;
- `seedDemo(db, now)`, which inserts with `onConflictDoNothing()` on the fixed ids, so a second run changes nothing.

What it writes:
- **kv:**
  - `identityName` "Sam Rivera" and `identityHandle` "samrivera.demo", invalid on X on purpose, so it can't be anyone's;
  - `onboardedAt` = now, and `seenHints` = ["sources", "settings", "videos"], so no welcome or tour covers the screens;
  - `agentLastHeartbeatAt` = now;
  - a short `styleGuide`.
- **Trends:** 9 ideas with `meta.topic` "design systems", one per source kind: hackernews, x_post, devto, github, bluesky, producthunt, lobsters, arxiv and mastodon.
  - Each has an invented title and content of two to four sentences, a fictional author and an `https://example.com/<slug>` url.
  - `meta.rank` goes from 91 down to 62, with `quality` and `score`. Five have `aiStyle` `{ slopScore: 12–48, verdict }`.
- **A pasted video:** kind `youtube`, url `https://www.youtube.com/watch?v=demo-design-systems`, title "How small teams keep a design system alive", author "Product Talks", `meta.pastedAt` = now.
- **Its 12 posts:** kind `video_idea` with no title.
  - Each has `content` of 180–275 characters written as the owner's own view, with no mention of the video.
  - `meta` holds `{ videoId, videoTitle, order: 0–11, format: "post", sourceName: "youtube", articleUrl, rank: 58–93, aiStyle }`.
- **Write:**
  - the `takesIdea` note, with three `candidate` drafts, each with `meta.slop`;
  - the `chosenIdea` article, with one `kept` draft that has both X and LinkedIn text and `meta.xAtLinkedin` equal to its X text.
- **Calendar and Archive:** three `used` drafts, each with `scheduled_posts`:
  - an X post at 10:00 and a LinkedIn post at 09:00 two days after `now`, both `posted_manually` with a future `publishAt`, so they show as scheduled;
  - one posted yesterday, `posted_manually` with a past `publishAt` and `publishedAt`, which shows in To rate.

- [ ] **Step 4: Run it to see it pass**

Run: `cd web && npx vitest run src/lib/demo-seed.test.ts`
Expected: 3 passing.

- [ ] **Step 5: The CLI and the script**

```ts
// web/scripts/demo.ts — npm run demo: sample data in the local database, never a real one.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import { seedDemo } from "../src/lib/demo-seed";

if (process.env.DATABASE_URL) {
  console.error("DATABASE_URL is set: npm run demo only fills the local database. Unset it to use sample data.");
  process.exit(1);
}
const client = new PGlite("./.pglite");
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: "./drizzle" });
await seedDemo(db as never, new Date());
await client.close();
console.log("Sample data added to web/.pglite. Stop npm run dev first if it was running, then start it again.");
```

In `web/package.json`: add the `"demo": "tsx scripts/demo.ts"` script and `tsx` to devDependencies (`npm i -D tsx`). The seed opens the same PGlite files as the dev server, so it runs with the server stopped, as the message says.

- [ ] **Step 6: Try it in the scratch copy, then commit**

```bash
cd $S && npm run demo && echo DEMO-OK
git add web && git commit -m "feat(demo): npm run demo fills the local database with sample data"
```

### Task 6: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `web/vitest.config.ts`

- [ ] **Step 1: A longer timeout on CI runners** (the PGlite suites run close to 5 s under load)

```ts
// web/vitest.config.ts — inside `test`:
    // CI runners are slower than a laptop: the PGlite suites get room there.
    testTimeout: process.env.CI ? 30_000 : 5_000,
```

- [ ] **Step 2: The workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  web:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
      - run: npx next typegen && npx tsc --noEmit
      - run: npm run lint
      - run: npm test
  agent:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: agent } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: agent/package-lock.json }
      - run: npm ci
      - run: npx tsc --noEmit -p .
      - run: npm test
  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node --test "scripts/**/*.test.mjs"
```

- [ ] **Step 3: Commit** (the run itself is checked after publishing, in Task 11)

```bash
git add .github web/vitest.config.ts && git commit -m "ci: tests, types and lint on every push"
```

### Task 7: Screenshots and the GIF

**Files:**
- Create: `scripts/capture-media.mjs`, `docs/media/*`

- [ ] **Step 1: Prepare** — in the scratch copy with sample data (`npm run demo`), start the app (`npm run dev`). Use a fresh Playwright with its Chromium: `npx -y playwright@latest install chromium` if none is cached.

- [ ] **Step 2: The capture script**

`scripts/capture-media.mjs`:
- reads `ADMIN_PASSWORD` from `web/.env.local` (the local install's own password) and logs in at `/login`;
- sets the viewport to 1512×827 with deviceScaleFactor 2, in the dark theme;
- saves `find-ideas.png` from `/`, `video-posts.png` from `/?mode=videos`, `write.png` from `/create?ideaId=<DEMO_IDS.chosenIdea>` and `calendar.png` from `/calendar?day=<the scheduled day>`, waiting for network idle each time;
- records `hero.webm` with `recordVideo`, 1512×827, clicking through:
  1. Trends;
  2. the Write chip with the three takes, then Pick this;
  3. the editor;
  4. Calendar and the scheduled day;
- turns the recording into `hero.gif` with ffmpeg:
  `ffmpeg -i hero.webm -vf "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse" hero.gif`.

- [ ] **Step 3: Run it, look at every image, and keep the GIF under 5 MB**

```bash
node scripts/capture-media.mjs && ls -la docs/media && du -h docs/media/hero.gif
```
Open each PNG and the GIF and check:
- no welcome or hint covers the screen;
- no "Mac offline" banner;
- the data reads as real.

If the GIF is over 5 MB, lower the fps to 10 or the width to 1000.

- [ ] **Step 4: The social preview** — 1280×640, built from `docs/brand/postecho-mark.mjs`'s mark next to the name and the one-line pitch, rendered with sharp as `render-icons.mjs` does, and saved as `docs/media/social-preview.png`.

- [ ] **Step 5: Commit**

```bash
git add scripts/capture-media.mjs docs/media && git commit -m "docs: screenshots and GIF from the sample data"
```

### Task 8: Putting it online, and the agent's README

**Files:**
- Create: `docs/deploy.md`
- Modify: `agent/README.md`

- [ ] **Step 1: `docs/deploy.md`**, in this order:
  1. a Neon database, with the pooled connection string as `DATABASE_URL`;
  2. `npx drizzle-kit migrate` from `web/`;
  3. a Vercel project from `web/` with the env vars of `web/.env.example`; the required ones are `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `AGENT_TOKEN`, `CAPTURE_TOKEN` and `CRON_SECRET`, and each optional one says what it turns on;
  4. `vercel deploy --prod --cwd web`;
  5. the daily scout cron from `web/vercel.json`, authenticated by `CRON_SECRET`;
  6. the agent pointing at the deployed URL: `POSTECHO_URL` and the same `AGENT_TOKEN`, and the launchd daemon from `agent/README.md`;
  7. what stays €0 and why: the Vercel Hobby and Neon free tiers, and Claude Code on your own plan.

- [ ] **Step 2: `agent/README.md`**
  - Open with: "`npm run setup` at the root writes `agent/.env`; `npm run dev` there starts the agent with the app."
  - Keep the launchd section for running it in the background.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy.md agent/README.md && git commit -m "docs: putting PostEcho online"
```

### Task 9: The README

**Files:**
- Modify: `README.md` (a full rewrite, in English)

- [ ] **Step 1: The top, for anyone.** In order:
  1. the mark (`web/src/app/icon.svg`) and "PostEcho";
  2. one line: "Find what's worth posting about, write it in your own voice, and schedule it on X and LinkedIn. It runs for €0 a month.";
  3. badges: CI and the MIT licence;
  4. `docs/media/hero.gif`;
  5. "What it does":
     - **Find:** a search across a dozen open sources, the best first, with how human each post reads;
     - **Write:** Claude writes three takes in your voice, and you edit them in a chat;
     - **Calendar:** schedule on X's and LinkedIn's own schedulers and see the week;
     - one screenshot each, and the video posts as the fourth;
  6. "What makes it different", six plain bullets:
     - it writes like you, from your best posts and your style guide;
     - it tells you how human a text reads, and Humanize fixes it;
     - it shows every step while it works;
     - it runs on your own Claude plan, with no API key;
     - it uses no scraping, only official APIs and open sources;
     - it costs €0 a month;
  7. "Built by": Simone Lovera, CPO at Forte AI; designed and built with Claude Code. No build timeline, per the owner. Links to `docs/case-study.md` and https://github.com/simojam93.

- [ ] **Step 2: The bottom, for developers.** In order:
  1. **Quick start:** `git clone https://github.com/simojam93/postecho && cd postecho`, `npm run setup`, `npm run demo` (optional) and `npm run dev`. Requirements: macOS, Node 22.9 or newer, and Claude Code logged in for the writing.
  2. **Put it online:** a link to `docs/deploy.md`.
  3. **How it works:** a Mermaid diagram.
     - Browser → web app (Next.js on Vercel) → Postgres (Neon; PGlite locally).
     - Web app → job queue ← agent on your Mac → `claude -p`.
     - Web app → Jev (TypeSafe) through jev-judge, and → sources.
     - Then three sentences on the job queue.
  4. **Repository map:** `web/`, `agent/`, `scripts/`, `docs/`.
  5. **Stack.**
  6. **Tests:** `npm test` and the counts.
  7. **jev-judge:** the vendored library and its repository.
  8. **Licence:** MIT.

- [ ] **Step 3: Read it as an HR person.** The top has no jargon, or explains it once. Each thing is said once, per the owner's copy rule. Then commit.

```bash
git add README.md && git commit -m "docs: README for anyone, then for developers"
```

### Task 10: The case study

**Files:**
- Create: `docs/case-study.md`

- [ ] **Step 1: Write it, in English, with images from `docs/media/`:**
  1. the problem, and who it's for;
  2. the principles, taken from the owner's working rules and kept short;
  3. six decisions, each with what, why and a screenshot where one helps:
     - Edit opens X's own scheduler instead of duplicating it;
     - no "fits you" nudge;
     - every wait shows its steps and seconds;
     - a video becomes 12 ready X posts in your voice;
     - the archive keeps the workspace clean;
     - one AI bar instead of a row of chips;
  4. the AI in plain words;
  5. the constraints: €0 a month, official APIs, no scraping;
  6. what's next.

- [ ] **Step 2: Commit**

```bash
git add docs/case-study.md && git commit -m "docs: the design case study"
```

### Task 11: Check it end to end, then the owner reviews it privately

- [ ] **Step 1:** Run the whole flow on a fresh clone: `npm run setup` (no terminal), `npm run demo`, `npm run dev`, then `curl /login` returns 200.
- [ ] **Step 2:** `npm test` at the root: every suite green.
- [ ] **Step 3:** Run the Task 1 scan again on the final tree.
- [ ] **Step 4:** Build the public tree as one orphan commit on a local `public` branch:
  - `git checkout --orphan public`;
  - `git commit`, authored by Simone Lovera, with his public git address;
  - `git checkout main`.
- [ ] **Step 5:** Push `public` to the **private** repository as the `open-source-preview` branch, so the owner reads the README rendered on GitHub, then collect his changes.

### Task 12: Publishing — only on the owner's explicit go, together with jev-judge

1. `gh repo rename postecho-archive --repo simojam93/PostEcho`.
2. Locally, rename the remote: `git remote rename origin archive`, point it at the new name with `git remote set-url archive https://github.com/simojam93/postecho-archive.git`, and push the full history there: `git push archive main`.
3. `gh repo create simojam93/postecho --public --description "…"`, then `git remote add origin https://github.com/simojam93/postecho.git` and `git push -u origin public:main`.
4. Topics, the social preview from `docs/media/social-preview.png` (uploaded by the owner in Settings, since the API has no endpoint for it), and a check that CI is green.
5. From then on, development continues on the public `main`.
