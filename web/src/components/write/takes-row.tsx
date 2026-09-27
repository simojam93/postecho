"use client";

import { useState } from "react";
import { ClampedText } from "@/components/clamped-text";
import { SlopBadge } from "@/components/slop-badge";
import { GenerationProgress } from "./generation-progress";
import { LinkedHandles } from "./tag-tools";
import type { Draft, Identity, JobInfo } from "./types";
import { isInFlight, jobError, looksLikeTranscriptError, PLATFORM_LABEL, slopCheckTarget, slopFor, slopOf } from "./post-state";

const X_LIMIT = 280;

/**
 * The takes Claude proposed for the post (M2.5 plan, task W3): compact
 * X-style preview cards side by side — horizontal scroll on a phone — each
 * with **Pick this**; the chosen (kept) one is highlighted. Also owns the
 * generation states around them: the progress block (generation-progress.tsx
 * — phase, elapsed, agent-offline hint) while the idea's latest job is in
 * flight, the failed job's error with **Try again** (and the
 * paste-a-transcript retry for a video), and the **New takes** pill (at
 * most three takes, the most human — lib/takes.ts, via post-state.ts's
 * takesOf, so the cards come best first). Each
 * card carries its AI-style badge (M3.5, task U2) read from the draft's
 * persisted `meta.slop`, with a "Checking AI-style…" hint on the take the
 * page is scoring right now (use-slop-queue.ts). The page does the fetching
 * and polling; this component only renders what it's given and reports
 * clicks upward.
 */
export function TakesRow({
  takes, chosenId, identity, job, transcriptFallback, pickBusy, moreBusy, moreDisabled, checkingId,
  onPick, onMoreTakes, onSubmitTranscript,
}: {
  takes: Draft[];
  chosenId: string | null;
  identity: Identity | null;
  /** The idea's latest generation job (GET /api/jobs?ideaId=), for the progress/failed states. */
  job: JobInfo | null;
  /** A failed job can be retried with a pasted transcript — a youtube idea with a url. */
  transcriptFallback: boolean;
  /** A pick is being saved — Pick this buttons are disabled meanwhile. */
  pickBusy: boolean;
  /** The New takes / Try again request itself is in flight. */
  moreBusy: boolean;
  /** New takes has nothing to ask for (the idea couldn't be loaded). */
  moreDisabled: boolean;
  /** The take whose AI-style check is in flight, if any. */
  checkingId: string | null;
  onPick: (id: string) => void;
  /**
   * A fresh generation job for this idea — New takes, and also **Try again**
   * under a failed job: both are the same re-enqueue (POST /api/drafts/from-idea
   * with count 3, or POST /api/videos for a video — see moreTakes in
   * app/(authed)/create/page.tsx), after which the page polls again.
   */
  onMoreTakes: () => void;
  /** Re-POSTs /api/videos with the pasted transcript; rejects with a message on failure. */
  onSubmitTranscript: (transcript: string) => Promise<void>;
}) {
  const writing = isInFlight(job?.status);
  const failed = job?.status === "failed";
  const error = jobError(job);

  return (
    <section aria-label="Takes" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-text-dim">
          Takes{takes.length > 0 && <span> · {takes.length}</span>}
        </h2>
        <button
          type="button"
          onClick={onMoreTakes}
          disabled={moreBusy || moreDisabled || writing}
          data-tip="Write new takes and keep the three most human"
          className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text disabled:opacity-50"
        >
          {moreBusy ? "Asking…" : writing ? "Writing…" : "New takes"}
        </button>
      </div>

      {takes.length === 0 && !writing && !failed && (
        <p className="text-sm text-text-dim">No takes yet — press New takes.</p>
      )}

      {/* The steps first, then the cards on their way, as a search shows them (2026-09-27). */}
      {writing && job && <GenerationProgress job={job} />}

      {(takes.length > 0 || writing) && (
        // A grid that always fits the space, three across when there's room, never a sideways scroll
        // (owner, 2026-09-27: "le tre card in write non devono avere una barra di scroll orizzontale").
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {takes.map((take, i) => (
            <TakeCard
              key={take.id}
              take={take}
              index={i + 1}
              chosen={take.id === chosenId}
              identity={identity}
              disabled={pickBusy}
              checking={take.id === checkingId}
              onPick={() => onPick(take.id)}
            />
          ))}
          {writing && [0, 1, 2].map((i) => (
            <div key={i} aria-hidden className="h-44 animate-pulse rounded-xl border border-border bg-surface" />
          ))}
        </div>
      )}

      {failed && (
        <div className="space-y-2">
          <p className="text-sm text-danger">{error ?? "Generation failed."}</p>
          <button
            type="button"
            onClick={onMoreTakes}
            disabled={moreBusy || moreDisabled}
            className="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-50"
          >
            {moreBusy ? "Asking…" : "Try again"}
          </button>
          {transcriptFallback && looksLikeTranscriptError(error) && (
            <TranscriptForm onSubmit={onSubmitTranscript} />
          )}
        </div>
      )}
    </section>
  );
}

