import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MediaItem } from "@/lib/media";
import { mediaUrl } from "@/lib/media-client";
import { mediaSteps, MediaView, PostMedia } from "./post-media";

const DRAFT = "6f1c2a3e-1b2c-4d5e-8f90-123456789abc";
const noop = () => {};
const view = (over: Partial<Parameters<typeof MediaView>[0]> = {}) => renderToStaticMarkup(createElement(MediaView, {
  draftId: DRAFT, port: 47321, kinds: ["images", "card"], media: [], job: null, error: null, unreachable: false, menuOpen: false, busy: false,
  onMenu: noop, onAdd: noop, onKeep: noop, onRemove: noop, onReveal: noop, onUnreachable: noop,
  ...over,
}));

const card: MediaItem = { file: "card-ab.png", kind: "card", kept: false, jobId: "j" };
const shot: MediaItem = { file: "screenshot-ab-1.png", kind: "screenshot", caption: "The gate", kept: true, jobId: "j" };
const clip: MediaItem = { file: "video-ab.mp4", kind: "video", kept: false, jobId: "j" };

describe("Add media in Compose (media from a repo, 2026-10-11)", () => {
  it("Add media opens a menu with only the kinds the source allows", () => {
    expect(view()).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>Add media<\/button>/);
    expect(view()).not.toContain('role="menu"');
    const github = view({ menuOpen: true });
    expect(github).toContain('role="menu"');
    expect(github).toContain(">Images from the repo<");
    expect(github).toContain(">A card<");
    expect(github).not.toContain("Screenshots");
    expect(github).not.toContain("A video");
    const folder = view({ menuOpen: true, kinds: ["images", "card", "screenshots", "video"] });
    expect(folder).toContain(">Screenshots<");
    expect(folder).toContain(">A video<");
  });

  it("Add media waits while the kinds load, or while media are being made", () => {
    expect(view({ kinds: null })).toMatch(/<button[^>]*disabled=""[^>]*>Add media<\/button>/);
    const running = view({ job: { id: "j", kind: "post_media", status: "claimed", result: null, createdAt: new Date().toISOString(), payload: { kind: "card" } } });
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>Add media<\/button>/);
    expect(running).toContain("Your Mac picked it up");
    expect(running).toContain("usually under a minute");
  });

  it("thumbnails come from the agent on 127.0.0.1, loaded with the page's origin", () => {
    const html = view({ media: [card, clip] });
    expect(mediaUrl(47321, DRAFT, "card-ab.png")).toBe(`http://127.0.0.1:47321/media/${DRAFT}/card-ab.png`);
    expect(html).toContain(`src="http://127.0.0.1:47321/media/${DRAFT}/card-ab.png"`);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toMatch(/<video[^>]*src="http:\/\/127\.0\.0\.1:47321\/media\/[^"]+\/video-ab\.mp4"/);
  });

  it("an item not kept has Keep and Remove; a kept one has Show in Finder and Remove, and its caption", () => {
    const html = view({ media: [card, shot] });
    expect(html.match(/>Keep</g)).toHaveLength(1);
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html.match(/>Show in Finder</g)).toHaveLength(1);
    expect(html).toContain("The gate");
  });

  it("says where the media are when the agent can't be reached, once", () => {
    const html = view({ media: [card, shot], unreachable: true });
    expect(html.match(/The media are on the computer where the agent runs\./g)).toHaveLength(1);
    expect(view({ media: [card] })).not.toContain("where the agent runs");
  });

  it("shows the agent's sentence when the last media job failed, and the route's when asking failed", () => {
    const failed = { id: "j", kind: "post_media", status: "failed", result: { error: "Found no image in the repository that fits this post." }, payload: { kind: "images" } };
    expect(view({ job: failed })).toContain("Found no image in the repository that fits this post.");
    expect(view({ error: "Update the agent: git pull, then restart npm run dev." })).toContain("Update the agent");
  });

  it("PostMedia starts with Add media, before anything has loaded", () => {
    expect(renderToStaticMarkup(createElement(PostMedia, { draftId: DRAFT }))).toContain(">Add media<");
  });
});

describe("mediaSteps", () => {
  const at = (kind: string, phase?: string) =>
    mediaSteps({ status: "claimed", payload: { kind }, result: phase ? { progress: { kind: "post_media", media: kind, phase } } : null });

  it("waits for the Mac, then says each step of the kind as it happens", () => {
    expect(mediaSteps({ status: "queued", payload: { kind: "card" } })).toEqual([{ label: "Waiting for your Mac", done: false }]);
    expect(at("card")).toEqual([{ label: "Your Mac picked it up", done: true }, { label: "Writing the card", done: false }]);
    expect(at("card", "saving")).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Writing the card", done: true },
      { label: "Drawing it", done: false },
    ]);
    expect(at("video", "making")).toEqual([
      { label: "Your Mac picked it up", done: true },
      { label: "Opening the folder", done: true },
      { label: "Making the video with brag-slim", done: false },
    ]);
    expect(at("images", "reading").at(-1)).toEqual({ label: "Looking for images in the repository", done: false });
    expect(at("screenshots", "making").at(-1)).toEqual({ label: "Starting the app and taking screenshots", done: false });
    expect(mediaSteps({ status: "done", payload: { kind: "card" } })).toEqual([]);
  });
});
