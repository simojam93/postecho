"use client";

import { useEffect, useRef, useState } from "react";
import { SlopBadge, type SlopResult } from "@/components/slop-badge";
import { humanScore } from "@/lib/human-score";
import { humanizePhaseText, humanizeProgressOf, scoreTrail } from "@/lib/humanize-progress";
import { pollJob, type PolledJob } from "@/lib/poll-job";
import type { Voice } from "@/lib/voice";
import { GenerationProgress } from "./generation-progress";
import { PLATFORM_LABEL, slopFor } from "./post-state";
import type { Draft, JobInfo, Platform } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };
const chipCls = "rounded-full border px-3 py-1 text-xs disabled:opacity-50";
const chipIdle = "border-border text-text-dim hover:text-text";
const chipLit = "border-accent text-text";

type EditMode = "custom" | "humanize" | "sync_linkedin" | "sync_x" | "voice";
/** `humanize`: the one platform a Humanize rewrites (owner, 2026-09-24: "per X o per LinkedIn singolo… magari uno dei due è già a posto"). */
export type EditRequest = { mode: EditMode; instruction: string; label: string; voice?: Voice; humanize?: Platform };

/** Write's "+ Create a LinkedIn post" (2026-09-24: LinkedIn is optional, written on request from the X and the source). */
export const CREATE_LINKEDIN: EditRequest = {
  mode: "sync_linkedin",
  label: "Create a LinkedIn post",
  instruction: "Write the LinkedIn version of this post from the X one, with the source for the detail X has no room for.",
};

export type EditRequests = ReturnType<typeof useEditRequests>;

/**
 * The requests behind Edit with Claude, shared with the editor (its "+ Create
 * a LinkedIn post" is one of them): save an unsaved edit, POST
 * /api/drafts/:id/revise, poll the job with its live progress, hand over when
 * the new version landed. One request at a time.
 */
