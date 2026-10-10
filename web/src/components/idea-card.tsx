"use client";

import { CardMenu, createLongPress, keepsBrowserMenu } from "@/components/card-menu";
import { ClampedText } from "@/components/clamped-text";
import { cardText } from "@/components/card-text";
import { decodeEntities } from "@/lib/enrich";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { SlopBadge } from "@/components/slop-badge";
import { humanScore } from "@/lib/human-score";
import { sourceLabel } from "@/lib/sources/labels";
import { isVideoPost } from "@/lib/video-post";

export type Idea = {
  id: string; url: string | null; kind: string; title: string | null;
  content: string | null; author: string | null; status: string;
  source?: string | null;
  // Recency tiebreak for page.tsx's rank-first grid ordering (Task A0) —
  // always present (every ideas row has it; see db/schema.ts), ISO string
  // as returned by GET /api/ideas.
  createdAt: string;
  meta: {
    thumbnailUrl?: string | null; score?: number; topic?: string; sourceName?: string;
    // jev-judge's quality-aware ranking (see lib/scout-run.ts's meta shape). `rank` is the
    // combined 0..100 signal shown as the primary badge; older scouted ideas saved before
    // this landed only have `score`, so the badge falls back to that.
    quality?: number; tasteFit?: number | null; rank?: number;
    // Jev's AI-style verdict on the post (lib/scout-run.ts's rateCards,
    // 2026-09-24), shown as the human score "Human 8/10".
    aiStyle?: { slopScore?: number; verdict?: string };
    // A video_idea (2026-09-27): the pasted video it came from, and its place in the batch (best first).
    // `format` "post": a ready X post (lib/video-post.ts); without it, a topic from before.
    videoId?: string; order?: number; fromDescription?: boolean; format?: string;
    // A pasted video (api/videos/ideas): when it was pasted last — the Videos chips' order.
    pastedAt?: string;
    // From a repo (2026-10-10): a source's type and when it was used last (the chips' order);
    // a post's source (`format` is "x" | "linkedin" | "article" then).
    sourceType?: string; usedAt?: string; repoId?: string; repoName?: string;
  };
};

const REPO_FORMAT_LABEL: Record<string, string> = { x: "X post", linkedin: "LinkedIn post", article: "X article" };

/** A video's ready post before its more: set so the card is as tall as a Trends one (Show more level with the account bar). */
const VIDEO_POST_LINES = 5;

// Source pill label (header, left): from meta.sourceName (set on every
// scouted idea — see lib/scout-run.ts) when present, else the idea's own
// kind. Short `tag` forms (from the shared sources/labels.ts map) per the
// M1.5 cards-redesign spec — the "recent searches"/source-filter row in
// page.tsx uses the longer `label` names instead.
function sourcePillLabel(idea: Idea): string {
  return sourceLabel(idea.meta.sourceName ?? idea.kind).tag;
}

// ♥ (M1.5 search-results UX round, owner direction 2026-09-21; extended to
// the seven-adapters wiring and then the lobsters/lemmy sources, 2026-09-22)
// is offered on scouted cards (bluesky/hackernews plus every later discovery
// source — see lib/sources/all.ts) plus manually-pasted x_post/article
// cards — not "note" (the owner's own raw idea text — nothing to "like"
// about your own input) or a pasted "youtube" video (the owner's own input
// too, with its own generate-focused flow). A *scouted* youtube result is
// different: since M3.5 U1 (owner direction, 2026-09-23: "YT come source lo
// voglio comunque vedere nella pagina trends") it is a Trends result like
// any other source's, so it gets ♥ too — see `canKeep` below, which also
// shows the filled ♥ on any card already on the Liked shelf (kept/used),
// whatever its kind, so it can always be un-liked.
const KEEPABLE_KINDS = new Set([
  "bluesky", "hackernews", "arxiv", "github", "devto", "mastodon", "producthunt",
  "lobsters", "lemmy",
  "x_post", "article",
]);

