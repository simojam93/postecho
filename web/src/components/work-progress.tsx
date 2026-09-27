"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { ProgressBar } from "@/components/progress-bar";
import { formatElapsed } from "@/components/write/post-state";

/** One step of a piece of work: done, or the one under way (always the last). */
export type WorkStep = { label: string; done: boolean };

// A once-a-second clock as an external store (the codebase's pattern for
// browser-only facts): React subscribes while the block is shown, render stays
// pure, and whole seconds keep two snapshot reads in agreement.
function subscribeEverySecond(onTick: () => void): () => void {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const noClockOnServer = () => null;

// The step under way, the way Claude shows it's working (owner, 2026-09-27: "in stile come fa
// claude qui quando pensa e lavora"): a glyph that turns through · ✢ ✳ ✶ ✻ ✽ and back, and a light
// that sweeps across the words. Keyframes hoisted and deduped by React 19, like the bar's.
const WORKING_CSS =
  "@keyframes postecho-turn{to{transform:translateY(-200px)}}" +
  "@keyframes postecho-shimmer{from{background-position:150% 0}to{background-position:-50% 0}}";
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const SHIMMER_CLS =
  "bg-[linear-gradient(90deg,var(--color-text-dim)_35%,var(--color-text)_50%,var(--color-text-dim)_65%)] bg-[length:200%_100%] " +
  "bg-clip-text text-transparent animate-[postecho-shimmer_2.2s_linear_infinite] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-text";

/** The keyframes the turning glyph and the shimmer need: render it wherever they show (React keeps one copy). */
export function WorkingStyle() {
  return <style href="postecho-working" precedence="default">{WORKING_CSS}</style>;
}

/** The turning glyph: ten 20px lines, one showing at a time. */
export function Turning() {
  return (
    <span aria-hidden="true" className="inline-block h-5 w-3 shrink-0 overflow-hidden text-center leading-5 text-accent">
      <span className="block animate-[postecho-turn_1.2s_steps(10)_infinite] motion-reduce:animate-none">
        {GLYPHS.map((glyph, i) => <span key={i} className="block h-5">{glyph}</span>)}
      </span>
    </span>
  );
}

/**
 * Work that takes a while, said as it happens (owner, 2026-09-27: "a destra
 * con i secondi… lo dividerei a step quando questi succedono, così l'utente
 * capisce che le cose stanno succedendo"): the moving bar, the steps so far
 * with the done ones checked, and on the right the time since it began and
 * how long it usually takes. A search, Write's takes and a video's topics
 * use it.
 */
export function WorkProgress({ steps, startedAt, typical, label = "Progress", children }: {
  steps: WorkStep[];
  /** When the work began, epoch ms or an ISO date: the counter on the right. */
  startedAt: number | string | null | undefined;
  typical: string;
  label?: string;
  /** Anything under the steps, like Write's "your Mac looks offline". */
  children?: ReactNode;
}) {
  const nowSec = useSyncExternalStore(subscribeEverySecond, nowSeconds, noClockOnServer);
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt ?? NaN;
  const elapsed = nowSec !== null && Number.isFinite(started) ? formatElapsed(nowSec * 1000 - started) : null;
  const current = steps.findLast((step) => !step.done);
  return (
    <div aria-label={label} className="space-y-2">
      <WorkingStyle />
      <ProgressBar />
      <div className="flex items-start justify-between gap-3 text-sm">
        <ol className="min-w-0 space-y-0.5">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 leading-5">
              {step.done
                ? <span aria-hidden="true" className="w-3 shrink-0 text-center text-text-dim">✓</span>
                : <Turning />}
              <span className={`min-w-0 ${step.done ? "text-text-dim" : SHIMMER_CLS}`}>{step.label}</span>
            </li>
          ))}
        </ol>
        <p className="shrink-0 pt-0.5 text-xs tabular-nums text-text-dim">
          {elapsed !== null && <span className="text-text">{elapsed}</span>}
          {elapsed !== null && " · "}
          {typical}
        </p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{current?.label ?? ""}</p>
      {children}
    </div>
  );
}
