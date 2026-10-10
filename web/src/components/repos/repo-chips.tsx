"use client";

import type { ComponentProps } from "react";
import type { Idea } from "@/components/idea-card";
import { VideoChips } from "@/components/videos/video-chips";

const usedAt = (i: Idea) => Date.parse(i.meta.usedAt ?? i.createdAt);
const name = (i: Idea) => i.title ?? i.url ?? "";

/** The chips' order: the pinned (☆) first by name, then the rest by when they were used last. */
export function sortRepos(repos: Idea[]): Idea[] {
  const pinned = (i: Idea) => i.meta.favorite === true;
  return [...repos].sort((a, b) => Number(pinned(b)) - Number(pinned(a))
    || (pinned(a) ? name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) : usedAt(b) - usedAt(a)));
}

/**
 * From a repo's sources used so far (spec 2026-10-10), the pinned first (sortRepos), with the Videos chips' look
 * and folding: the one selected shows its posts below and is the form's source; ↻ writes new ones as the last Create did;
 * × only hides the source, unpinned.
 */
export function RepoChips({ repos, ...rest }: Omit<ComponentProps<typeof VideoChips>, "videos" | "againTip" | "removeTip" | "quoted"> & { repos: Idea[] }) {
  return <VideoChips videos={repos} againTip="Write new posts from it, as last time" removeTip="Hide it; Liked posts stay" quoted={false} {...rest} />;
}