// Below this, a card's content is unlikely to actually exceed the 5-line
// clamp — no ref/layout measurement involved, just a cheap proxy so the
// "more" toggle doesn't show up on content that already fits. Erring toward
// showing it on borderline content costs nothing (clicking "more" on
// already-fully-visible text just does nothing visually).
const CONTENT_CLAMP_CHAR_THRESHOLD = 280;
const CONTENT_CLAMP_NEWLINE_THRESHOLD = 4;
function likelyExceedsClamp(content: string): boolean {
  const newlineCount = (content.match(/\n/g) ?? []).length;
  return content.length > CONTENT_CLAMP_CHAR_THRESHOLD || newlineCount >= CONTENT_CLAMP_NEWLINE_THRESHOLD;
}

export function IdeaCard({ idea, onStatus, onUse, inStyle = false, onStyle }: {
  idea: Idea;
  onStatus: (id: string, status: "used" | "dismissed" | "archived" | "kept" | "new") => Promise<void>;
  /**
   * "Use" (task A9): starts generation from this idea and navigates to
   * Write, rather than just flipping a status like the other buttons — a
   * separate prop (not routed through onStatus) since it has a genuinely
   * different shape (POST /api/drafts/from-idea + router.push, owned by
   * page.tsx, same "card calls back up, parent does the fetch" split as
   * onStatus).
   */
  /** The card is in Settings' style inspiration (lib/library.ts). */
  inStyle?: boolean;
  /** **Learn from its style**, from the card's right-click menu (2026-09-26; it was the Aa button): add the post to style inspiration, or take it off. */
  onStyle?: (idea: Idea, add: boolean) => Promise<void>;
  onUse: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // Use in flight: the route may first read the linked article and the
  // discussion (lib/deep-read.ts), a few seconds — the button says so.
  const [using, setUsing] = useState(false);
  const [useError, setUseError] = useState<string | null>(null);
  // The card's own menu (owner, 2026-09-26: "togli anche Aa su tutti e rendilo solo
  // selezionabile con tasto destro sulla card"): right-click, or a long press on a phone.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasMenu = Boolean(onStyle && (idea.content ?? idea.title));
  const longPress = useMemo(() => createLongPress((x, y) => setMenu({ x, y })), []);
  useEffect(() => () => longPress.up(), [longPress]);
  // Liked (M2.5 W1) = kept (♥) or used (Use pressed — POST /api/drafts/
  // from-idea marks it): both render the filled ♥, and clicking it sends the
  // idea back to `new`, i.e. back to Trends/Videos.
  const liked = idea.status === "kept" || idea.status === "used";
  const canKeep =
    liked || KEEPABLE_KINDS.has(idea.kind) || (idea.kind === "youtube" && idea.source === "scout");

  // `rank` is the primary badge once present; a scouted idea saved before jev-judge gained
  // quality/rank only has `score`, so the badge falls back to that (with no title, matching
  // this component's previous behavior for those rows).
  const { score, quality, rank } = idea.meta;
  const badgeValue = typeof rank === "number" ? rank : score;
  const badgeTitle = typeof rank === "number"
    ? `rank — relevance ${Math.round(score ?? 0)}, quality ${Math.round(quality ?? 0)}`
    : undefined;
  const videoPost = isVideoPost(idea);
  // A post from a repo (2026-10-10) is ready too: Use keeps it as it is.
  const readyPost = videoPost || idea.kind === "repo_post";

  async function trigger(status: "used" | "dismissed" | "archived" | "kept" | "new") {
    if (busy) return;
    setBusy(true);
    try {
      await onStatus(idea.id, status);
    } finally {
      setBusy(false);
    }
  }

  /** **Learn from its style**: warn first when Jev reads the post as AI — learning style from slop is the opposite of the point. */
  async function learnStyle() {
    if (!onStyle || busy) return;
    const slop = idea.meta.aiStyle?.slopScore;
    if (!inStyle && typeof slop === "number" && humanScore(slop) <= 3
      && !window.confirm(`This post reads AI ${humanScore(slop)}/10. Learn from its style anyway?`)) return;
    setBusy(true);
    try {
      await onStyle(idea, !inStyle);
    } finally {
      setBusy(false);
    }
  }

  /** Right-click, or the keyboard's menu key: the card's menu, unless the browser's own fits better (see keepsBrowserMenu). */
  function openMenu(e: MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    const hasSelection = Boolean(selection && !selection.isCollapsed && selection.anchorNode && e.currentTarget.contains(selection.anchorNode));
    if (keepsBrowserMenu(e.target, hasSelection)) return;
    e.preventDefault();
    if (e.clientX === 0 && e.clientY === 0) {
      // The menu key has no pointer: open at the card's corner.
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.left + 16, y: rect.top + 16 });
    } else {
      setMenu({ x: e.clientX, y: e.clientY });
    }
  }

  async function handleUse() {
    if (busy) return;
    setBusy(true);
    setUsing(true);
    setUseError(null);
    try {
      await onUse(idea.id);
    } catch (e) {
      console.error("failed to start generation from idea:", e);
      setUseError("Failed to start generation.");
    } finally {
      setBusy(false);
      setUsing(false);
    }
  }

  return (
    <div
      onContextMenu={hasMenu ? openMenu : undefined}
      onPointerDown={hasMenu ? (e) => { if (e.pointerType === "touch" && !keepsBrowserMenu(e.target, false)) longPress.down(e.clientX, e.clientY); } : undefined}
      onPointerMove={hasMenu ? (e) => { if (e.pointerType === "touch") longPress.move(e.clientX, e.clientY); } : undefined}
      onPointerUp={hasMenu ? longPress.up : undefined}
      onPointerCancel={hasMenu ? longPress.up : undefined}
      onClickCapture={hasMenu ? (e) => { if (longPress.takeFired()) { e.preventDefault(); e.stopPropagation(); } } : undefined}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 [-webkit-touch-callout:none] [@media(pointer:coarse)]:select-none"
    >
      {/* Header: ONE row — source pill + author (left), "used" badge + rank pill + human score (right). No "fits you" dot
          (owner, 2026-09-27: "toglilo dappertutto, perché non mi voglio far condizionare").
          A video's topic has no source pill or author: all twelve come from the video its chip names (2026-09-27). */}
      <div className="flex min-h-5 items-center justify-between gap-2 text-sm text-text-dim">
        {idea.kind === "repo_post" ? (
          // Posts from a repo mix formats over several asks: the pill says which this one is (2026-10-10).
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim">
            {REPO_FORMAT_LABEL[idea.meta.format ?? ""] ?? "Post"}
          </span>
        ) : idea.kind === "video_idea" ? <span aria-hidden /> : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim">
              {sourcePillLabel(idea)}
            </span>
            <span className="min-w-0 truncate">{idea.author ?? idea.kind}</span>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Liked shelf only (M2.5 W1): a used idea is one Write already has takes for. */}
          {idea.status === "used" && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-ok">used</span>
          )}
          {typeof badgeValue === "number" && (
            <span data-tip={badgeTitle} className="whitespace-nowrap rounded-full border border-border px-2 text-xs text-text-dim">
              ✦ {Math.round(badgeValue)}
            </span>
          )}
          {/* Jev's human score, right of ✦ (owner, 2026-09-24). */}
          {typeof idea.meta.aiStyle?.slopScore === "number" && (
            <SlopBadge compact slop={{ slopScore: idea.meta.aiStyle.slopScore, verdict: idea.meta.aiStyle.verdict ?? "" }} />
          )}
        </div>
      </div>

      {idea.kind === "youtube" && idea.meta.thumbnailUrl && (
        // Plain <img>, not next/image: thumbnails come from arbitrary oEmbed
        // hosts, so there's no fixed remotePatterns allowlist to configure.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={idea.meta.thumbnailUrl} alt={idea.title ?? "Video thumbnail"} className="rounded-lg" />
      )}
      {videoPost ? (
        // A video's ready X post (2026-09-27: "post X pronti all'attacco senza titolo"): the post itself,
        // as tall as a Trends card's text, so Show more stays level with the account bar.
        <ClampedText lines={VIDEO_POST_LINES} text={idea.content ?? ""} className="whitespace-pre-wrap break-words text-sm leading-relaxed" />
      ) : idea.kind === "video_idea" ? (
        // A video's topic, from before the ready posts: a title in two lines, then three lines of context and more.
        <div className="min-w-0">
          {idea.title && <p className="line-clamp-2 break-words text-sm font-semibold leading-relaxed">{decodeEntities(idea.title)}</p>}
          {idea.content && <ClampedText lines={3} text={idea.content} className="break-words text-sm leading-relaxed" />}
        </div>
      ) : idea.title && idea.kind !== "x_post" && <div className="break-words font-bold">{decodeEntities(idea.title)}</div>}
      {idea.content && idea.kind !== "video_idea" && (
        <ClampedText
          lines={5}
          text={cardText(idea.content)}
          likely={likelyExceedsClamp(idea.content)}
          className="whitespace-pre-wrap break-words text-sm leading-relaxed"
        />
      )}

      {/* Footer: ONE row — query label + "open ↗" (left), ♥ / Dismiss / Use (right).
          `mt-auto` pins it to the card's bottom edge: the grid stretches every
          card in a row to the tallest one, so the buttons line up across cards
          whatever the length of the text above (owner, 2026-09-23: "che i tasti
          siano sempre allineati"). */}
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-text-dim">
        <div className="flex min-w-0 items-center gap-2">
          {/* Just the arrow (owner, 2026-09-24: "lascia solo la freccetta… si capisce"). */}
          {idea.url && (
            <a href={idea.url} target="_blank" rel="noreferrer" data-tip="Open the original post" aria-label="Open the original"
              className="shrink-0 rounded-full px-1.5 py-1 text-sm hover:text-text">
              ↗
            </a>
          )}
          {useError && <span className="text-danger">{useError}</span>}
        </div>
        <div className="flex shrink-0 gap-2">
          {canKeep && (
            <button
              onClick={() => trigger(liked ? "new" : "kept")}
              disabled={busy}
              data-tip={liked ? "Remove it from Liked" : "Keep it in Liked"}
              aria-label={liked ? "Remove from Liked" : "Like"}
              className={`rounded-full border px-3 py-1.5 text-sm disabled:opacity-50 ${
                liked ? "border-danger text-danger" : "border-border text-text-dim hover:text-text"
              }`}
            >
              {liked ? "♥" : "♡"}
            </button>
          )}
          <button
            onClick={() => trigger("dismissed")}
            disabled={busy}
            data-tip="Hide it: you'll see fewer like it"
            className="rounded-full border border-border px-3 py-1.5 text-sm text-text-dim hover:text-text disabled:opacity-50"
          >
            Dismiss
          </button>
          {/* Stays enabled on a `used` card too (M2.5 W1): generating more
              takes for an idea already on the Liked shelf is allowed — Write
              shows every take for it. */}
          <button
            onClick={handleUse}
            disabled={busy}
            data-tip={readyPost ? "Edit and schedule it in Compose" : "Write a post from it"}
            className="rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50"
          >
            {using ? (readyPost ? "Opening…" : "Reading…") : "Use"}
          </button>
        </div>
      </div>
      {menu && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: inStyle ? "Stop learning from its style" : "Learn from its style", icon: "Aa", onSelect: () => void learnStyle() }]}
        />
      )}
    </div>
  );
}
