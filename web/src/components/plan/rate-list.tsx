"use client";

import { RateCard } from "./schedule-card";
import { type PlanOutcome, type PlanPost } from "./plan-calendar";

// The Today pill's shape (month-grid.tsx's DayNav), like archive-list.tsx's Back.
const backPillCls = "rounded-full border border-border px-3 py-1 text-xs font-medium text-text-dim hover:text-text";

/**
 * Plan's To rate (owner, 2026-09-26): the posts out for more than a day with no vote yet,
 * from any month, newest first (lib/schedule.ts's listToRate). It takes the day list's place
 * while open, like the Archive; a vote takes its card off at once.
 */
export function RateList({ posts, rating, errors, onRate, onBack }: {
  posts: PlanPost[];
  /** The post whose vote is being saved, if any. */
  rating: string | null;
  errors: Record<string, string>;
  onRate: (post: PlanPost, outcome: PlanOutcome | null) => void;
  onBack: () => void;
}) {
  return (
    <section aria-label="To rate" className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">
          To rate<span className="text-text-dim"> · how did they do?</span>
        </h2>
        <button type="button" onClick={onBack} className={backPillCls}>Back</button>
      </div>

      {posts.length === 0 && <p className="text-sm text-text-dim">Nothing left to rate.</p>}

      <ul className="space-y-3">
        {posts.map((post) => (
          <li key={post.id}>
            <RateCard post={post} rating={rating === post.id} error={errors[post.id] ?? null} onRate={onRate} />
          </li>
        ))}
      </ul>
    </section>
  );
}
