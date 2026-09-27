"use client";

import { useState } from "react";
import { FIND_KINDS, moveKind, normalizeOrder, type FindKindId } from "@/lib/find-kinds";

/** GET /api/settings's `kindCounts`: Plan's votes per kind (lib/taste.ts's kindCountsOf). */
export type KindCounts = Partial<Record<FindKindId, { good: number; bad: number }>>;

const arrowCls = "rounded-full border border-border px-2 py-0.5 text-xs text-text-dim hover:text-text disabled:opacity-30";

/** "3 did well · 1 didn't" beside a kind, or null before any vote. */
export function countLabel(count: { good: number; bad: number } | undefined): string | null {
  if (!count || count.good + count.bad === 0) return null;
  return `${count.good} did well · ${count.bad} didn't`;
}

/**
 * What to show you first (owner, 2026-09-26: "vuoi rendere ordinabili l'importanza di queste…
 * così sono prioritizzate?" — and "rendilo più semplice e meno tecnico. deve capirlo
 * chiunque"): the five kinds of post, dragged into order on a desktop, moved with the arrows
 * on a phone or the keyboard. Position is priority. Each row names the kind, gives an example
 * and, once there are votes in Plan, how that kind did.
 */
export function FindOrderList({ order, counts, onChange }: {
  order: string[];
  counts: KindCounts | null;
  onChange: (next: FindKindId[]) => void;
}) {
  const ids = normalizeOrder(order);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const byId = new Map(FIND_KINDS.map((kind) => [kind.id, kind]));

  return (
    <ol>
      {ids.map((id, i) => {
        const kind = byId.get(id)!;
        const count = countLabel(counts?.[id]);
        return (
          <li
            key={id}
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts a drag only with data set.
              e.dataTransfer.setData("text/plain", id);
            }}
            onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) onChange(moveKind(ids, dragFrom, i));
              setDragFrom(null);
            }}
            onDragEnd={() => setDragFrom(null)}
            className={`flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 ${dragFrom === i ? "opacity-50" : ""}`}
          >
            <span aria-hidden className="cursor-grab select-none text-text-dim">⋮⋮</span>
            <span className="w-4 shrink-0 text-xs text-text-dim">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block">{kind.name}</span>
              <span className="block truncate text-xs text-text-dim">“{kind.example}”</span>
              {/* Its own line: on a phone the example is cut, and the votes must still show. */}
              {count && <span className="block text-xs text-text-dim">{count}</span>}
            </span>
            <span className="flex shrink-0 gap-1">
              <button type="button" aria-label={`Move ${kind.name} up`} disabled={i === 0}
                onClick={() => onChange(moveKind(ids, i, i - 1))} className={arrowCls}>↑</button>
              <button type="button" aria-label={`Move ${kind.name} down`} disabled={i === ids.length - 1}
                onClick={() => onChange(moveKind(ids, i, i + 1))} className={arrowCls}>↓</button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
