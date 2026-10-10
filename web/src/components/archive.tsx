"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ClampedText } from "@/components/clamped-text";
import { Modal } from "@/components/modal";
import { dayKeyOf, type DayKey } from "@/components/plan/plan-calendar";
import { PLATFORM_LABEL } from "@/components/write/post-state";
import { formatRomeSlot } from "@/components/write/schedule-format";
import type { Platform } from "@/components/write/types";

/** GET /api/drafts/archive's post, dates as ISO strings (lib/drafts.ts's ArchivedPost). */
export type ArchivedPost = {
  draftId: string;
  ideaId: string | null;
  idea: { id: string; title: string | null; url: string | null; kind: string } | null;
  xText: string | null;
  linkedinText: string | null;
  schedules: Array<{ platform: Platform; publishAt: string; status: string }>;
  updatedAt: string;
};

function CopyText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" data-tip={`Copy the ${label} text`}
      onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}
      className="rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text">
      {copied ? "Copied" : `Copy ${label}`}
    </button>
  );
}

const seeCls = "ml-auto text-xs text-text-dim underline hover:text-text";

/**
 * The Archive (owner, 2026-09-27: "una volta che scheduli un post in write,
 * quelli vanno in un archivio… così si parte sul pulito e live vedi solo le
 * bozze"): the posts scheduled or posted, latest first — where and when each
 * went, its text to copy, and its day in Calendar. `onSeeDay` is Calendar's:
 * it shows the day there instead of following the link.
 */
export function ArchiveList({ posts, now, onSeeDay }: { posts: ArchivedPost[]; now: string; onSeeDay?: (day: DayKey) => void }) {
  if (posts.length === 0) return <p className="text-sm text-text-dim">Nothing scheduled or posted yet.</p>;
  return (
    <ul className="space-y-3">
      {posts.map((post) => {
        const first = post.schedules[0];
        const day = first ? dayKeyOf(first.publishAt) : null;
        return (
          <li key={post.draftId} className="space-y-2 rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {post.schedules.map((row) => (
                <span key={`${row.platform}${row.publishAt}`} className="rounded-full bg-ok/10 px-2.5 py-0.5 text-ok">
                  ✓ {PLATFORM_LABEL[row.platform]} · {formatRomeSlot(row.publishAt, now)}
                </span>
              ))}
              {post.idea?.title && <span className="ml-auto min-w-0 max-w-[50%] truncate text-text-dim">{post.idea.title}</span>}
            </div>
            <ClampedText lines={3} text={post.xText ?? post.linkedinText ?? ""} className="whitespace-pre-wrap break-words text-sm leading-relaxed" />
            <div className="flex flex-wrap items-center gap-2">
              {post.xText && <CopyText label="X" text={post.xText} />}
              {post.linkedinText && <CopyText label="LinkedIn" text={post.linkedinText} />}
              {day && (onSeeDay
                ? <button type="button" onClick={() => onSeeDay(day)} className={seeCls}>See in Schedule</button>
                : <Link href={`/calendar?day=${day}`} className={seeCls}>See in Schedule</Link>)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Archive as a window in front of the page, like Settings (owner,
 * 2026-09-27: "deve essere un pop up come i settings così lo chiudo in alto a
 * destra con la x e con l'esc"): the title and × stay put while the list scrolls.
 */
export function ArchiveWindow({ posts, now, onSeeDay, onClose }: {
  posts: ArchivedPost[];
  now: string;
  onSeeDay?: (day: DayKey) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onRequestClose={onClose} width="48rem">
      <div className="flex max-h-[88vh] flex-col">
        <div className="flex items-center justify-between gap-3 px-6 pb-3 pt-5">
          <h2 id={titleId} className="text-base font-semibold">Archive</h2>
          <button type="button" onClick={onClose} aria-label="Close archive"
            className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <ArchiveList posts={posts} now={now} onSeeDay={onSeeDay} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * Archive (N), at the top right of Write and Calendar alike (owner,
 * 2026-09-27: "devono essere entrambi tutti a dx… ed entrambi devono portarti
 * alla pagina"): hidden while nothing is archived; opens ArchiveWindow. Reads
 * GET /api/drafts/archive on mount, whenever `refreshKey` changes (a post
 * scheduled or removed meanwhile) and when opened.
 */
export function ArchiveButton({ refreshKey, onSeeDay, className = "" }: {
  refreshKey?: number | string;
  onSeeDay?: (day: DayKey) => void;
  className?: string;
}) {
  const [archive, setArchive] = useState<{ posts: ArchivedPost[]; at: string } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/drafts/archive");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.posts)) setArchive({ posts: body.posts, at: new Date().toISOString() });
      } catch (e) {
        console.error("failed to load the archive:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey, open]);

  const count = archive?.posts.length ?? 0;
  if (count === 0) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" data-tip="Posts you scheduled or posted"
        className={`shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium text-text-dim hover:text-text ${className}`}>
        Archive ({count})
      </button>
      {open && archive && (
        <ArchiveWindow
          posts={archive.posts}
          now={archive.at}
          onSeeDay={onSeeDay ? (day) => { setOpen(false); onSeeDay(day); } : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
