"use client";

import type { ComponentProps } from "react";
import type { Idea } from "@/components/idea-card";
import { VideoChips } from "@/components/videos/video-chips";

/**
 * From a repo's sources used so far (spec 2026-10-10), newest first, with the Videos chips' look
 * and folding: the one selected shows its posts below; ↻ writes new ones as the last Create did;
 * × only hides the source.
 */
export function RepoChips({ repos, ...rest }: Omit<ComponentProps<typeof VideoChips>, "videos" | "againTip" | "removeTip" | "quoted"> & { repos: Idea[] }) {
  return <VideoChips videos={repos} againTip="Write new posts from it, as last time" removeTip="Hide it; Liked posts stay" quoted={false} {...rest} />;
}
