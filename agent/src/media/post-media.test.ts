import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../handlers.js";
import { HANDLERS, SERVED_KINDS, runHandler } from "../handlers.js";
import { MEDIA_CARD_SCHEMA, MEDIA_IMAGES_SCHEMA, MEDIA_SCREENSHOTS_SCHEMA, MEDIA_VIDEO_SCHEMA } from "../schemas.js";
import { FOLDER_ONLY, handlePostMedia, SCREENSHOT_TOOLS, VIDEO_TOOLS } from "./post-media.js";

const DRAFT = "6f1c2a3e-1b2c-4d5e-8f90-123456789abc";

let root: string;
let repo: string;
let mediaBase: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "postecho-media-"));
  repo = join(root, "repo");
  mediaBase = join(root, "media");
  await mkdir(join(repo, "docs"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const draftDir = () => join(mediaBase, DRAFT);

type Call = { prompt: string; schema: object; cwd?: string; readOnlyTools?: boolean; tools?: string; addDirs?: string[] };

/** Claude, faked: `reply` runs before the answer (to write files like Claude Code would), then the fixture is parsed. */
function fakeClaude(fixture: unknown, reply?: (call: Call) => Promise<void>) {
  const calls: Call[] = [];
  async function fn<T>(opts: Call & { system: string; parse: (value: unknown) => T }): Promise<T> {
    const call = { prompt: opts.prompt, schema: opts.schema, cwd: opts.cwd, readOnlyTools: opts.readOnlyTools, tools: opts.tools, addDirs: opts.addDirs };
    calls.push(call);
    await reply?.(call);
    return opts.parse(fixture);
  }
  return { fn, calls };
}

function makeDeps(claude: ReturnType<typeof fakeClaude>, over: Partial<HandlerDeps> = {}) {
  const progress: Array<Record<string, unknown>> = [];
  const renderCard = vi.fn(async (_html: string, _size: { width: number; height: number }, out: string) => { await writeFile(out, "png"); });
  const resolveRepo = vi.fn(async (source: { type: string }) => ({ dir: repo, name: source.type === "folder" ? "repo" : "a/b" }));
  const deps: HandlerDeps = {
    getProfile: vi.fn(),
    runClaudeJson: claude.fn,
    resolveRepo,
    reportProgress: async (p) => { progress.push(p); },
    media: { baseDir: mediaBase, renderCard, token: () => "t0k3n" },
    ...over,
  } as HandlerDeps;
  return { deps, progress, renderCard, resolveRepo };
}

const folder = { type: "folder" as const, path: "/Users/me/dev/app" };
const github = { type: "github" as const, url: "https://github.com/a/b" };
const payload = (kind: string, over: Record<string, unknown> = {}) => ({
  draftId: DRAFT, repoId: "r1", source: folder, kind, postText: "Gating runs before any paid call.", format: "x", ...over,
});

describe("post_media is served (media from a repo, 2026-10-11)", () => {
  it("is one of the kinds the agent serves", () => {
    expect(SERVED_KINDS).toContain("post_media");
    expect(HANDLERS.post_media).toBe(handlePostMedia);
  });
});

describe("only the owner's folders run", () => {
  it("refuses screenshots and video for a GitHub repository, whatever the web asked, before anything runs", async () => {
    for (const kind of ["screenshots", "video"]) {
      const claude = fakeClaude({});
      const { deps, resolveRepo } = makeDeps(claude);
      await expect(handlePostMedia(payload(kind, { source: github }), deps)).rejects.toThrow(FOLDER_ONLY);
      expect(resolveRepo).not.toHaveBeenCalled();
      expect(claude.calls).toHaveLength(0);
    }
    expect(FOLDER_ONLY).toBe("Screenshots and videos are made only from a folder on this computer: PostEcho never runs code from a GitHub repository.");
  });

  it("refuses a payload that isn't one", async () => {
    const { deps } = makeDeps(fakeClaude({}));
    await expect(handlePostMedia(payload("gif"), deps)).rejects.toThrow();
    await expect(handlePostMedia(payload("card", { draftId: "../x" }), deps)).rejects.toThrow();
    const outcome = await runHandler({ id: "j", kind: "post_media", payload: payload("video", { source: github }), createdAt: "", claimedAt: "" }, deps);
    expect(outcome).toEqual({ ok: false, error: FOLDER_ONLY });
  });
});

describe("what needs a repo", () => {
  it("images, screenshots and a video refuse a payload without a source before anything runs", async () => {
    for (const kind of ["images", "screenshots", "video"]) {
      const claude = fakeClaude({});
      const { deps, resolveRepo } = makeDeps(claude);
      await expect(handlePostMedia({ draftId: DRAFT, kind, postText: "A post." }, deps)).rejects.toThrow();
      expect(resolveRepo).not.toHaveBeenCalled();
      expect(claude.calls).toHaveLength(0);
    }
  });
});

describe("the source's image (2026-10-11)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  function fetchOf(body: Uint8Array | null, headers: Record<string, string>, status = 200) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status, headers }));
  }
  const imagePayload = (over: Record<string, unknown> = {}) => ({
    draftId: DRAFT, kind: "source_image", imageUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg", sourceName: "Chan", ...over,
  });

  it("downloads the one image into the post's media folder, credited to its source, without Claude", async () => {
    const claude = fakeClaude({});
    const fetch = fetchOf(PNG, { "content-type": "image/jpeg" });
    const { deps, resolveRepo, progress } = makeDeps(claude);
    deps.media!.fetch = fetch;
    const result = await handlePostMedia(imagePayload(), deps);
    expect(result).toEqual({ items: [{ file: "source-t0k3n.jpg", kind: "image", caption: "via Chan" }] });
    expect(fetch.mock.calls[0]![0]).toBe("https://i.ytimg.com/vi/abc/hqdefault.jpg");
    expect(new Uint8Array(await readFile(join(draftDir(), "source-t0k3n.jpg")))).toEqual(PNG);
    expect(claude.calls).toHaveLength(0);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(progress.map((p) => p.phase)).toEqual(["saving"]);
  });

  it("only https, only an image, at most 10 MB: never a video or a sound", async () => {
    const { deps } = makeDeps(fakeClaude({}));
    deps.media!.fetch = fetchOf(PNG, { "content-type": "image/png" });
    await expect(handlePostMedia(imagePayload({ imageUrl: "http://example.com/a.png" }), deps)).rejects.toThrow();
    await expect(handlePostMedia(imagePayload({ imageUrl: undefined }), deps)).rejects.toThrow();
    await expect(handlePostMedia(imagePayload({ sourceName: undefined }), deps)).rejects.toThrow();
    expect(deps.media!.fetch).not.toHaveBeenCalled();

    for (const type of ["video/mp4", "audio/mpeg", "text/html", "image/svg+xml"]) {
      deps.media!.fetch = fetchOf(PNG, { "content-type": type });
      await expect(handlePostMedia(imagePayload(), deps)).rejects.toThrow("isn't an image");
    }
    deps.media!.fetch = fetchOf(PNG, { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) });
    await expect(handlePostMedia(imagePayload(), deps)).rejects.toThrow("over 10 MB");
    // A server that doesn't say how big it is is stopped at 10 MB too.
    deps.media!.fetch = fetchOf(new Uint8Array(10 * 1024 * 1024 + 1), { "content-type": "image/png" });
    await expect(handlePostMedia(imagePayload(), deps)).rejects.toThrow("over 10 MB");
    deps.media!.fetch = fetchOf(null, { "content-type": "image/png" }, 404);
    await expect(handlePostMedia(imagePayload(), deps)).rejects.toThrow("couldn't be downloaded");
    expect(await readdir(draftDir())).toEqual([]);
  });
});