function TakeCard({ take, index, chosen, identity, disabled, checking, onPick }: {
  take: Draft;
  index: number;
  chosen: boolean;
  identity: Identity | null;
  disabled: boolean;
  /** This take's AI-style check is in flight. */
  checking: boolean;
  onPick: () => void;
}) {
  const text = take.xText ?? take.linkedinText ?? "";
  const xLength = take.xText?.length ?? null;
  const overLimit = xLength !== null && xLength > X_LIMIT;
  const name = identity?.name.trim() || "You";
  const handle = identity?.handle.trim() ? `@${identity.handle.trim().replace(/^@/, "")}` : null;
  // The persisted result, whatever it was scored for; when that isn't the
  // text this card previews (the editor's manual Slop check on the other
  // platform), the badge says which.
  // The score of the text this card previews; else whatever single score the take has, labelled with its platform.
  const previewPlatform = slopCheckTarget(take)?.platform ?? null;
  const own = previewPlatform ? slopFor(take, previewPlatform) : null;
  const fallback = own ? null : slopOf(take);
  const slop = own ?? fallback;
  const scoredOther = fallback && fallback.platform !== previewPlatform && (fallback.platform === "x" || fallback.platform === "linkedin")
    ? PLATFORM_LABEL[fallback.platform]
    : null;

  return (
    <article
      aria-label={`Take ${index}${chosen ? " (chosen)" : ""}`}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border p-4 ${
        chosen ? "border-accent bg-surface-2" : "border-border bg-surface"
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <Avatar url={identity?.avatarUrl.trim() || null} name={name} />
        <div className="min-w-0 leading-tight">
          <div className="truncate font-bold">{name}</div>
          {handle && <div className="truncate text-xs text-text-dim">{handle}</div>}
        </div>
        <span className="ml-auto shrink-0 text-xs text-text-dim">Take {index}</span>
      </div>

      {/* An X post is short enough to read whole, always (owner, 2026-09-25: "la
          regola è dentro i 280 caratteri e che lo possa leggere tutto, i tre
          pallini proprio non li capisco"); a LinkedIn-only take is clamped, with more. */}
      {text && previewPlatform === "x" ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed"><LinkedHandles text={text} /></p>
      ) : text ? (
        <ClampedText lines={8} text={text} className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          <LinkedHandles text={text} />
        </ClampedText>
      ) : (
        <p className="text-sm text-text-dim">(empty)</p>
      )}

      {(slop || checking) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
          {slop ? (
            <>
              {scoredOther && <span>{scoredOther}</span>}
              <SlopBadge slop={slop} />
            </>
          ) : (
            <span role="status" aria-live="polite" className="animate-pulse">Checking AI-style…</span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-text-dim">
        <div className="flex min-w-0 items-center gap-2">
          {xLength !== null && <span className={overLimit ? "text-danger" : ""}>{xLength}/{X_LIMIT}</span>}
          {take.parentId && <span>edited</span>}
          {take.favorite && <span className="text-text">★</span>}
        </div>
        {chosen ? (
          <span className="shrink-0 rounded-full border border-accent px-3 py-1 text-xs font-medium text-text">Chosen</span>
        ) : (
          <button
            type="button"
            onClick={onPick}
            disabled={disabled}
            data-tip="Work on this take"
            className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-ink disabled:opacity-50"
          >
            Pick this
          </button>
        )}
      </div>
    </article>
  );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    // Plain <img>, not next/image: the avatar comes from whatever host the
    // owner pasted in Settings, so there's no remotePatterns allowlist to
    // configure (same reasoning as idea-card.tsx's thumbnails).
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-text-dim">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The manual-transcript fallback (M2 plan, task A9) moved here from the
 * Videos card: shown under a failed generate_from_video job whose error
 * mentions the transcript. Submitting re-POSTs /api/videos with the pasted
 * text (via the page's onSubmitTranscript), which enqueues a fresh job the
 * page then polls like any other.
 */
function TranscriptForm({ onSubmit }: { onSubmit: (transcript: string) => Promise<void> }) {
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const pasted = transcript.trim();
    if (busy || !pasted) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pasted);
      setTranscript("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to submit the transcript.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="Paste the transcript…"
        rows={4}
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        disabled={busy || !transcript.trim()}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit transcript"}
      </button>
    </form>
  );
}
