import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

/** Where the posts come from (posts from a repo, 2026-10-10): a folder on this computer, or a public GitHub repository. */
export type RepoSource = { type: "folder"; path: string } | { type: "github"; url: string };

/** Runs git with these arguments, in `cwd` when given; rejects on a non-zero exit. */
export type GitRunner = (args: string[], cwd?: string) => Promise<void>;

export type ResolveRepoDeps = {
  git: GitRunner;
  /** Where GitHub clones live: ~/.postecho/repos on the owner's computer. */
  reposDir: string;
  /** null when nothing is at that path. */
  stat: (p: string) => Promise<{ isDirectory(): boolean } | null>;
};

/**
 * `https://github.com/<owner>/<name>`, with or without `.git`, a trailing
 * slash or `www.`. Nothing deeper (a `/tree/main` link is a page, not the
 * repository), and only GitHub. The web parses links the same way.
 */
export function parseGithubUrl(url: string): { owner: string; name: string } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1]!, name: m[2]! };
}

/**
 * The directory Claude reads, and the name the posts call it by. A folder is
 * read where it is, nothing copied. A GitHub repository is cloned shallow
 * under `reposDir/<owner>__<name>` the first time, and brought up to date
 * (a shallow fetch, then a hard reset: the clone is ours, never edited) the
 * times after.
 */
export async function resolveRepo(source: RepoSource, deps: ResolveRepoDeps): Promise<{ dir: string; name: string }> {
  if (source.type === "folder") {
    const s = await deps.stat(source.path);
    if (!s?.isDirectory()) throw new Error(`This folder doesn't exist, or isn't a folder: ${source.path}`);
    return { dir: source.path, name: basename(source.path) || source.path };
  }

  const repo = parseGithubUrl(source.url);
  if (!repo) throw new Error(`This isn't a GitHub repository link: ${source.url}`);
  const dir = join(deps.reposDir, `${repo.owner}__${repo.name}`);
  const name = `${repo.owner}/${repo.name}`;
  try {
    if (await deps.stat(dir)) {
      await deps.git(["fetch", "--depth", "1", "origin"], dir);
      await deps.git(["reset", "--hard", "FETCH_HEAD"], dir);
    } else {
      await deps.git(["clone", "--depth", "1", `https://github.com/${name}.git`, dir]);
    }
  } catch {
    // git's own words (an auth prompt for a private repo, "not found") say less than this.
    throw new Error(`This repository isn't public, or doesn't exist: ${source.url}`);
  }
  return { dir, name };
}

/** Where GitHub clones live on this computer. */
export const REPOS_DIR = join(homedir(), ".postecho", "repos");

/** A clone or fetch that takes longer than this is stuck, not slow. */
const GIT_TIMEOUT_MS = 3 * 60_000;

/**
 * The real git. GIT_TERMINAL_PROMPT=0: a private repository would otherwise
 * ask for a username on a terminal nobody is watching and the job would wait
 * until its timeout instead of failing at once.
 */
export const nodeGit: GitRunner = async (args, cwd) => {
  await promisify(execFile)("git", args, {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
  });
};

async function statOrNull(p: string): Promise<{ isDirectory(): boolean } | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** resolveRepo with real git, the real file system and ~/.postecho/repos (created on first use). */
export async function resolveRepoOnThisComputer(source: RepoSource): Promise<{ dir: string; name: string }> {
  if (source.type === "github") await mkdir(REPOS_DIR, { recursive: true });
  return resolveRepo(source, { git: nodeGit, reposDir: REPOS_DIR, stat: statOrNull });
}