describe("images from the repo", () => {
  it("reads the repository with read tools only and copies the images that fit, best first, with Claude's reason", async () => {
    await writeFile(join(repo, "docs", "gate.png"), "a png");
    await writeFile(join(repo, "hero.jpg"), "a jpg");
    const claude = fakeClaude({ images: [{ path: "docs/gate.png", reason: "The gate's screen" }, { path: "hero.jpg", reason: "The app" }] });
    const { deps, progress } = makeDeps(claude, {});
    const result = await handlePostMedia(payload("images", { source: github }), deps);
    expect(result).toEqual({ items: [
      { file: "image-t0k3n-1.png", kind: "image", caption: "The gate's screen" },
      { file: "image-t0k3n-2.jpg", kind: "image", caption: "The app" },
    ] });
    expect(await readFile(join(draftDir(), "image-t0k3n-1.png"), "utf8")).toBe("a png");
    const [call] = claude.calls;
    expect(call!.cwd).toBe(repo);
    expect(call!.readOnlyTools).toBe(true);
    expect(call!.tools).toBeUndefined();
    expect(call!.schema).toBe(MEDIA_IMAGES_SCHEMA);
    expect(call!.prompt).toContain("Gating runs before any paid call.");
    expect(call!.prompt).toContain("up to 6");
    expect(progress).toEqual([
      { kind: "post_media", media: "images", phase: "reading" },
      { kind: "post_media", media: "images", phase: "saving" },
    ]);
  });

  it("skips paths outside the repository, links out of it, files that aren't images and files over 10 MB", async () => {
    await writeFile(join(root, "secret.png"), "outside");
    await symlink(join(root, "secret.png"), join(repo, "link.png"));
    await writeFile(join(repo, "notes.txt"), "text");
    await writeFile(join(repo, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await writeFile(join(repo, "ok.webp"), "fine");
    const claude = fakeClaude({ images: [
      { path: "../secret.png", reason: "a" }, { path: "/etc/hosts", reason: "b" }, { path: "link.png", reason: "c" },
      { path: "notes.txt", reason: "d" }, { path: "big.png", reason: "e" }, { path: "ok.webp", reason: "g" },
    ] });
    const { deps } = makeDeps(claude);
    const result = await handlePostMedia(payload("images"), deps);
    expect(result).toEqual({ items: [{ file: "image-t0k3n-1.webp", kind: "image", caption: "g" }] });
    expect(await readdir(draftDir())).toEqual(["image-t0k3n-1.webp"]);
  });

  it("says so when no image fits", async () => {
    const { deps } = makeDeps(fakeClaude({ images: [] }));
    await expect(handlePostMedia(payload("images"), deps)).rejects.toThrow("Found no image in the repository that fits this post.");
  });
});

describe("a card", () => {
  it("has Claude write the words from the post, without tools or cloning, and draws one 1600×900 card", async () => {
    const claude = fakeClaude({ headline: "Gate first", line: "Before any paid call.", number: "0" });
    const { deps, renderCard, resolveRepo, progress } = makeDeps(claude);
    const result = await handlePostMedia(payload("card", { source: github }), deps);
    expect(result).toEqual({ items: [{ file: "card-t0k3n.png", kind: "card" }] });
    expect(resolveRepo).not.toHaveBeenCalled();
    const [call] = claude.calls;
    expect(call!.schema).toBe(MEDIA_CARD_SCHEMA);
    expect(call!.cwd).toBeUndefined();
    expect(call!.readOnlyTools).toBeUndefined();
    expect(call!.prompt).toContain("Gating runs before any paid call.");
    expect(renderCard).toHaveBeenCalledTimes(1);
    const [html, size, out] = renderCard.mock.calls[0]!;
    expect(html).toContain("Gate first");
    expect(html).toContain("a/b");
    expect(size).toEqual({ width: 1600, height: 900 });
    expect(out).toBe(join(draftDir(), "card-t0k3n.png"));
    expect(progress.map((p) => p.phase)).toEqual(["making", "saving"]);
  });

  it("draws a LinkedIn post's card twice: 1600×900 and 1080×1350", async () => {
    const { deps, renderCard } = makeDeps(fakeClaude({ headline: "Gate first" }));
    const result = await handlePostMedia(payload("card", { format: "linkedin" }), deps);
    expect(result).toEqual({ items: [{ file: "card-t0k3n.png", kind: "card" }, { file: "card-t0k3n-tall.png", kind: "card" }] });
    expect(renderCard.mock.calls.map((c) => c[1])).toEqual([{ width: 1600, height: 900 }, { width: 1080, height: 1350 }]);
    // A folder's card carries the folder's name.
    expect(renderCard.mock.calls[0]![0]).toContain(">app<");
  });

  it("needs no repo: a post from anywhere carries its source's name small at the bottom, or nothing", async () => {
    const claude = fakeClaude({ headline: "Gate first" });
    const { deps, renderCard, resolveRepo } = makeDeps(claude);
    const result = await handlePostMedia({ draftId: DRAFT, kind: "card", postText: "A post about a talk.", sourceName: "Chan" }, deps);
    expect(result).toEqual({ items: [{ file: "card-t0k3n.png", kind: "card" }] });
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(claude.calls[0]!.prompt).toContain('This post comes from "Chan".');
    expect(claude.calls[0]!.prompt).not.toContain("repository");
    expect(renderCard.mock.calls[0]![0]).toContain(">Chan<");

    renderCard.mockClear();
    await handlePostMedia({ draftId: DRAFT, kind: "card", postText: "My own words." }, deps);
    expect(renderCard.mock.calls[0]![0]).not.toContain('class="footer"');
  });

  it("fails with the renderer's sentence", async () => {
    const { deps } = makeDeps(fakeClaude({ headline: "Gate first" }));
    deps.media!.renderCard = async () => { throw new Error("Cards are drawn with Google Chrome, and it isn't installed on this computer. Install Chrome, then try again."); };
    await expect(handlePostMedia(payload("card"), deps)).rejects.toThrow("Install Chrome");
  });
});

describe("screenshots", () => {
  it("runs Claude Code in the folder with the tools to start the app, writing into a work folder, then keeps up to 4 PNGs", async () => {
    const claude = fakeClaude(
      { screenshots: [{ file: "screenshot-1.png", caption: "The gate" }, { file: "screenshot-2.png", caption: "The plans" }] },
      async (call) => {
        const work = call.addDirs![0]!;
        for (const name of ["screenshot-1.png", "screenshot-2.png", "screenshot-3.png", "screenshot-4.png", "screenshot-5.png", "server.log"]) {
          await writeFile(join(work, name), name);
        }
      },
    );
    const { deps, progress } = makeDeps(claude);
    const result = await handlePostMedia(payload("screenshots"), deps);
    expect(result).toEqual({ items: [
      { file: "screenshot-t0k3n-1.png", kind: "screenshot", caption: "The gate" },
      { file: "screenshot-t0k3n-2.png", kind: "screenshot", caption: "The plans" },
      { file: "screenshot-t0k3n-3.png", kind: "screenshot" },
      { file: "screenshot-t0k3n-4.png", kind: "screenshot" },
    ] });
    const [call] = claude.calls;
    expect(SCREENSHOT_TOOLS).toBe("Read Glob Grep Bash Write");
    expect(call!.tools).toBe(SCREENSHOT_TOOLS);
    expect(call!.readOnlyTools).toBeUndefined();
    expect(call!.cwd).toBe(repo);
    expect(call!.addDirs).toEqual([join(draftDir(), "work-t0k3n")]);
    expect(call!.schema).toBe(MEDIA_SCREENSHOTS_SCHEMA);
    expect(call!.prompt).toContain(join(draftDir(), "work-t0k3n"));
    expect(call!.prompt).toContain("Gating runs before any paid call.");
    expect(call!.prompt).toContain("stop everything you started");
    // The work folder is gone, the four screenshots stay.
    expect((await readdir(draftDir())).sort()).toEqual(["screenshot-t0k3n-1.png", "screenshot-t0k3n-2.png", "screenshot-t0k3n-3.png", "screenshot-t0k3n-4.png"]);
    expect(progress.map((p) => p.phase)).toEqual(["reading", "making", "saving"]);
  });

  it("fails with Claude's note when nothing was saved, and leaves no work folder", async () => {
    const { deps } = makeDeps(fakeClaude({ screenshots: [], note: "The app needs a database that isn't running." }));
    await expect(handlePostMedia(payload("screenshots"), deps)).rejects.toThrow("No screenshot was saved. The app needs a database that isn't running.");
    expect(await readdir(draftDir())).toEqual([]);
  });
});

describe("a video", () => {
  it("runs brag-slim in the folder with Skill and Edit too, then keeps brag.mp4 and brag.jpg", async () => {
    const claude = fakeClaude({ summary: "A 20-second video about the gate." }, async (call) => {
      const out = join(call.addDirs![0]!, "brag-output");
      await mkdir(join(out, "work"), { recursive: true });
      await writeFile(join(out, "brag.mp4"), "video");
      await writeFile(join(out, "brag.jpg"), "cover");
      await writeFile(join(out, "work", "frame-001.png"), "frame");
    });
    const { deps, progress } = makeDeps(claude);
    const result = await handlePostMedia(payload("video"), deps);
    expect(result).toEqual({ items: [
      { file: "video-t0k3n.mp4", kind: "video" },
      { file: "video-t0k3n.jpg", kind: "image", caption: "The video's cover" },
    ] });
    const [call] = claude.calls;
    expect(VIDEO_TOOLS).toBe("Read Glob Grep Bash Write Skill Edit");
    expect(call!.tools).toBe(VIDEO_TOOLS);
    expect(call!.cwd).toBe(repo);
    expect(call!.schema).toBe(MEDIA_VIDEO_SCHEMA);
    expect(call!.prompt).toContain("brag-slim");
    expect(call!.prompt).toContain(join(draftDir(), "work-t0k3n"));
    expect(call!.prompt).toContain("Gating runs before any paid call.");
    expect((await readdir(draftDir())).sort()).toEqual(["video-t0k3n.jpg", "video-t0k3n.mp4"]);
    expect(await readFile(join(draftDir(), "video-t0k3n.mp4"), "utf8")).toBe("video");
    expect(progress.map((p) => p.phase)).toEqual(["reading", "making", "saving"]);
  });

  it("fails clearly when the skill made no brag.mp4", async () => {
    const { deps } = makeDeps(fakeClaude({ summary: "ffmpeg is missing." }));
    await expect(handlePostMedia(payload("video"), deps)).rejects.toThrow("The video wasn't made. ffmpeg is missing.");
    expect(await readdir(draftDir())).toEqual([]);
  });
});
