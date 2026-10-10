/**
 * Posts from a repo (2026-10-10): where the posts are written from. A folder on the owner's
 * computer, or a public GitHub repository, which the agent clones. The shape is the repo_posts
 * job's `source` (the contract with agent/src/repo-source.ts). Pure: the page uses it too.
 */
export type RepoSource = { type: "folder"; path: string } | { type: "github"; url: string };

const GITHUB_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * `https://github.com/<owner>/<name>`, with or without `.git`, a trailing slash or `www.`, over
 * http or https; null for anything else (another host, no name, a deeper path like /tree/main).
 * The same behavior as the agent's parseGithubUrl.
 */
export function parseGithubUrl(url: string): { owner: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  if (parsed.search || parsed.hash) return null;
  const match = GITHUB_PATH.exec(parsed.pathname);
  if (!match) return null;
  const [, owner, name] = match;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { owner, name };
}

/** A folder's path without trailing slashes (the macOS picker adds one), "/" staying "/". */
export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.replace(/\/+$/, "") || (trimmed ? "/" : "");
}

/** The source as the job carries it: the folder's path normalized, the GitHub link in its plain form. */
export function normalizeRepoSource(source: RepoSource): RepoSource | null {
  if (source.type === "folder") {
    const path = normalizeFolderPath(source.path);
    return path ? { type: "folder", path } : null;
  }
  const repo = parseGithubUrl(source.url);
  return repo ? { type: "github", url: `https://github.com/${repo.owner}/${repo.name}` } : null;
}

/** The repo idea's url: `file://<path>` for a folder, the plain GitHub link for a repository. */
export function repoIdeaUrl(source: RepoSource): string {
  const normalized = normalizeRepoSource(source);
  if (!normalized) throw new Error("not a repo source");
  return normalized.type === "folder" ? `file://${normalized.path}` : normalized.url;
}

/** The repo idea's title: the folder's name, or `owner/name`. */
export function repoTitle(source: RepoSource): string {
  if (source.type === "folder") {
    const path = normalizeFolderPath(source.path);
    return path.split("/").filter(Boolean).pop() ?? path;
  }
  const repo = parseGithubUrl(source.url);
  return repo ? `${repo.owner}/${repo.name}` : source.url;
}
