"use client";

import Link from "next/link";
import { queueOrder } from "@/lib/schedule-queue";
import { fromDatetimeLocal, toDatetimeLocal } from "@/components/write/schedule-format";
import { platformPillCls } from "./schedule-card";
import { PLATFORM_TAG, type PlanPlatform } from "./plan-calendar";

const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";
const timeInputCls = "shrink-0 rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-text-dim";

/** A row of GET /api/drafts/ready — lib/drafts.ts's ReadyPost, its date as an ISO string. */
export type ReadyPost = {
  draftId: string;
  ideaId: string | null;
  xText: string | null;
  linkedinText: string | null;
  /** The platforms still to schedule, X first. */
  platforms: PlanPlatform[];
  readyAt: string;
};

/** The post's first line: its X text's, else its LinkedIn text's. */
export function postStart(post: Pick<ReadyPost, "xText" | "linkedinText">): string {
  const text = post.xText?.trim() || post.linkedinText?.trim() || "";
  return text.split("\n")[0].trim();
}

/**
 * Ready to schedule (schedule in a row, 2026-10-10): the posts made Ready in Compose, at the top of
 * Schedule, each with its start (opening it in Compose, where Back to Compose sends it back), its
 * platforms and its proposed time (lib/schedule-queue.ts), which the owner can change. Rows follow
 * their times, so changing one reorders them. Schedule all opens the guided sequence over them in
 * that order (schedule-all-dialog.tsx). Hidden when nothing is ready.
 */
export function ReadyList({ posts, times, onChangeTime, onScheduleAll }: {
  posts: ReadyPost[];
  /** Each post's time (UTC ISO), by draft id; null when no posting time is free. */
  times: Record<string, string | null>;
  onChangeTime: (draftId: string, at: string) => void;
  onScheduleAll: () => void;
}) {
  if (posts.length === 0) return null;
  const rows = queueOrder(posts.map((post) => ({ ...post, id: post.draftId })), times);
  return (
    <section aria-label="Ready to schedule" className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Ready to schedule<span className="text-text-dim"> ({posts.length})</span></h2>
        <button type="button" onClick={onScheduleAll} className={primaryPillCls}>Schedule all</button>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((post) => {
          const start = postStart(post);
          const time = times[post.draftId];
          return (
            <li key={post.draftId} className="flex flex-wrap items-center gap-2 py-2 text-sm first:pt-0 last:pb-0">
              {post.ideaId
                ? <Link href={`/create?ideaId=${post.ideaId}`} className="min-w-0 flex-1 truncate hover:underline">{start}</Link>
                : <span className="min-w-0 flex-1 truncate">{start}</span>}
              <span className="flex shrink-0 items-center gap-1">
                {post.platforms.map((platform) => <span key={platform} className={platformPillCls}>{PLATFORM_TAG[platform]}</span>)}
              </span>
              <input
                type="datetime-local"
                aria-label={`Time for ${start}`}
                value={time ? toDatetimeLocal(time) : ""}
                onChange={(e) => {
                  const at = fromDatetimeLocal(e.target.value);
                  if (at) onChangeTime(post.draftId, at);
                }}
                className={timeInputCls}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
