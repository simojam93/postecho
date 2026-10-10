import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { HandlerDeps } from "../handlers.js";
import { mediaCardPrompt, mediaImagesPrompt, mediaScreenshotsPrompt, mediaSystemPrompt, mediaVideoPrompt } from "../prompts.js";
import { parseGithubUrl, type RepoSource } from "../repo-source.js";
import {
  MEDIA_CARD_SCHEMA,
  MEDIA_IMAGES_SCHEMA,
  MEDIA_SCREENSHOTS_SCHEMA,
  MEDIA_VIDEO_SCHEMA,
  parseMediaCard,
  parseMediaImages,
  parseMediaScreenshots,
  parseMediaVideo,
} from "../schemas.js";
import { CARD_SIZES, cardHtml, type CardSize } from "./card.js";
import { isImageFile, mediaDirFor } from "./paths.js";

/** What post_media needs besides Claude: where the files go, and how a card is drawn. */
export type MediaDeps = {
  /** ~/.postecho/media on the owner's computer (paths.ts's MEDIA_DIR); a temp folder in tests. */
  baseDir: string;
  /** card.ts's renderCardPng with the system Chrome. */
  renderCard: (html: string, size: CardSize, out: string) => Promise<void>;
  /** The short token that keeps one job's file names apart from another's. */
  token?: () => string;
};

/** One file the job made, as the web stores it in drafts.meta.media. */
export type MediaItem = { file: string; kind: "image" | "card" | "screenshot" | "video"; caption?: string };

/** The tools each long kind runs with: the project has to start, and brag-slim edits its own scenes. */
export const SCREENSHOT_TOOLS = "Read Glob Grep Bash Write";
export const VIDEO_TOOLS = "Read Glob Grep Bash Write Skill Edit";

/** The owner's rule (spec 2026-10-11): code runs only from their own folders. */
export const FOLDER_ONLY = "Screenshots and videos are made only from a folder on this computer: PostEcho never runs code from a GitHub repository.";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOTS = 4;

const PostMediaPayload = z.object({
  draftId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "post_media needs a draft id"),
  repoId: z.string().nullish(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("folder"), path: z.string().trim().min(1) }),
    z.object({ type: z.literal("github"), url: z.string().trim().min(1) }),
  ]),
  kind: z.enum(["images", "card", "screenshots", "video"]),
  postText: z.string().max(15_000).default(""),
  format: z.enum(["x", "linkedin", "article"]).default("x"),
});
type Payload = z.infer<typeof PostMediaPayload>;
type Phase = "reading" | "making" | "saving";

/** The repository's name without reading it: a folder's name, or owner/name. */
function repoNameOf(source: RepoSource): string {
  if (source.type === "folder") return basename(source.path) || source.path;
  const repo = parseGithubUrl(source.url);
  return repo ? `${repo.owner}/${repo.name}` : source.url;
}

/** `file` when it's a regular file inside `root` (links followed), else null. */
async function insideRepo(root: string, relative: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    const real = await realpath(resolve(realRoot, relative));
    return real.startsWith(realRoot + sep) ? real : null;
  } catch {
    return null;
  }
}

/** Every file under `dir`, depth first, a few levels down (brag-slim may nest its output). */
async function filesUnder(dir: string, depth = 3): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory() && depth > 0) files.push(...(await filesUnder(path, depth - 1)));
  }
  return files;
}

/**
 * post_media (media from a repo, 2026-10-11): one post's images, card, screenshots or video, made into
 * the draft's media folder. Screenshots and video run the project, so they're refused for anything but a
 * folder on this computer before anything else happens, whatever the web sent. Answers `{ items }`.
 */
export async function handlePostMedia(payload: unknown, deps: HandlerDeps): Promise<{ items: MediaItem[] }> {
  const p = PostMediaPayload.parse(payload);
  if ((p.kind === "screenshots" || p.kind === "video") && p.source.type !== "folder") throw new Error(FOLDER_ONLY);
  const media = deps.media;
  if (!media) throw new Error("post_media: this agent can't make media");
  const dir = mediaDirFor(media.baseDir, p.draftId);
  if (!dir) throw new Error("post_media needs a draft id");
  await mkdir(dir, { recursive: true });
  const token = (media.token ?? (() => randomBytes(3).toString("hex")))();
  const report = async (phase: Phase) => {
    if (!deps.reportProgress) return;
    try { await deps.reportProgress({ kind: "post_media", media: p.kind, phase }); } catch { /* a courtesy to the page */ }
  };

  switch (p.kind) {
    case "images":
      return { items: await images(p, deps, dir, token, report) };
    case "card":
      return { items: await card(p, deps, media, dir, token, report) };
    case "screenshots":
      return { items: await screenshots(p, deps, dir, token, report) };
    case "video":
      return { items: await video(p, deps, dir, token, report) };
  }
}

type Report = (phase: Phase) => Promise<void>;

async function resolveSource(p: Payload, deps: HandlerDeps): Promise<{ dir: string; name: string }> {
  if (!deps.resolveRepo) throw new Error("post_media: this agent can't read repositories");
  return deps.resolveRepo(p.source);
}

