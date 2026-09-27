"use client";

import { useState } from "react";
import { X_POSTS_PER_SEARCH, X_PRICES_USD } from "@/lib/sources/x";

const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const JSON_HEADERS = { "Content-Type": "application/json" };

export type XKeyStatus = { connected: boolean; hint: string | null };

/**
 * Settings' **X (optional)** (owner, 2026-09-24: "metti in settings la
 * possibilità di aggiungere X o no, come api key. se uno la aggiunge ovviamente
 * la trova poi nel find ideas"). The owner pastes their own X API bearer
 * token; it's saved at once, sealed, and never shown again — only its last
 * four characters. With a key, every Find Ideas search also reads up to
 * `postsPerSearch` posts from X (lib/sources/x.ts), which X bills to the
 * owner's developer account: the cost is spelled out next to the number.
 * The number itself saves with the page's Save settings, like the other
 * search settings.
 */
export function XSourceSection({ status, postsPerSearch, onPostsPerSearch, onKeyChanged }: {
  status: XKeyStatus | null;
  postsPerSearch: number;
  onPostsPerSearch: (n: number) => void;
  /** The key was saved or removed — the page reloads the status and the Sources list. */
  onKeyChanged: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveKey(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ xBearerToken: value }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const fieldError = body?.fields?.xBearerToken?.[0];
        setError(typeof fieldError === "string" ? fieldError : "Couldn't save the key.");
        return;
      }
      setToken("");
      await onKeyChanged();
    } catch {
      setError("Network error: the key wasn't saved.");
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    if (!window.confirm("Remove your X key? Searches stop reading X until you add one again.")) return;
    void saveKey("");
  }

  const perSearch = (postsPerSearch * X_PRICES_USD.postRead).toFixed(2);

  return (
    <section className="space-y-3">
      <p className="text-xs text-text-dim">
        Add your own X API key and Find Ideas searches X too, through the official API. X bills your developer account per use:
        ${X_PRICES_USD.postRead} per post read, and ${X_PRICES_USD.userRead} per author, looked up only for the X posts that make your results.
        Create an app and copy its Bearer Token at{" "}
        <a href="https://console.x.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-text">console.x.com</a>,
        and set a spending limit there.
      </p>

      {status === null ? (
        <p className="text-sm text-text-dim">Loading…</p>
      ) : status.connected ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span aria-hidden className="text-ok">●</span>
          <span>Key saved · {status.hint}</span>
          <button type="button" onClick={remove} disabled={busy} className="text-xs text-text-dim underline hover:text-text disabled:opacity-50">
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (token.trim()) void saveKey(token.trim()); }} className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            aria-label="X API bearer token"
            className={inputCls}
          />
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="shrink-0 rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save key"}
          </button>
        </form>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      <label className="block max-w-xs space-y-1.5">
        <span className="text-sm text-text-dim">Posts read from X per search ({X_POSTS_PER_SEARCH.min}–{X_POSTS_PER_SEARCH.max})</span>
        <input
          type="number"
          min={X_POSTS_PER_SEARCH.min}
          max={X_POSTS_PER_SEARCH.max}
          step={10}
          value={postsPerSearch}
          onChange={(e) => onPostsPerSearch(Number(e.target.value))}
          className={inputCls}
        />
      </label>
      <p className="text-xs text-text-dim">
        About ${perSearch} per search, plus about ${X_PRICES_USD.userRead} for each X post that makes your results.
      </p>
    </section>
  );
}
