# PostEcho, usable open source: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the prepared repository into a real open-source project: it works without paid keys beyond Claude, it says clearly who it's for, and it welcomes contributions (owner, 2026-09-27: "rendila a tutti gli effetti una repo open source interessante e non solo un esercizio di stile").

**Architecture:**
- Search gets a path without Jev. The first round's candidates are saved unranked: a round-robin across the sources, capped at the results total, and marked `meta.unranked`.
- The scripts run the same on macOS and Linux, and a CI job runs the quick start there on every push.
- The contributor files follow GitHub's conventions: CONTRIBUTING, a code of conduct, SECURITY, and issue and PR templates.

**Decisions (the owner's, from the chat):**
- Jev is optional. Without it a search still saves what the free sources find, unranked, and says what a key adds.
- Writing needs Claude Code on a Claude plan. The agent is the one place another AI would plug in later, and CONTRIBUTING says where.
- Contributions are welcome within the project's rules: official APIs and open sources only, no scraping, and a person decides what goes out.

---

### Task A: A search without Jev

**Files:** `web/src/lib/scout-run.ts`, `web/src/lib/scout-run.test.ts`, `web/src/components/search-box.tsx` (the result message), their tests.

- [ ] A test in `scout-run.test.ts`, "without Jev": fake adapters return candidates and there is no client.
  - Expect `inserted` > 0 and the summary's `note` to be `UNRANKED_NOTE`.
  - Expect the rows to carry `meta.unranked === true`, `topic`, `sourceName` and no `rank`.
  - Expect the sources taken in turn, up to `resultsTotal`.
- [ ] Run the test and see it fail.
- [ ] Implement it in `runScoutSearch`: without a client, `saveUnranked(states, resultsTotal)` takes the collected candidates source by source in turn, reusing the saving code of the ranked path. The shared part becomes `saveOne(post, variant, meta)`. The summaries for discussion cards still run; the human score is skipped.
- [ ] The search box's message for `UNRANKED_NOTE`: "Saved N posts, unranked: add a Jev key in Settings › AI tools to rank them and filter spam."
- [ ] Run the web suite and commit.

### Task B: The same scripts on Linux, and the quick start in CI

**Files:** `scripts/setup.mjs`, `scripts/dev.mjs`, `.github/workflows/ci.yml`

- [ ] Spawn `npm` with `shell: process.platform === "win32"`, so Windows finds `npm.cmd`.
- [ ] A `quickstart` CI job on ubuntu:
  1. `npm run setup </dev/null` (no Claude Code there: it warns and goes on);
  2. `npm run demo`;
  3. `npm run dev` in the background;
  4. wait for "PostEcho is running";
  5. `curl -fsS -o /dev/null http://localhost:3000/login`;
  6. stop.
- [ ] Commit, then read the run on the preview branch.

### Task C: Who it's for, what it needs, how to contribute

**Files:** `README.md`, `CONTRIBUTING.md` (new), `CODE_OF_CONDUCT.md` (new), `SECURITY.md` (new), `.github/ISSUE_TEMPLATE/{bug_report.md,feature_request.md,config.yml}` (new), `.github/pull_request_template.md` (new).

- [ ] **README:**
  - a "Who it's for" note under the pitch: self-hosted, one owner, Claude Code on a Claude plan, and Jev optional (what it adds);
  - the requirements: macOS or Linux;
  - the cost table, with Jev optional;
  - a "Contributing" section.
- [ ] **CONTRIBUTING.md:**
  - setting up;
  - the checks (`npm test`, types, lint);
  - where things live;
  - how to add a source (`web/src/lib/sources/adapter.ts`);
  - where another AI writer would plug in (the agent's `runClaudeJson`);
  - the project's rules;
  - commits and pull requests.
- [ ] **CODE_OF_CONDUCT.md:** short, in our words, linking the Contributor Covenant 2.1.
- [ ] **SECURITY.md:** report privately through GitHub's private vulnerability reporting, never in a public issue.
- [ ] **Templates:** bug report and feature request as short Markdown forms, and a PR checklist.
- [ ] Commit.

### Task D: Check and refresh the preview

- [ ] Run `npm test` at the root, and the scan for secrets and personal data.
- [ ] Rebuild the one-commit `public` branch from the final tree, then push it to the private repository as `open-source-preview`.
