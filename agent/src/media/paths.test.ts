import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeOf, isImageFile, MEDIA_DIR, mediaDirFor, mediaFilePath } from "./paths.js";

const BASE = "/Users/me/.postecho/media";
const DRAFT = "6f1c2a3e-1b2c-4d5e-8f90-123456789abc";

describe("the media directory (media from a repo, 2026-10-11)", () => {
  it("lives in ~/.postecho/media, one folder per draft", () => {
    expect(MEDIA_DIR).toBe(join(homedir(), ".postecho", "media"));
    expect(mediaDirFor(BASE, DRAFT)).toBe(`${BASE}/${DRAFT}`);
  });

  it("refuses a draft id that isn't letters, digits and dashes", () => {
    for (const bad of ["", "..", "../x", "a/b", "/etc", "a b", "x".repeat(65)]) expect(mediaDirFor(BASE, bad)).toBeNull();
  });

  it("resolves a plain file name inside the draft's folder", () => {
    expect(mediaFilePath(BASE, DRAFT, "card-ab12.png")).toBe(`${BASE}/${DRAFT}/card-ab12.png`);
    expect(mediaFilePath(BASE, DRAFT, "video-ab12.mp4")).toBe(`${BASE}/${DRAFT}/video-ab12.mp4`);
  });

  it("refuses anything that could leave it", () => {
    for (const bad of ["", ".", "..", "../x.png", "/etc/passwd", "a/b.png", "a\\b.png", ".hidden.png", "x.png\0", "%2e%2e"]) {
      expect(mediaFilePath(BASE, DRAFT, bad)).toBeNull();
    }
    expect(mediaFilePath(BASE, "../etc", "x.png")).toBeNull();
  });

  it("knows the content types it serves", () => {
    expect(contentTypeOf("a.png")).toBe("image/png");
    expect(contentTypeOf("a.JPG")).toBe("image/jpeg");
    expect(contentTypeOf("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeOf("a.gif")).toBe("image/gif");
    expect(contentTypeOf("a.webp")).toBe("image/webp");
    expect(contentTypeOf("a.mp4")).toBe("video/mp4");
    expect(contentTypeOf("a.txt")).toBeNull();
    expect(isImageFile("logo.SVG")).toBe(false);
    expect(isImageFile("shot.png")).toBe(true);
  });
});
