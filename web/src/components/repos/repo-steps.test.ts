import { describe, expect, it } from "vitest";
import { postsLabel, repoPostSteps } from "./repo-steps";

const folder = { ideaId: "r1", source: { type: "folder", path: "/Users/me/dev/app" }, brief: "", format: "x", count: 3 };
const github = { ...folder, source: { type: "github", url: "https://github.com/a/b" }, format: "article", count: 1 };
const at = (payload: Record<string, unknown>, phase?: string) =>
  repoPostSteps({ status: "claimed", payload, result: phase ? { progress: { kind: "repo_posts", phase } } : null });

describe("repoPostSteps (posts from a repo, 2026-10-10: getting the repository, reading it, writing)", () => {
  it("names what's being written", () => {
    expect(postsLabel("x", 3)).toBe("3 X posts");
    expect(postsLabel("linkedin", 1)).toBe("a LinkedIn post");
    expect(postsLabel("article", 1)).toBe("an X article");
    expect(postsLabel("article", 2)).toBe("2 X articles");
  });

  it("a folder: waiting for the Mac, then reading it and writing", () => {
    expect(repoPostSteps({ status: "queued", payload: folder })).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(at(folder)).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Reading the repository", done: false },
    ]);
    expect(at(folder, "writing")).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Reading the repository and writing 3 X posts", done: false },
    ]);
  });

  it("a GitHub link: getting the repository first", () => {
    expect(at(github, "fetching")).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Getting the repository from GitHub", done: false },
    ]);
    expect(at(github, "writing")).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Got the repository from GitHub", done: true },
      { label: "Reading the repository and writing an X article", done: false },
    ]);
    expect(repoPostSteps({ status: "done", payload: github })).toEqual([]);
  });
});
