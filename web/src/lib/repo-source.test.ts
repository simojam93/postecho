import { describe, expect, it } from "vitest";
import { parseGithubUrl, repoIdeaUrl, repoTitle } from "@/lib/repo-source";

describe("parseGithubUrl (the same behavior as the agent's)", () => {
  it("accepts a repository's link, with or without .git, a trailing slash or www", () => {
    for (const url of [
      "https://github.com/a/b",
      "https://github.com/a/b.git",
      "https://github.com/a/b/",
      "http://www.github.com/a/b",
    ]) expect(parseGithubUrl(url), url).toEqual({ owner: "a", name: "b" });
  });

  it("rejects other hosts, a missing name and deeper paths", () => {
    for (const url of [
      "https://gitlab.com/a/b",
      "https://github.com/a",
      "https://github.com/a/",
      "https://github.com/a/b/tree/main",
      "https://notgithub.com/a/b",
      "github.com/a/b",
      "not a url",
    ]) expect(parseGithubUrl(url), url).toBeNull();
  });
});

describe("repoIdeaUrl and repoTitle", () => {
  it("a folder is file://<path>, named after its last part", () => {
    const source = { type: "folder" as const, path: "/Users/me/dev/postecho" };
    expect(repoIdeaUrl(source)).toBe("file:///Users/me/dev/postecho");
    expect(repoTitle(source)).toBe("postecho");
  });

  it("a GitHub repo is its normalized link, named owner/name", () => {
    const source = { type: "github" as const, url: "http://www.github.com/simojam93/jev-judge.git" };
    expect(repoIdeaUrl(source)).toBe("https://github.com/simojam93/jev-judge");
    expect(repoTitle(source)).toBe("simojam93/jev-judge");
  });
});
