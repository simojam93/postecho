"use client";

import { useEffect, useId, useState } from "react";
import { Modal } from "@/components/modal";
import { agentEnvCommand, claudeSteps } from "@/lib/connection-guides";
import { GuideSteps } from "./guide-steps";

/** How often the window asks whether the Mac has said hello. */
const POLL_MS = 4_000;

/**
 * Claude on your Mac, step by step (2026-09-26: "ogni collegamento anche con
 * AI tools va tutto spiegato step by step"): install Claude Code and log in,
 * get the agent, write its two settings with the command shown here (this
 * site's address and the agent token, on request), then start it. The window
 * turns green by itself when the agent's heartbeat arrives.
 */
export function ClaudeConnectDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const [envCommand, setEnvCommand] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/setup");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setOnline(Boolean(body?.status?.agent?.online));
      } catch { /* the next tick tries again */ }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  async function showCommand() {
    setSetupError(null);
    try {
      const res = await fetch("/api/connections/agent");
      const body = await res.json().catch(() => null);
      if (!res.ok || typeof body?.url !== "string") { setSetupError("Couldn't read this site's setup. Try again."); return; }
      if (!body.token) { setSetupError("This site has no AGENT_TOKEN yet: add one to the server's environment (see web/.env.example)."); return; }
      setEnvCommand(agentEnvCommand(body.url, body.token));
    } catch {
      setSetupError("Network error. Try again.");
    }
  }

  const steps = claudeSteps(envCommand);
  return (
    <Modal labelledBy={titleId} onRequestClose={onClose} width="36rem">
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id={titleId} className="text-base font-semibold">Connect Claude on your Mac</h2>
            <p className="text-xs text-text-dim">Claude writes on your own Mac, on your own Claude plan, through the PostEcho agent.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text">×</button>
        </div>
        <p className={`flex items-center gap-2 text-sm ${online ? "text-ok" : "text-text-dim"}`}>
          <span aria-hidden>{online ? "●" : "○"}</span>
          {online === null ? "Checking…" : online ? "Your Mac is connected." : "Waiting for your Mac…"}
        </p>
        <GuideSteps steps={steps} />
        {!envCommand && (
          <div className="space-y-1">
            <button type="button" onClick={() => void showCommand()} className="rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text">
              Show the command for step 4
            </button>
            <p className="text-xs text-text-dim">It holds your agent token: keep it on your Mac.</p>
            {setupError && <p className="text-sm text-danger">{setupError}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
