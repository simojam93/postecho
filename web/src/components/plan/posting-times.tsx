"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { normalizeSlots, SlotList } from "@/components/settings/slot-list";

const PLATFORMS = [["x", "X"], ["linkedin", "LinkedIn"]] as const;

/**
 * The times the owner usually posts, per platform, in Calendar since the
 * Publishing tab went (owner, 2026-09-27: "non serve più il tab publishing
 * del tutto"): Schedule suggests the next free one, and Calendar shows the
 * free ones on each day. A change saves at once (PUT /api/settings
 * defaultSlots); `onSaved` hands the saved times back to the calendar.
 */
export function PostingTimes({ slots, onSaved, onClose }: {
  slots: Record<string, string[]>;
  onSaved: (next: Record<string, string[]>) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [current, setCurrent] = useState(slots);
  const [error, setError] = useState<string | null>(null);

  async function change(platform: string, next: string[]) {
    const all = { ...current, [platform]: next };
    setCurrent(all);
    setError(null);
    const saved = Object.fromEntries(Object.entries(all).map(([p, times]) => [p, normalizeSlots(times)]));
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultSlots: saved }),
    }).catch(() => null);
    if (res?.ok) onSaved(saved);
    else setError("Couldn't save that. Try again.");
  }

  return (
    <Modal labelledBy={titleId} onRequestClose={onClose} width="32rem">
      <div className="space-y-5 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">Posting times</h2>
          <button type="button" onClick={onClose} aria-label="Close posting times"
            className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text">
            ×
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {PLATFORMS.map(([platform, name]) => (
            <div key={platform} className="space-y-2">
              <span className="block text-sm">{name}</span>
              <SlotList platform={name} slots={current[platform] ?? []} onChange={(next) => void change(platform, next)} />
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
