"use client";

import { useEffect, useRef, useState } from "react";
import { SlopBadge, type SlopResult } from "@/components/slop-badge";

const JSON_HEADERS = { "Content-Type": "application/json" };
/** POST /api/ideas accepts up to 8000 characters of text. */
const MAX_CHARS = 8000;
/** The AI slop check reads up to 5000 characters (POST /api/slop-check), and needs a sentence or two. */
const CHECK_MAX_CHARS = 5000;
const CHECK_MIN_CHARS = 40;
/** A pause in typing before the check; a paste checks at once. */
const CHECK_DELAY_MS = 1200;
const textareaCls =
  "min-h-36 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed outline-none focus:border-text-dim";
const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * Write's **+ New** (owner, 2026-09-24: "nella tab writing mi metti un plus
 * che mi permette di aggiungere del testo in modo manuale su cui poi claude
 * crea?"): the owner's own text — notes, an idea, a draft — becomes a post.
 * POST /api/ideas saves it as a manual note (a note is never shown in Find
 * Ideas), then POST /api/drafts/from-idea asks for three takes with the
 * optional angle; the route flags a manual note `ownText`, so Claude writes
 * it as the owner's own post rather than a reaction to someone else's.
 * `onCreated` hands the new idea to the page, which opens it — the takes
 * row shows Claude's progress from there.
 *
 * A pasted text gets its AI slop score at once, typing it after a pause
 * (owner, 2026-09-27: "se incollo del testo dovrebbe analizzarmelo subito e
 * dirmi se è slop e quanto… di base voglio che AI slop venga messo qui"): the
 * AI slop tab's check, which this replaces. Takes stay one button away.
 */
export function NewPostComposer({ onCreated, onCancel, autoFocus = false }: {
  onCreated: (ideaId: string) => void;
  /** Absent when the composer is the page's empty state. */
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [angle, setAngle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SlopResult | null>(null);
  const [checking, setChecking] = useState(false);
  // The next change is a paste: check it at once.
  const pasted = useRef(false);
  // Only the latest check's answer counts.
  const seq = useRef(0);

  useEffect(() => {
    const sample = text.trim().slice(0, CHECK_MAX_CHARS);
    const id = ++seq.current;
    if (sample.length < CHECK_MIN_CHARS) return;
    const now = pasted.current;
    pasted.current = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch("/api/slop-check", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: sample }) });
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (id === seq.current) setCheck(body?.slop ?? null);
      } catch (e) {
        console.error("the AI slop check failed:", e);
      } finally {
        if (id === seq.current) setChecking(false);
      }
    }, now ? 0 : CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  async function submit() {
    const source = text.trim();
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await fetch("/api/ideas", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ text: source }) });
      if (!saved.ok) {
        setError(await errorOf(saved, "Couldn't save your text. Try again."));
        return;
      }
      const { idea } = await saved.json();
      const started = await fetch("/api/drafts/from-idea", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ideaId: idea.id, count: 3, instructions: angle.trim() }),
      });
      if (!started.ok) {
        setError(await errorOf(started, "Your text is saved, but PostEcho couldn't start writing. Try again."));
        return;
      }
      onCreated(idea.id);
    } catch (e) {
      console.error("failed to start a post from text:", e);
      setError("Network error: nothing was sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="New post from your text" className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">New post from your text</h2>
          <p className="text-xs text-text-dim">Paste a text and you&apos;ll see right away how human it reads.</p>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-xs text-text-dim hover:text-text">
            Cancel
          </button>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); if (e.target.value.trim().length < CHECK_MIN_CHARS) setCheck(null); }}
        onPaste={() => { pasted.current = true; }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        maxLength={MAX_CHARS}
        autoFocus={autoFocus}
        placeholder="Paste or write what PostEcho should turn into posts: notes, an idea, a draft, something you learned…"
        aria-label="Your text"
        className={textareaCls}
      />
      <input
        value={angle}
        onChange={(e) => setAngle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        maxLength={500}
        placeholder="Angle or instructions, optional: funnier, in Italian, for founders…"
        aria-label="Angle or instructions (optional)"
        className={inputCls}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs tabular-nums text-text-dim">
          {text.length}/{MAX_CHARS}
          {checking && !check && <span className="animate-pulse">Checking how human it reads…</span>}
          <SlopBadge slop={check} />
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          {busy ? "Starting…" : "Write takes"}
        </button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
