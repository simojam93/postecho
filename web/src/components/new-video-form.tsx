"use client";

import { useState } from "react";

/**
 * The Videos box (owner, 2026-09-27: "incollo url, postecho prende script del
 * video intero e mi da 6 idee di post"): a pasted YouTube link goes to POST
 * /api/videos/ideas, which saves the video and asks the Mac agent for a dozen
 * post ideas from its whole transcript. The video's section below follows the
 * job (components/videos/video-ideas.tsx). It used to run a search on the
 * video title's words instead: "this is completely wrong".
 */
export function NewVideoForm({ onSearched }: { onSearched: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function findIdeas() {
    const url = value.trim();
    if (!url || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/videos/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Something went wrong. Try again.");
        return;
      }
      setValue("");
      onSearched();
    } catch (e) {
      console.error("video ideas request failed:", e);
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && findIdeas()}
          placeholder="Paste a YouTube link to create X posts"
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim"
        />
        <button
          onClick={findIdeas}
          data-tip="Reads the whole video"
          disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      {error && <p role="status" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
