import { describe, expect, it, vi } from "vitest";
import { parseGithubUrl, removeClone, resolveRepo, type GitRunner } from "./repo-source.js";

const dir = { isDirectory: () => true };
const file = { isDirectory: () => false };

describe("parseGithubUrl", () => {
  it.each([
    "https://github.com/a/b",
    "https://github.com/a/b.git",
    "https://github.com/a/b/",
    "http://www.github.com/a/b",
  ])("accepts %s", (url) => {
    expect(parseGithubUrl(url)).toEqual({ owner: "a", name: "b" });
  });

  it.each([
    "https://gitlab.com/a/b",
    "https://github.com/a",
    "https://github.com/a/",
    "https://github.com/a/b/tree/main",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseGithubUrl(url)).toBeNull();
  });
});

describe("resolveRepo", () => {
  it("takes an existing folder as it is, named after its last part", async () => {
    const git = vi.fn<GitRunner>();
    const out = await resolveRepo(
      { type: "folder", path: "/Users/me/dev/postecho" },
      { git, reposDir: "/repos", stat: async () => dir },
    );
    expect(out).toEqual({ dir: "/Users/me/dev/postecho", name: "postecho" });
    expect(git).not.toHaveBeenCalled();
  });

  it.each([["missing", null], ["a file", file]])("refuses a path that is %s", async (_label, stat) => {
    await expect(resolveRepo(
      { type: "folder", path: "/nope" },
      { git: vi.fn<GitRunner>(), reposDir: "/repos", stat: async () => stat },
    )).rejects.toThrow("This folder doesn't exist, or isn't a folder: /nope");
  });

  it("clones a GitHub repository the first time, shallow", async () => {
    const git = vi.fn<GitRunner>(async () => {});
    const out = await resolveRepo(
      { type: "github", url: "https://github.com/a/b" },
      { git, reposDir: "/repos", stat: async () => null },
    );
    expect(git).toHaveBeenCalledTimes(1);
    expect(git.mock.calls[0]![0]).toEqual(["clone", "--depth", "1", "https://github.com/a/b.git", "/repos/a__b"]);
    expect(out).toEqual({ dir: "/repos/a__b", name: "a/b" });
  });

  it("updates a clone it already has", async () => {
    const git = vi.fn<GitRunner>(async () => {});
    const out = await resolveRepo(
      { type: "github", url: "https://github.com/a/b.git" },
      { git, reposDir: "/repos", stat: async () => dir },
    );
    expect(git.mock.calls).toEqual([
      [["fetch", "--depth", "1", "origin"], "/repos/a__b"],
      [["reset", "--hard", "FETCH_HEAD"], "/repos/a__b"],
    ]);
    expect(out).toEqual({ dir: "/repos/a__b", name: "a/b" });
  });

  it("says so when the repository can't be cloned", async () => {
    const git = vi.fn<GitRunner>(async () => { throw new Error("fatal: repository not found"); });
    await expect(resolveRepo(
      { type: "github", url: "https://github.com/a/b" },
      { git, reposDir: "/repos", stat: async () => null },
    )).rejects.toThrow("This repository isn't public, or doesn't exist: https://github.com/a/b");
  });

  it("refuses a link that isn't a GitHub repository, without running git", async () => {
    const git = vi.fn<GitRunner>();
    await expect(resolveRepo(
      { type: "github", url: "https://gitlab.com/a/b" },
      { git, reposDir: "/repos", stat: async () => null },
    )).rejects.toThrow("This isn't a GitHub repository link: https://gitlab.com/a/b");
    expect(git).not.toHaveBeenCalled();
  });
});

describe("removeClone (a clone stays only while its repo is pinned, 2026-10-10)", () => {
  it("deletes a GitHub source's clone under reposDir", async () => {
    const rm = vi.fn(async () => {});
    await removeClone({ type: "github", url: "https://github.com/a/b.git" }, { reposDir: "/repos", rm });
    expect(rm).toHaveBeenCalledWith("/repos/a__b", { recursive: true, force: true });
  });

  it("never touches a folder, nor a link that isn't a GitHub repository", async () => {
    const rm = vi.fn(async () => {});
    await removeClone({ type: "folder", path: "/Users/me/dev/postecho" }, { reposDir: "/repos", rm });
    await removeClone({ type: "github", url: "https://gitlab.com/a/b" }, { reposDir: "/repos", rm });
    expect(rm).not.toHaveBeenCalled();
  });
});
