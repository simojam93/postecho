"use client";

import { ClampedText } from "@/components/clamped-text";
import { cardText } from "@/components/card-text";
import { decodeEntities } from "@/lib/enrich";
import { sourceLabel } from "@/lib/sources/labels";
import { isVideoPost } from "@/lib/video-post";
import type { SourceIdea } from "./types";

// Same cheap "will this content exceed the 5-line clamp" proxy as
// components/idea-card.tsx — no layout measurement, and erring toward
// showing the toggle on borderline content costs nothing.
const CONTENT_CLAMP_CHAR_THRESHOLD = 280;
const CONTENT_CLAMP_NEWLINE_THRESHOLD = 4;
function likelyExceedsClamp(content: string): boolean {
  const newlineCount = (content.match(/\n/g) ?? []).length;
  return content.length > CONTENT_CLAMP_CHAR_THRESHOLD || newlineCount >= CONTENT_CLAMP_NEWLINE_THRESHOLD;
}

/**
 * The idea the post is written from (M2.5 plan, task W3), rendered like a
 * Find Ideas card minus its actions: source pill + author, title, content
 * clamped to five lines with a "more" toggle, the search query it came from
 * and an "open ↗" link. A video (kind youtube) has no content, so it comes
 * out as the plan asks — title + link. The header's right side carries a
 * dim **Remove post** — the same action as the × on the post's strip chip,
 * so the post on screen can be removed without hunting for its chip. A
 * video's ready post (lib/video-post.ts) is already the editor's text, so
 * its source is the video: its title and link.
 */
export function SourceCard({ idea, onRemove, removeBusy = false }: {
  idea: SourceIdea;
  /** Remove this post and its takes from Write — see removePost in app/(authed)/create/page.tsx. */
  onRemove?: () => void;
  /** A removal request is in flight — the button is disabled meanwhile. */
  removeBusy?: boolean;
}) {
  const pill = sourceLabel(idea.meta.sourceName ?? idea.kind).tag;
  const videoPost = isVideoPost(idea);
  // A post from a repo (2026-10-10) is the post below: the card names its repository only.
  const repoPost = idea.kind === "repo_post";
  const title = videoPost ? idea.meta.videoTitle ?? null : repoPost ? null : idea.title;
  const content = videoPost || repoPost ? null : idea.content;
  const url = videoPost ? idea.meta.articleUrl ?? null : idea.url;

  return (
    <section aria-label="Source" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center gap-2 text-sm text-text-dim">
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim">
          {pill}
        </span>
        {/* A manual note is the owner's own text (Write's + New), not someone else's post. */}
        <span className="min-w-0 truncate">{idea.kind === "note" ? "Your text" : repoPost ? idea.meta.repoName ?? "Your repository" : idea.author ?? idea.kind}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={removeBusy}
            data-tip="Remove this post from Write"
            className="ml-auto shrink-0 text-xs text-text-dim hover:text-danger disabled:opacity-50"
          >
            {removeBusy ? "Removing…" : "Remove post"}
          </button>
        )}
      </div>

      {title && idea.kind !== "x_post" && <div className="break-words font-bold">{decodeEntities(title)}</div>}
      {content && (
        <ClampedText
          lines={5}
          text={cardText(content)}
          likely={likelyExceedsClamp(content)}
          className="whitespace-pre-wrap break-words text-sm leading-relaxed"
        />
      )}

      {(idea.meta.topic || url) && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-text-dim">
          {url && (
            <a href={url} target="_blank" rel="noreferrer" data-tip={videoPost ? "Open the video" : "Open the original post"} aria-label="Open the original"
              className="shrink-0 rounded-full px-1.5 py-1 text-sm hover:text-text">
              ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
}
