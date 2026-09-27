"use client";

import { useState } from "react";
import type { GuideStep } from "@/lib/connection-guides";

/** A command to paste, with Copy. */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch { /* the text is right there to select */ }
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-text">{code}</pre>
      <button type="button" onClick={() => void copy()} className="shrink-0 text-xs text-text-dim underline hover:text-text">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** A connection's steps, numbered, each with its link and the command to paste (2026-09-26: "tutto spiegato step by step"). */
export function GuideSteps({ steps }: { steps: GuideStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs text-text-dim">{i + 1}</span>
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block">
              {step.text}
              {step.link && (
                <>
                  {" "}
                  <a href={step.link.href} target="_blank" rel="noopener noreferrer" className="text-text-dim underline hover:text-text">
                    {step.link.label} ↗
                  </a>
                </>
              )}
            </span>
            {step.code && <CopyCode code={step.code} />}
          </span>
        </li>
      ))}
    </ol>
  );
}
