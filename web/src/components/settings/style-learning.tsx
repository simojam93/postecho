"use client";

import { useEffect, useState } from "react";
import { lineDiff } from "@/lib/line-diff";
import type { StyleLearningStatus } from "@/lib/style-learning";

const pillCls = "rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

/** The suggestion as Settings › Voice shows it: the changes and why, the evidence, the new guide line by line, Apply and Dismiss. */
export function StyleSuggestionView({ status, savedGuide, showGuide, busy, error, onToggleGuide, onApply, onDismiss }: {
  status: StyleLearningStatus;
  savedGuide: string;
  showGuide: boolean;
  busy: boolean;
  error: string | null;
  onToggleGuide: () => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const proposal = status.proposal;
  // Nothing to say until there's a suggestion: the Settings tour explains the learning once (2026-09-27).
  if (!proposal) return null;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">Suggested update</h3>
        <p className="mt-0.5 text-xs text-text-dim">
          From {proposal.basedOn > 0 ? `${proposal.basedOn} takes` : "the takes"} you picked and dropped.
        </p>
      </div>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface-2">
        <ul className="space-y-2 px-4 py-3">
          {proposal.changes.map((change, i) => (
            <li key={i}>
              <span className="block text-sm">{change.summary}</span>
              <span className="block text-xs text-text-dim">{change.reason}</span>
            </li>
          ))}
        </ul>
        {proposal.lessons.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-xs font-medium text-text-dim">What your choices show</p>
            <ul className="mt-1 space-y-0.5 text-xs text-text-dim">
              {proposal.lessons.map((lesson, i) => (
                <li key={i}><span aria-hidden="true">{lesson.direction === "more" ? "↑ " : "↓ "}</span>{lesson.text}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="px-4 py-3">
          <button type="button" onClick={onToggleGuide} aria-expanded={showGuide} className="text-xs text-text-dim hover:text-text"
            data-tip="Line by line: what Apply adds and removes">
            {showGuide ? "Hide the new guide" : "See the new guide"}
          </button>
          {showGuide && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 font-sans text-xs leading-relaxed">
              {lineDiff(savedGuide, proposal.guide).map((line, i) => (
                <span key={i} className={`block ${line.kind === "added" ? "bg-ok/10 text-text" : line.kind === "removed" ? "bg-danger/10 text-text-dim line-through" : "text-text-dim"}`}>
                  <span aria-hidden="true" className="inline-block w-4 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
                  {line.text || " "}
                </span>
              ))}
            </pre>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button type="button" onClick={onApply} disabled={busy} className={primaryPillCls} data-tip="Make this your style guide">Apply</button>
          <button type="button" onClick={onDismiss} disabled={busy} className={pillCls} data-tip="Keep your guide as it is">Dismiss</button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    </section>
  );
}

/**
 * Settings › Voice's top: the style guide update PostEcho suggests from the
 * owner's choices (lib/style-learning.ts; owner, 2026-09-27: "Proposes, you
 * approve"), when there is one. Apply makes it the guide at once (saved, not
 * just in the box); either answer stops it waiting.
 */
export function StyleLearning({ savedGuide, guideEdited, onApplied, onSettled }: {
  /** The guide as saved: what the suggestion changes. */
  savedGuide: string;
  /** The guide box has unsaved edits, which Apply would replace. */
  guideEdited: boolean;
  onApplied: (guide: string) => void;
  /** The suggestion stopped waiting (applied or dismissed): the cog's dot can go. */
  onSettled?: () => void;
}) {
  const [status, setStatus] = useState<StyleLearningStatus | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/style-learning").catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      if (!cancelled && body) setStatus(body);
    })();
    return () => { cancelled = true; };
  }, []);

  async function answer(action: "apply" | "dismiss") {
    if (busy || !status?.proposal) return;
    if (action === "apply" && guideEdited && !window.confirm("Your unsaved edits to the guide will be replaced. Apply the suggestion?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/style-learning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 409) {
        setError("Couldn't save that. Try again.");
        return;
      }
      if (action === "apply" && typeof body?.styleGuide === "string") onApplied(body.styleGuide);
      setStatus((current) => current && { ...current, proposal: null, newChoices: 0 });
      onSettled?.();
    } catch {
      setError("Network error: nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  return (
    <StyleSuggestionView status={status} savedGuide={savedGuide} showGuide={showGuide} busy={busy} error={error}
      onToggleGuide={() => setShowGuide((open) => !open)} onApply={() => void answer("apply")} onDismiss={() => void answer("dismiss")} />
  );
}
