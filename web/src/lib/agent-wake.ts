import { JOB_HEADER } from "@/lib/job-header";

/**
 * The page wakes the agent on the owner's computer
 * (docs/specs/2026-10-10-agent-wakes-on-demand-design.md). The agent sends
 * nothing until it hears from here:
 *
 * - `POST /awake` on load, when the page becomes visible again, and every
 *   minute while it is visible;
 * - `POST /wake` after any of the page's own `/api/` requests that made a job
 *   (the route says so in X-PostEcho-Job), found by wrapping window.fetch once.
 *
 * Calls go to http://127.0.0.1:<port>, with no credentials. A failure is
 * silent: it is only remembered, so the "agent looks offline" hint can say to
 * open PostEcho in Chrome on that computer.
 */

export const DEFAULT_AGENT_WAKE_PORT = 47321;
export const AWAKE_EVERY_MS = 60_000;

/** NEXT_PUBLIC_AGENT_WAKE_PORT: a port, or 0 to never call the agent. Anything else is the default. */
export function agentWakePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) return DEFAULT_AGENT_WAKE_PORT;
  const port = Number(value);
  return port <= 65535 ? port : DEFAULT_AGENT_WAKE_PORT;
}

// The last wake call's outcome, for useSyncExternalStore.
let lastFailed = false;
const listeners = new Set<() => void>();

function setFailed(failed: boolean): void {
  if (failed === lastFailed) return;
  lastFailed = failed;
  listeners.forEach((fn) => fn());
}

/** True when the last call to the agent failed (nothing listening, or the browser blocked it). */
export function wakeFailedNow(): boolean {
  return lastFailed;
}

export function subscribeWakeFailed(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The parts of window and document this uses, so the tests can fake them. */
export type WakeWindow = { fetch: typeof fetch; location: { origin: string; href: string } };
export type WakeDocument = {
  readonly visibilityState: string;
  addEventListener: (type: "visibilitychange", fn: () => void) => void;
  removeEventListener: (type: "visibilitychange", fn: () => void) => void;
};

const WRAPPED = Symbol.for("postecho.agentWake");
type Hooked = WakeWindow & { [WRAPPED]?: { original: typeof fetch; onJob: (() => void) | null } };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A same-origin `/api/` response whose route made a job. */
export function madeJob(input: RequestInfo | URL, response: Response, location: WakeWindow["location"]): boolean {
  if (!response.headers.get(JOB_HEADER)) return false;
  const url = new URL(urlOf(input), location.href);
  return url.origin === location.origin && url.pathname.startsWith("/api/");
}

/** Starts the calls; returns what stops them. The fetch wrapper stays, idle, once installed. */
export function startAgentWake({ port, win, doc }: { port: number; win: WakeWindow; doc: WakeDocument }): () => void {
  if (port === 0) return () => {};
  const hooked = win as Hooked;
  if (!hooked[WRAPPED]) {
    const original = win.fetch.bind(win);
    const hook: { original: typeof fetch; onJob: (() => void) | null } = { original, onJob: null };
    hooked[WRAPPED] = hook;
    win.fetch = async (input, init) => {
      const response = await original(input, init);
      try {
        if (hook.onJob && madeJob(input, response, win.location)) hook.onJob();
      } catch {
        // A URL this can't read is not one of ours.
      }
      return response;
    };
  }
  const hook = hooked[WRAPPED]!;

  const call = (path: "/awake" | "/wake") => {
    hook
      .original(`http://127.0.0.1:${port}${path}`, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store" })
      .then((res) => setFailed(!res.ok), () => setFailed(true));
  };
  const wake = () => call("/wake");
  hook.onJob = wake;

  const onVisibility = () => {
    if (doc.visibilityState === "visible") call("/awake");
  };
  const timer = setInterval(onVisibility, AWAKE_EVERY_MS);
  doc.addEventListener("visibilitychange", onVisibility);
  call("/awake");

  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisibility);
    if (hook.onJob === wake) hook.onJob = null;
  };
}