export function useEditRequests({ draftId, flush, onDone }: {
  draftId: string;
  /** Saves an unsaved edit first; false when that failed. */
  flush: () => Promise<boolean>;
  /** A reply landed as a new version — the page demotes this one and reloads. */
  onDone: () => Promise<void>;
}) {
  const [job, setJob] = useState<PolledJob | null>(null);
  const [runningMode, setRunningMode] = useState<EditMode | null>(null);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = runningMode !== null;

  async function send(request: EditRequest): Promise<boolean> {
    if (busy) return false;
    setError(null);
    setRunningMode(request.mode);
    setPendingLabel(request.label);
    try {
      if (!(await flush())) {
        setError("Your edit couldn't be saved, so nothing was sent.");
        return false;
      }
      const res = await fetch(`/api/drafts/${draftId}/revise`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          instruction: request.instruction,
          mode: request.mode,
          label: request.label.slice(0, 120),
          ...(request.voice ? { voice: request.voice } : {}),
          ...(request.humanize ? { humanize: request.humanize } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.job?.id !== "string") {
        setError(typeof body?.error === "string" ? body.error : "PostEcho couldn't start. Try again.");
        return false;
      }
      setJob(body.job);
      const done = await pollJob(body.job.id, { onPoll: setJob });
      if (done.status === "failed") {
        setError(errorOfJob(done));
        return false;
      }
      await onDone();
      return true;
    } catch {
      setError("Network error: the request didn't go through.");
      return false;
    } finally {
      setJob(null);
      setRunningMode(null);
      setPendingLabel(null);
    }
  }

  return { send, job, runningMode, pendingLabel, error, busy };
}
type Suggestion = { key: string; request: EditRequest; title: string; lit: boolean };

/** One of Humanize's choices: in the menu it reads `choice` (X, LinkedIn, Both), next to that text's score. */
export type HumanizeChoice = Suggestion & { choice: string; platform: Platform | null };

/**
 * Humanize's choices (owner, 2026-09-25: "fammelo con dropdown se ho entrambi
 * i post e devo poter scegliere o X o LinkedIn o both. Se ho solo X invece
 * lascia Humanize X"). One per platform the post has, plus Both when it has
 * two — the Claude <-> Jev loop on each platform in turn. Each is lit as soon
 * as its text isn't "Human" (below 7/10); Both when either isn't.
 */
export function humanizeChoices(present: Platform[], scores: Record<Platform, SlopResult | null>): HumanizeChoice[] {
  const notHuman = (p: Platform) => scores[p] !== null && humanScore(scores[p]!.slopScore) < 7;
  const one = present.map((p): HumanizeChoice => ({
    key: `humanize-${p}`,
    choice: PLATFORM_LABEL[p],
    platform: p,
    request: {
      mode: "humanize",
      humanize: p,
      label: `Humanize ${PLATFORM_LABEL[p]}`,
      instruction: `Make the ${PLATFORM_LABEL[p]} version read like a person wrote it.`,
    },
    title: present.length > 1
      ? `Rewrite the ${PLATFORM_LABEL[p]} text until it reads human`
      : "Rewrite it until it reads human",
    lit: notHuman(p),
  }));
  if (present.length < 2) return one;
  return [...one, {
    key: "humanize-both",
    choice: "Both",
    platform: null,
    request: { mode: "humanize", label: "Humanize both", instruction: "Make both versions read like a person wrote them." },
    title: "Rewrite X, then LinkedIn, until each reads human",
    lit: present.some(notHuman),
  }];
}

/** A small menu's open state, closed by a click outside or Esc. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Humanize ▾ for a post with both platforms: X, LinkedIn or Both, each with its score. Closes on a pick, a click outside or Esc. */
function HumanizeMenu({ choices, scores, busy, onPick }: {
  choices: HumanizeChoice[];
  scores: Record<Platform, SlopResult | null>;
  busy: boolean;
  onPick: (request: EditRequest) => void;
}) {
  const { open, setOpen, ref } = useMenu();
  const lit = choices.some((c) => c.lit);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Rewrite it until it reads human"
        className={`${chipCls} ${lit ? chipLit : chipIdle}`}
      >
        Humanize ▾
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-10 mt-1 min-w-48 rounded-xl border border-border bg-surface-2 p-1 shadow-lg">
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              role="menuitem"
              data-tip={c.title}
              onClick={() => { setOpen(false); onPick(c.request); }}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface"
            >
              <span className="flex items-center gap-2">
                {/* The dot's room is kept on every row, so the labels line up. */}
                <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${c.lit ? "bg-accent" : "bg-transparent"}`} />
                {c.choice}
              </span>
              {c.platform && <SlopBadge slop={scores[c.platform]} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The voice switches (owner, 2026-09-24: "write in 1st or 3rd person"): a rewrite in that voice, which the post then keeps. */
export const VOICE_REQUESTS: Record<Voice, EditRequest> = {
  mine: { mode: "voice", voice: "mine", label: "Write as mine", instruction: "Rewrite it in the first person, as the owner's own post." },
  reaction: { mode: "voice", voice: "reaction", label: "Write as a reaction", instruction: "Rewrite it as the owner's reaction to the source." },
};

/** Keeping LinkedIn in step with X, and writing X from LinkedIn: the editor's platform tabs offer them where they apply. */
export const UPDATE_LINKEDIN: EditRequest = { mode: "sync_linkedin", label: "Update LinkedIn from X", instruction: "Rewrite the LinkedIn version from the X one." };
export const WRITE_X: EditRequest = { mode: "sync_x", label: "Write X from LinkedIn", instruction: "Write the X version from the LinkedIn one." };

/**
 * Voice ▾, a small menu at the bar's right (2026-09-27): not a one-off edit
 * but the post's voice, which New takes and every later edit follow. Picking
 * the other one rewrites the post in it.
 */
function VoiceMenu({ voice, busy, onPick }: { voice: Voice; busy: boolean; onPick: (request: EditRequest) => void }) {
  const { open, setOpen, ref } = useMenu();
  const options: Array<[Voice, string]> = [["mine", "Yours, first person"], ["reaction", "A reaction to the source"]];
  return (
    <div ref={ref} className="relative ml-auto">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={busy} aria-haspopup="menu" aria-expanded={open}
        data-tip="The post's voice: yours, or a reaction to the source"
        className="text-xs text-text-dim hover:text-text disabled:opacity-50">
        Voice: {voice === "mine" ? "yours" : "reaction"} ▾
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-10 mt-1 min-w-52 rounded-xl border border-border bg-surface-2 p-1 shadow-lg">
          {options.map(([option, label]) => (
            <button key={option} type="button" role="menuitemradio" aria-checked={option === voice}
              onClick={() => { setOpen(false); if (option !== voice) onPick(VOICE_REQUESTS[option]); }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface">
              <span aria-hidden className="w-3">{option === voice ? "✓" : ""}</span>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How long each kind of request usually takes on the Mac (measured live, 2026-09-24: edits 80-95 s with the source in the prompt). */
const TYPICAL: Record<EditMode, string> = {
  humanize: "up to 3 rounds per platform, about 20–60 s each",
  custom: "usually 1–2 min",
  sync_linkedin: "usually 1–2 min",
  sync_x: "usually 1–2 min",
  voice: "usually 1–2 min",
};

function jobInfoOf(job: PolledJob): JobInfo {
  return {
    id: job.id,
    kind: typeof job.kind === "string" ? job.kind : "revise_draft",
    status: job.status,
    result: job.result,
    createdAt: typeof job.createdAt === "string" ? job.createdAt : null,
  };
}

function errorOfJob(job: PolledJob): string {
  const error = job.result?.error;
  return typeof error === "string" && error.trim() ? error : "PostEcho couldn't finish that. Try again.";
}

function PenIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 text-text-dim" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.3 12.8 2.2 13.8l1-3.1z" />
      <path d="M10 3.5l2.5 2.5" />
    </svg>
  );
}

/**
 * Edit with AI (M3.7 — owner, 2026-09-24: "una mini chat con la preview
 * copy che ti propone le cose dei tasti"; made quieter on 2026-09-27, "lo
 * vedo in casinato"): one conversation per post. The owner types what to
 * change (the field's own text gives examples: shorter, a stronger hook…),
 * or presses **Humanize** (the Claude <-> Jev loop, lit as soon as a text
 * scores below Human 7/10: "Humanize X" for a one-platform post, a menu of X,
 * LinkedIn and Both when it has both — humanizeChoices); every reply is a new
 * version of the post (a revise_draft job, lib/materialize.ts) with Jev's
 * human score per platform it changed, and any earlier version is one
 * Restore away. **Voice ▾** switches the post's voice. Keeping LinkedIn in
 * step with X lives in the editor's LinkedIn tab (post-editor.tsx).
 */
export function EditChat({ draft, chain, voice, xText, linkedinText, scores, chat, onRestore }: {
  /** The version on screen (the chosen take). */
  draft: Draft;
  /** Its version chain, v1 first (post-state.ts's versionChain) — the thread. */
  chain: Draft[];
  voice: Voice;
  /** The editor's live texts. */
  xText: string;
  linkedinText: string;
  /** The editor's current human scores. */
  scores: Record<Platform, SlopResult | null>;
  /** The request runner (useEditRequests), shared with the editor. */
  chat: EditRequests;
  /** Restore an earlier version. */
  onRestore: (id: string) => void;
}) {
  const [message, setMessage] = useState("");
  const { job, runningMode, pendingLabel, error, busy } = chat;
  const hasX = xText.trim().length > 0;
  const hasLinkedin = linkedinText.trim().length > 0;
  // Humanize: one button for a one-platform post ("Humanize X"); a menu of X,
  // LinkedIn and Both when the post has both (humanizeChoices).
  const present = (["x", "linkedin"] as const).filter((p) => (p === "x" ? hasX : hasLinkedin));
  const humanize = humanizeChoices([...present], scores);
  const menu = humanize.length > 1;

  async function send(request: EditRequest) {
    if (await chat.send(request) && request.mode === "custom") setMessage("");
  }

  function sendMessage() {
    const text = message.trim();
    if (!text) return;
    void send({ mode: "custom", instruction: text, label: text });
  }

  const progress = job ? humanizeProgressOf(job) : null;
  const trail = progress ? scoreTrail(progress.rounds) : "";

  return (
    <section aria-label="Edit with AI" className="space-y-3">
      <ol className="space-y-3">
        {chain.map((version, i) => {
          if (i === 0) return null;
          const previous = chain[i - 1]!;
          const changed = (["x", "linkedin"] as const).filter((p) =>
            (p === "x" ? version.xText : version.linkedinText) !== (p === "x" ? previous.xText : previous.linkedinText));
          const request = typeof version.meta.instruction === "string" ? version.meta.instruction : "Edited";
          const current = version.id === draft.id;
          return (
            <li key={version.id} className="space-y-1.5">
              <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-surface-2 px-3 py-2 text-sm">
                {request}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
                <span>AI · v{i + 1}</span>
                {changed.length > 0 && <span>· changed {changed.map((p) => PLATFORM_LABEL[p]).join(" and ")}</span>}
                {changed.map((p) => {
                  const slop = slopFor(version, p);
                  return slop ? (
                    <span key={p} className="inline-flex items-center gap-1">
                      <span>{PLATFORM_LABEL[p]}</span>
                      <SlopBadge slop={slop} />
                    </span>
                  ) : null;
                })}
                {current
                  ? <span className="rounded-full border border-border px-2 py-0.5">current</span>
                  : (
                    <button type="button" onClick={() => onRestore(version.id)} disabled={busy} className="underline hover:text-text disabled:opacity-50">
                      Restore v{i + 1}
                    </button>
                  )}
              </div>
            </li>
          );
        })}

        {busy && (
          <li className="space-y-1.5">
            {pendingLabel && (
              <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-surface-2 px-3 py-2 text-sm">
                {pendingLabel}
              </p>
            )}
            {job ? (
              <div className="rounded-xl border border-border bg-surface p-3">
                <GenerationProgress job={jobInfoOf(job)} phase={humanizePhaseText(job, "the post")} typical={TYPICAL[runningMode!]} />
                {trail && <p className="mt-1 text-xs tabular-nums text-text-dim">Human {trail} /10</p>}
              </div>
            ) : (
              <p role="status" className="text-xs text-text-dim">Sending…</p>
            )}
          </li>
        )}
      </ol>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {menu
          ? <HumanizeMenu choices={humanize} scores={scores} busy={busy} onPick={(request) => void send(request)} />
          : humanize.map((h) => (
            // Just "Humanize": the platform is the post's only one (2026-09-27: "toglierei la X… è scontato").
            <button key={h.key} type="button" onClick={() => void send(h.request)} disabled={busy} data-tip={h.title}
              className={`${chipCls} ${h.lit ? chipLit : chipIdle}`}>
              Humanize
            </button>
          ))}
        <VoiceMenu voice={voice} busy={busy} onPick={(request) => void send(request)} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
        className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1 focus-within:border-text-dim"
      >
        <PenIcon />
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          disabled={busy}
          placeholder="Tell the AI what to change: shorter, a stronger hook, more personal…"
          aria-label="Tell the AI what to change"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !message.trim()}
          className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
