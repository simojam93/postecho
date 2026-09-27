"use client";

import { useEffect, useState } from "react";
import { ClampedText } from "@/components/clamped-text";
import { SlopBadge } from "@/components/slop-badge";
import { inspirationSinceAnalysis, type StyleInspirationItem } from "@/lib/library";
import { sourceLabel } from "@/lib/sources/labels";

/**
 * Settings' **Style inspiration** (owner, 2026-09-24: "se vedo post
 * interessanti in find ideas e voglio infilarmi nel mio tone of voice… può
 * aiutare a migliorare il mio stile in modo furbo" — "si mi gasa"): the
 * posts by other people added from a Find Ideas card's right-click menu. Analyze my
 * posts borrows their structure and rhythm for the style guide, never their
 * voice or content. Kept apart from the tone examples, which are the owner's
 * own posts. Says how many were added since the last analysis.
 */
export function StyleInspirationSection({ analyzedAt }: { analyzedAt: string | null }) {
  const [items, setItems] = useState<StyleInspirationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/style-inspiration");
        if (!res.ok) throw new Error(`style inspiration ${res.status}`);
        const body = await res.json();
        if (!cancelled) setItems(body.items);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load your style inspiration.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function remove(id: string) {
    setItems((current) => current?.filter((i) => i.id !== id) ?? current);
    const res = await fetch(`/api/style-inspiration?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) setError("Couldn't remove it. Reload and try again.");
  }

  const fresh = items ? inspirationSinceAnalysis(items, analyzedAt) : 0;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Style inspiration</h3>
      <p className="text-xs text-text-dim">
        Posts by other people whose style you like: right-click a card in Find Ideas (long-press on a phone) and pick <span className="font-medium text-text">Learn from its style</span>.
        Analyze my posts borrows their structure and rhythm for your style guide, never their voice or content.
      </p>
      {items && items.length > 0 && fresh > 0 && (
        <p className="text-xs text-accent">
          {fresh} added since the last analysis. Press Analyze my posts above to use {fresh === 1 ? "it" : "them"}.
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {items === null && !error && <p className="text-sm text-text-dim">Loading…</p>}
      {items?.length === 0 && <p className="text-sm text-text-dim">Nothing yet.</p>}
      <ul className="space-y-2">
        {items?.map((item) => (
          <li key={item.id} className="space-y-1.5 rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center gap-2 text-xs text-text-dim">
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide">{sourceLabel(item.kind).tag}</span>
              <span className="min-w-0 truncate">{item.author ?? item.kind}</span>
              {item.slopScore !== null && <SlopBadge slop={{ slopScore: item.slopScore, verdict: "" }} />}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer" data-tip="Open the original post" aria-label="Open the original" className="px-1.5 hover:text-text">↗</a>
                )}
                <button type="button" onClick={() => void remove(item.id)} aria-label="Remove from style inspiration" data-tip="Stop learning from this post" className="px-1.5 hover:text-danger">×</button>
              </span>
            </div>
            <ClampedText lines={3} text={item.text} className="whitespace-pre-wrap break-words text-sm leading-relaxed" />
          </li>
        ))}
      </ul>
    </section>
  );
}
