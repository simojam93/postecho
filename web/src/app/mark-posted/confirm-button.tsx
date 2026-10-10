"use client";

import { useState } from "react";

/**
 * The one tap that actually records the post — POST /api/mark-posted with
 * the signed id from the email link. Kept separate from the server page so
 * the page itself stays static; no session involved.
 */
export function ConfirmButton({ id, sig }: { id: string; sig: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function confirm() {
    if (state === "busy" || state === "done") return;
    setState("busy");
    try {
      const res = await fetch("/api/mark-posted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sig }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Marked as posted ✓</h1>
        <p className="text-sm text-text-dim">You can close this tab.</p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Did you post it?</h1>
      <p className="text-sm text-text-dim">Confirm and PostEcho records it in Schedule and stops the reminder.</p>
      <button
        type="button"
        onClick={confirm}
        disabled={state === "busy"}
        className="rounded-full bg-accent px-6 py-3 text-sm font-medium text-accent-ink disabled:opacity-50"
      >
        {state === "busy" ? "Saving…" : "Yes, mark as posted"}
      </button>
      {state === "error" && <p className="text-sm text-danger">Could not record it. Open the link from the email again.</p>}
    </>
  );
}
