"use client";

import { useState } from "react";
import type { Idea } from "@/components/idea-card";

// Three at most, like Trends' searches (owner, 2026-09-27: "anche qui servono
// dei tag per ogni url cercato… sopra i tre vanno nascosti e in caso c'è tasto
// show more. come per le ricerche in trends").
const VISIBLE_CHIPS = 3;

/**
 * The Videos tab's row of pasted videos, by title, newest first: the one
 * selected shows its post ideas below (VideoIdeas); ↻ asks for new ideas, ×
 * removes the video. The same look and folding as Trends' searches strip.
 * From a repo's sources use it too (repos/repo-chips.tsx), with their own tips.
 */
export function VideoChips({
  videos, counts, selectedId, onSelect, onAgain, onRemove, againId,
  againTip = "Find new post ideas in this video", removeTip = "Remove this video; Liked ideas stay", quoted = true,
}: {
  videos: Idea[];
  /** Ideas still to review, per video. */
  counts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAgain: (video: Idea) => void;
  onRemove: (video: Idea) => void;
  /** The video whose ideas are being asked again (every ↻ waits meanwhile). */
  againId: string | null;
  /** ↻'s and ×'s tooltips. */
  againTip?: string;
  removeTip?: string;
  /** The title in quotes, as a video's is. */
  quoted?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (videos.length === 0) return null;

  const folded = videos.slice(VISIBLE_CHIPS);
  const selectedFolded = folded.find((v) => v.id === selectedId);
  const shown = expanded ? videos : selectedFolded ? [...videos.slice(0, VISIBLE_CHIPS), selectedFolded] : videos.slice(0, VISIBLE_CHIPS);
  const foldedCount = folded.length - (selectedFolded ? 1 : 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((video) => {
        const active = video.id === selectedId;
        const title = video.title ?? video.url ?? "Video";
        return (
          <span key={video.id} className={`inline-flex max-w-full items-center rounded-full border text-xs ${active ? "border-text-dim bg-surface-2 text-text" : "border-border text-text-dim"}`}>
            <button type="button" onClick={() => onSelect(video.id)} aria-pressed={active} data-tip={title}
              className="flex min-w-0 items-center rounded-l-full py-1 pl-3 pr-1 hover:text-text">
              {/* A long title folds into its tooltip, so three chips keep to one line. */}
              <span className="max-w-[12rem] truncate">{quoted ? <>&ldquo;{title}&rdquo;</> : title}</span>
              <span className="shrink-0 whitespace-pre text-text-dim"> · {counts[video.id] ?? 0}</span>
            </button>
            <button type="button" onClick={() => onAgain(video)} disabled={againId !== null} aria-busy={againId === video.id || undefined}
              data-tip={againTip} aria-label={`${againTip}: ${title}`}
              className={`px-1 py-1 text-text-dim ${againId === video.id ? "animate-spin text-text" : "hover:text-text disabled:opacity-50"}`}>
              ↻
            </button>
            <button type="button" onClick={() => onRemove(video)} data-tip={removeTip} aria-label={`Remove ${title}`}
              className="rounded-r-full py-1 pl-1 pr-2.5 text-text-dim hover:text-danger">
              ×
            </button>
          </span>
        );
      })}
      {!expanded && foldedCount > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text">
          Show more ({foldedCount})
        </button>
      )}
      {expanded && folded.length > 0 && (
        <button type="button" onClick={() => setExpanded(false)} className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text">
          Show less
        </button>
      )}
    </div>
  );
}
