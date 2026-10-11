"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  dismissNotice, noticesSnapshot, serverNoticesSnapshot, subscribeNotices, type MediaNotice,
} from "@/components/work-status";

const NAME: Record<MediaNotice["kind"], string> = { video: "Video", screenshots: "Screenshots" };

/** "Video ready to check in “…”", or that it didn't work. */
export function noticeText(n: MediaNotice): string {
  const name = NAME[n.kind];
  return n.ok ? `${name} ready to check in “${n.title}”` : `${name} for “${n.title}” didn't work`;
}

/** Where the post opens: Compose, on that post. */
export function noticeHref(n: MediaNotice): string {
  return `/create?ideaId=${encodeURIComponent(n.ideaId)}`;
}

/** Asks once for the Mac's notifications, when a long media job starts: they say it's ready while PostEcho is in the background. */
export function askForNotifications(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => {});
}

/**
 * A post's screenshots or video that ended while the owner went on writing (2026-10-11): a notice in
 * a corner of every page, which opens the post or goes away. With PostEcho in the background, a
 * notification of the Mac says it too, if the owner allowed them.
 */
export function MediaNotices() {
  const router = useRouter();
  const notices = useSyncExternalStore(subscribeNotices, noticesSnapshot, serverNoticesSnapshot);
  const told = useRef(new Set<string>());

  useEffect(() => {
    for (const n of notices) {
      if (told.current.has(n.jobId)) continue;
      told.current.add(n.jobId);
      if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) continue;
      try {
        const note = new Notification("PostEcho", { body: noticeText(n), tag: n.jobId });
        note.onclick = () => {
          window.focus();
          dismissNotice(n.jobId);
          router.push(noticeHref(n));
          note.close();
        };
      } catch {
        // The notice on the page still says it.
      }
    }
  }, [notices, router]);

  if (notices.length === 0) return null;
  return (
    <div role="status" className="fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {notices.map((n) => (
        <div key={n.jobId} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-3 text-sm shadow-lg">
          <span className={`size-2 shrink-0 rounded-full ${n.ok ? "bg-ok" : "bg-danger"}`} aria-hidden />
          <span className="min-w-0 flex-1">{noticeText(n)}</span>
          <button
            type="button"
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink"
            onClick={() => { dismissNotice(n.jobId); router.push(noticeHref(n)); }}
          >
            Open
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-text-dim hover:text-text"
            onClick={() => dismissNotice(n.jobId)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
