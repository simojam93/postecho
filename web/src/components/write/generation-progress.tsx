"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsLink } from "@/components/settings/settings-provider";
import { WorkProgress, type WorkStep } from "@/components/work-progress";
import { subscribeWakeFailed, wakeFailedNow } from "@/lib/agent-wake";
import { agentLooksOffline, agentOfflineHint, generationSteps } from "./post-state";
import type { JobInfo } from "./types";

/** How often the agent heartbeat is re-read while the job sits in the queue. */
const HEARTBEAT_REFRESH_MS = 30_000;

// The same once-a-second clock as WorkProgress's, for the "looks offline" check.
function subscribeEverySecond(onTick: () => void): () => void {
  const id = setInterval(onTick, 1000);
  return () => clearInterval(id);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const noClockOnServer = () => null;
const noWakeFailureOnServer = () => false;

/**
 * Progress that doesn't look broken (M3.5 plan, task U2 — owner, first day
 * in production: "una roba per cui Claude fa capire cosa sta facendo e
 * quanto manca… se no sembra rotto"), shown while a job for the post is
 * queued or claimed: WorkProgress with the steps so far (post-state.ts's
 * generationSteps, or the caller's own line: a Humanize round, a chat edit),
 * the time since the job was enqueued and the honest "usually 30–60 s".
 *
 * While the job is still `queued`, GET /api/settings is read on mount and
 * every 30 s: a heartbeat older than 3 minutes (or none at all — see
 * post-state.ts's agentLooksOffline) adds the "Mac agent looks offline" hint
 * with a link to Settings, where the heartbeat age is shown. When the page
 * couldn't reach the agent, the hint also says to open PostEcho in Chrome on
 * that computer.
 */
export function GenerationProgress({ job, phase, steps: ownSteps, typical = "usually 30–60 s" }: {
  job: JobInfo;
  /** The caller's own steps, for a job that isn't a post's takes (From a repo's posts). */
  steps?: WorkStep[];
  /** One line of the caller's instead of the steps — e.g. a Humanize round (M3.6). */
  phase?: string | null;
  /** Overrides the typical duration shown after the elapsed counter. */
  typical?: string;
}) {
  const nowSec = useSyncExternalStore(subscribeEverySecond, nowSeconds, noClockOnServer);
  const queued = job.status === "queued";
  // undefined = not loaded yet; null = the agent never connected.
  const [heartbeatAt, setHeartbeatAt] = useState<string | null | undefined>(undefined);

  // Every setState here happens after an await — the accepted pattern for
  // react-hooks/set-state-in-effect (see app/(authed)/create/page.tsx).
  useEffect(() => {
    if (!queued) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const body = await res.json();
        const hb = body?.settings?.agentLastHeartbeatAt;
        if (!cancelled) setHeartbeatAt(typeof hb === "string" ? hb : null);
      } catch (e) {
        console.error("failed to read the agent heartbeat:", e);
      }
    };
    void load();
    const timer = setInterval(load, HEARTBEAT_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [queued]);

  // The page's last call to the agent failed (lib/agent-wake.ts): the hint says where to open PostEcho.
  const wakeFailed = useSyncExternalStore(subscribeWakeFailed, wakeFailedNow, noWakeFailureOnServer);
  const nowMs = nowSec === null ? null : nowSec * 1000;
  const offline = queued && nowMs !== null && agentLooksOffline(heartbeatAt, nowMs);
  const steps = ownSteps ?? (phase !== undefined ? (phase ? [{ label: phase, done: false }] : []) : generationSteps(job));

  return (
    <WorkProgress steps={steps} startedAt={job.createdAt} typical={typical} label="Generation progress">
      {offline && (
        <p className="text-xs text-text-dim">
          {agentOfflineHint(wakeFailed)}{" "}
          <SettingsLink tab="agent" className="underline hover:text-text">Settings</SettingsLink>
        </p>
      )}
    </WorkProgress>
  );
}