async function images(p: Payload, deps: HandlerDeps, dir: string, token: string, report: Report): Promise<MediaItem[]> {
  await report("reading");
  const repo = await resolveSource(p, deps);
  const { images: picked } = await deps.runClaudeJson({
    prompt: mediaImagesPrompt({ repoName: repo.name, postText: p.postText }),
    system: mediaSystemPrompt(),
    schema: MEDIA_IMAGES_SCHEMA,
    parse: parseMediaImages,
    cwd: repo.dir,
    readOnlyTools: true,
  });
  await report("saving");
  const items: MediaItem[] = [];
  for (const image of picked) {
    const source = await insideRepo(repo.dir, image.path);
    if (!source || !isImageFile(source)) continue;
    const info = await stat(source);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
    const file = `image-${token}-${items.length + 1}${extname(source).toLowerCase()}`;
    await copyFile(source, join(dir, file));
    items.push({ file, kind: "image", ...(image.reason ? { caption: image.reason } : {}) });
  }
  if (items.length === 0) throw new Error("Found no image in the repository that fits this post.");
  return items;
}

async function card(p: Payload, deps: HandlerDeps, media: MediaDeps, dir: string, token: string, report: Report): Promise<MediaItem[]> {
  await report("making");
  const repoName = repoNameOf(p.source);
  const words = await deps.runClaudeJson({
    prompt: mediaCardPrompt({ repoName, postText: p.postText }),
    system: mediaSystemPrompt(),
    schema: MEDIA_CARD_SCHEMA,
    parse: parseMediaCard,
  });
  await report("saving");
  const sizes: Array<{ size: CardSize; file: string }> = [{ size: CARD_SIZES.landscape, file: `card-${token}.png` }];
  if (p.format === "linkedin") sizes.push({ size: CARD_SIZES.portrait, file: `card-${token}-tall.png` });
  for (const { size, file } of sizes) {
    await media.renderCard(cardHtml({ ...words, repoName, ...size }), size, join(dir, file));
  }
  return sizes.map(({ file }) => ({ file, kind: "card" }));
}

/** A folder for one long job's work inside the draft's media folder: Claude writes there, the agent keeps what it needs. */
async function workFolder(dir: string, token: string): Promise<string> {
  const work = join(dir, `work-${token}`);
  await mkdir(work, { recursive: true });
  return work;
}

async function screenshots(p: Payload, deps: HandlerDeps, dir: string, token: string, report: Report): Promise<MediaItem[]> {
  await report("reading");
  const repo = await resolveSource(p, deps);
  const work = await workFolder(dir, token);
  try {
    await report("making");
    const reply = await deps.runClaudeJson({
      prompt: mediaScreenshotsPrompt({ repoName: repo.name, postText: p.postText, outDir: work }),
      system: mediaSystemPrompt(),
      schema: MEDIA_SCREENSHOTS_SCHEMA,
      parse: parseMediaScreenshots,
      cwd: repo.dir,
      tools: SCREENSHOT_TOOLS,
      addDirs: [work],
    });
    await report("saving");
    const pngs = (await readdir(work)).filter((name) => extname(name).toLowerCase() === ".png").sort().slice(0, MAX_SCREENSHOTS);
    if (pngs.length === 0) throw new Error(["No screenshot was saved.", reply.note].filter(Boolean).join(" "));
    const items: MediaItem[] = [];
    for (const name of pngs) {
      const file = `screenshot-${token}-${items.length + 1}.png`;
      await rename(join(work, name), join(dir, file));
      const caption = reply.screenshots.find((s) => s.file === name)?.caption;
      items.push({ file, kind: "screenshot", ...(caption ? { caption } : {}) });
    }
    return items;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function video(p: Payload, deps: HandlerDeps, dir: string, token: string, report: Report): Promise<MediaItem[]> {
  await report("reading");
  const repo = await resolveSource(p, deps);
  const work = await workFolder(dir, token);
  try {
    await report("making");
    const reply = await deps.runClaudeJson({
      prompt: mediaVideoPrompt({ repoName: repo.name, postText: p.postText, outDir: work }),
      system: mediaSystemPrompt(),
      schema: MEDIA_VIDEO_SCHEMA,
      parse: parseMediaVideo,
      cwd: repo.dir,
      tools: VIDEO_TOOLS,
      addDirs: [work],
    });
    await report("saving");
    const made = await filesUnder(work);
    const mp4 = made.find((path) => basename(path) === "brag.mp4");
    if (!mp4) throw new Error(["The video wasn't made.", reply.summary].filter(Boolean).join(" "));
    const items: MediaItem[] = [{ file: `video-${token}.mp4`, kind: "video" }];
    await rename(mp4, join(dir, items[0]!.file));
    const jpg = made.find((path) => basename(path) === "brag.jpg");
    if (jpg) {
      await rename(jpg, join(dir, `video-${token}.jpg`));
      items.push({ file: `video-${token}.jpg`, kind: "image", caption: "The video's cover" });
    }
    return items;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
