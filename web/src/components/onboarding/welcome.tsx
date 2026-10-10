"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { ClaudeConnectDialog } from "@/components/connections/claude-connect";
import { KeyConnectDialog, statusLine, type ConnectionStatus } from "@/components/connections/key-connect";
import { KEY_GUIDES, type KeyGuide } from "@/lib/connection-guides";
import type { SetupStatus } from "@/lib/setup";
import { getFirstSearch, runFirstSearch, subscribeFirstSearch } from "./first-search";

/**
 * The welcome, on first entry (owner, 2026-09-22 idea, built 2026-09-26;
 * redone 2026-09-27 after "l'onboarding a te sembra chiaro? mmm a me non
 * molto", on this plan: say what PostEcho does, connect only what it needs,
 * end on the first results). Three steps in a window over the app:
 *
 * 1. What PostEcho does, in a sentence and the Find → Write → Plan loop.
 * 2. Connect: Claude on the Mac and Jev, in plain words, each with its
 *    step-by-step window; the optional sources folded away. Skipped when both
 *    are connected.
 * 3. The first search: "YC interesting posts" already written. Find ideas
 *    saves it and starts the search, which runs on while the owner reads:
 * 4. Write and 5. Calendar, a page each (2026-09-27: "un onboarding non debba
 *    chiudersi su find ideas ma mostrare due altre pagine una per write e una
 *    per calendar e poi finito quello si vede la prima search").
 * "See your ideas" closes it on Find Ideas, whose banner follows the search
 * (first-search.ts): what it found, how to go on, and which sources would
 * find more.
 *
 * Finishing or closing it records `onboardedAt` (POST /api/setup); Settings ›
 * Profile opens it again.
 */

/** Fired on window to open the welcome again (Settings › Profile). */
export const SHOW_WELCOME_EVENT = "postecho:show-welcome";
const TOPIC_MAX_CHARS = 80;
/** The first search when nothing is saved yet (owner, 2026-09-26: "come prima ricerca dell'onboarding metti 'YC interesting posts'"). */
export const STARTER_TOPIC = "YC interesting posts";

/**
 * What the topic field starts with: the first saved topic, or the starter
 * search — already written in the field (2026-09-26: "voglio che YC
 * interesting posts sia già prescritto, add non serve").
 */
export function initialTopic(saved: string[]): string {
  return saved.map((t) => t.trim()).find(Boolean)?.slice(0, TOPIC_MAX_CHARS) ?? STARTER_TOPIC;
}

/** The field's text as a topic: trimmed, single spaces, at most 80 characters; null when empty. */
export function topicOf(input: string): string | null {
  const topic = input.trim().replace(/\s+/g, " ").slice(0, TOPIC_MAX_CHARS);
  return topic || null;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text disabled:opacity-50";
const smallPillCls = "shrink-0 rounded-full border border-border px-3 py-1 text-xs text-text-dim hover:text-text";
const primaryPillCls = "rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

export type WelcomeStep = "intro" | "connect" | "search" | "write" | "calendar";

/** The steps to show: Connect only while Jev or Claude on the Mac is missing. */
export function welcomeSteps(jevConnected: boolean, macOnline: boolean): WelcomeStep[] {
  return jevConnected && macOnline ? ["intro", "search", "write", "calendar"] : ["intro", "connect", "search", "write", "calendar"];
}

type Connections = Partial<Record<"jev" | "bluesky" | "youtube" | "producthunt", ConnectionStatus>>;
/** The sources whose keys PostEcho can take here (X's lives in Settings › Sources, with its budget). */
const SOURCE_GUIDES: Array<KeyGuide["id"]> = ["bluesky", "youtube", "producthunt"];

/** The loop, as the first step draws it. */
const LOOP: Array<[tab: string, what: string]> = [
  ["Create posts", "From your code or the news"],
  ["Write", "Takes in your voice"],
  ["Calendar", "Your posts by date"],
];

/** Step 4: what Write does, with a small picture of it. */
export function WriteStep({ titleId }: { titleId: string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">Write: pick a take, make it yours</h2>
        <p className="text-sm text-text-dim">Press Use on an idea and PostEcho writes three takes in your voice. Pick one, change it by chatting with AI, then Schedule it on X or LinkedIn.</p>
      </div>
      <div aria-hidden className="flex items-center gap-2">
        {[false, true, false].map((picked, i) => (
          <div key={i} className={`flex-1 space-y-1.5 rounded-lg border p-2.5 ${picked ? "border-text-dim bg-surface-2" : "border-border"}`}>
            <div className="h-1.5 w-full rounded-full bg-text-dim/40" />
            <div className="h-1.5 w-4/5 rounded-full bg-text-dim/40" />
            <div className="h-1.5 w-3/5 rounded-full bg-text-dim/40" />
            <p className={`pt-1 text-[10px] ${picked ? "text-text" : "text-text-dim"}`}>{picked ? "Picked" : `Take ${i + 1}`}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Step 5: what Calendar does, with a small week of it. */
export function CalendarStep({ titleId }: { titleId: string }) {
  const week: Array<[day: string, post: "scheduled" | "posted" | null]> = [
    ["Mon", null], ["Tue", "posted"], ["Wed", null], ["Thu", "scheduled"], ["Fri", null], ["Sat", "scheduled"], ["Sun", null],
  ];
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">Calendar: your posts by date</h2>
        <p className="text-sm text-text-dim">Everything you schedule, day by day. Once a post is out, tell PostEcho how it did: it learns what works for you.</p>
      </div>
      <div aria-hidden className="space-y-3">
        <div className="grid grid-cols-7 gap-1.5">
          {week.map(([day, post]) => (
            <div key={day} className="flex flex-col items-center gap-1.5 rounded-lg border border-border py-2">
              <span className="text-[10px] text-text-dim">{day}</span>
              <span className={`h-2 w-2 rounded-full ${post === "posted" ? "bg-ok" : post === "scheduled" ? "border border-accent" : "bg-transparent"}`} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-dim">
          <span>Tuesday&apos;s post is out. How did it do?</span>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-text">👍 Did well</span>
          <span className="rounded-full border border-border px-2.5 py-0.5">👎 Didn&apos;t land</span>
        </div>
      </div>
    </div>
  );
}

/** Step 1: what PostEcho does. */
export function IntroStep({ titleId }: { titleId: string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">Turn what you read into your next post</h2>
        <p className="text-sm text-text-dim">PostEcho finds posts worth reacting to and writes takes in your voice. You schedule the best on X or LinkedIn.</p>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {LOOP.map(([tab, what], i) => (
          <li key={tab} className="rounded-xl border border-border bg-surface-2 px-3 py-3">
            <span className="block text-xs text-text-dim">{i + 1}</span>
            <span className="block text-sm font-medium">{tab}</span>
            <span className="block text-xs text-text-dim">{what}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Dot({ on, needed }: { on: boolean; needed: boolean }) {
  if (on) return <span aria-hidden className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-ok" />;
  if (needed) return <span aria-hidden className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />;
  return <span aria-hidden className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border border-text-dim" />;
}

/** Step 2: the two things PostEcho needs, in plain words; the optional sources folded away. */
export function ConnectStep({ titleId, status, connections, onOpen }: {
  titleId: string;
  status: SetupStatus | null;
  connections: Connections | null;
  /** Opens a service's window: "claude", or a key's guide. */
  onOpen: (what: "claude" | KeyGuide["id"]) => void;
}) {
  const macOnline = Boolean(status?.agent.online);
  const jev = connections?.jev ?? null;
  const missing = !macOnline || !jev?.connected;
  const row = (key: string, title: string, detail: string, on: boolean, needed: boolean, action: { label: string; open: () => void } | null) => (
    <li key={key} aria-label={`${title}: ${on ? "connected" : needed ? "not connected" : "optional, not connected"}`} className="flex items-start gap-3 px-4 py-2.5">
      <Dot on={on} needed={needed} />
      <span className="min-w-0 flex-1 text-sm">
        <span className="block">{title}</span>
        <span className="block text-xs text-text-dim">{detail}</span>
      </span>
      {action && <button type="button" onClick={action.open} className={smallPillCls}>{action.label}</button>}
    </li>
  );
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">Connect two things</h2>
        <p className="text-sm text-text-dim">Each takes a few minutes, and the window walks you through it.</p>
      </div>
      {!status || !connections ? <p className="text-sm text-text-dim">Checking…</p> : (
        <>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface-2">
            {row("claude", "Claude on your Mac", macOnline ? "Your Mac is connected." : "Writes your posts, on your own Claude plan.", macOnline, true,
              { label: macOnline ? "Steps" : "Connect", open: () => onOpen("claude") })}
            {row("jev", "Jev", jev?.connected ? statusLine(jev) : "Ranks what a search finds, and scores how human a post reads.", Boolean(jev?.connected), true,
              { label: jev?.connected ? "Change" : "Connect", open: () => onOpen("jev") })}
          </ul>
          <details className="group rounded-xl border border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm text-text-dim hover:text-text">
              More sources (optional)
              <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="space-y-2 border-t border-border px-4 py-3">
              <p className="text-xs text-text-dim">Ready without any key: {status.keylessSources.join(", ")}. These add more, and they&apos;re free:</p>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface-2">
                {SOURCE_GUIDES.map((id) => {
                  const c = connections[id];
                  return row(id, KEY_GUIDES[id].name, c?.connected ? statusLine(c) : KEY_GUIDES[id].what, Boolean(c?.connected), false,
                    c?.connected ? null : { label: "Connect", open: () => onOpen(id) });
                })}
              </ul>
              <p className="text-xs text-text-dim">X is optional and paid per post it reads: add your key in Settings › Sources.</p>
            </div>
          </details>
          {missing && <p className="text-xs text-text-dim">You can go on and finish this later in Settings › AI tools.</p>}
        </>
      )}
    </div>
  );
}

/** Step 3: the first search, already written. */
export function SearchStep({ titleId, value, onChange, onSubmit, inputRef }: {
  titleId: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter in the field: the same as Find ideas. */
  onSubmit: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">Your first search</h2>
        <p className="text-sm text-text-dim">What do you post about? PostEcho looks across every connected source and brings back the posts worth reacting to.</p>
      </div>
      <input
        ref={inputRef}
        value={value}
        maxLength={TOPIC_MAX_CHARS}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSubmit(); } }}
        placeholder="e.g. indie SaaS, AI agents, product design"
        aria-label="What you post about"
        className={inputCls}
      />
    </div>
  );
}

function Welcome({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Decided once, from the first status: Connect shows only while something PostEcho needs is missing.
  const [steps, setSteps] = useState<WelcomeStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<"claude" | KeyGuide["id"] | null>(null);
  // null until the saved topics arrive, so typing first isn't overwritten.
  const [topic, setTopic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The first search, running while the owner reads Write and Calendar.
  const firstSearch = useSyncExternalStore(subscribeFirstSearch, getFirstSearch, () => null);
  const [searchStarted, setSearchStarted] = useState(false);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [setupRes, connRes] = await Promise.all([fetch("/api/setup"), fetch("/api/connections")]);
        if (!setupRes.ok || !connRes.ok) throw new Error(`setup ${setupRes.status}, connections ${connRes.status}`);
        const loaded = (await setupRes.json()).status as SetupStatus;
        const conns = (await connRes.json()).services as Connections;
        if (cancelled) return;
        setStatus(loaded);
        setConnections(conns);
        setLoadError(null);
        setTopic((current) => current ?? initialTopic(loaded.topics));
        setSteps((current) => current ?? welcomeSteps(Boolean(conns.jev?.connected), loaded.agent.online));
      } catch (e) {
        console.error("welcome: couldn't load what's connected:", e);
        if (cancelled) return;
        setLoadError("Couldn't check what's connected. Try again in a moment.");
        setTopic((current) => current ?? initialTopic([]));
        setSteps((current) => current ?? welcomeSteps(false, false));
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  /** Closed, skipped or done: recorded; once the search has started, the owner lands where it shows up. */
  function finish() {
    onClose();
    void fetch("/api/setup", { method: "POST" }).catch((e) => console.error("welcome: couldn't record it as done:", e));
    if (searchStarted && pathname !== "/") router.push("/");
  }

  /** Find ideas: save the topic, start its search, and read on while it runs. */
  async function findIdeas() {
    const chosen = topicOf(topic ?? "");
    if (!chosen || saving) return;
    setSaving(true);
    try {
      await fetch("/api/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ topics: [chosen] }) });
    } catch (e) {
      console.error("welcome: couldn't save the topic:", e);
    } finally {
      setSaving(false);
    }
    void runFirstSearch(chosen);
    setSearchStarted(true);
    setIndex((i) => i + 1);
  }

  const step = steps?.[index] ?? null;
  const last = steps !== null && index === steps.length - 1;
  // Back stays on this side of the search: Write can't lead back into a second one.
  const canGoBack = index > 0 && step !== "write";

  return (
    <Modal labelledBy={titleId} onRequestClose={finish} initialFocus={inputRef} width="36rem">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between gap-3 text-xs text-text-dim">
          <span className="flex items-center gap-2">
            <span>Welcome to PostEcho</span>
            {steps && <><span aria-hidden>·</span><span>{index + 1} of {steps.length}</span></>}
          </span>
          <button type="button" onClick={finish} className="underline hover:text-text">Skip</button>
        </div>

        {!step && <h2 id={titleId} className="text-lg font-semibold">Welcome to PostEcho</h2>}
        {loadError && <p className="text-sm text-danger">{loadError}</p>}
        {step === "intro" && <IntroStep titleId={titleId} />}
        {step === "connect" && <ConnectStep titleId={titleId} status={status} connections={connections} onOpen={setOpen} />}
        {step === "search" && (
          <SearchStep titleId={titleId} value={topic ?? ""} onChange={setTopic} onSubmit={() => void findIdeas()} inputRef={inputRef} />
        )}
        {step === "write" && <WriteStep titleId={titleId} />}
        {step === "calendar" && <CalendarStep titleId={titleId} />}

        {step && (
          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            {searchStarted && firstSearch && (
              <p role="status" aria-live="polite" className="mr-auto text-xs text-text-dim">
                {firstSearch.status === "searching" ? "Finding your ideas meanwhile…"
                  : firstSearch.status === "done" && firstSearch.found > 0 ? `${firstSearch.found} ideas ready`
                    : "Your search is done"}
              </p>
            )}
            {canGoBack && <button type="button" onClick={() => setIndex(index - 1)} className={pillCls}>Back</button>}
            {step === "search" ? (
              <button type="button" onClick={() => void findIdeas()} disabled={saving || !topicOf(topic ?? "")} className={primaryPillCls}>
                {saving ? "Saving…" : "Find ideas"}
              </button>
            ) : last ? (
              <button type="button" onClick={finish} className={primaryPillCls}>See your ideas</button>
            ) : (
              <button type="button" onClick={() => setIndex(index + 1)} className={primaryPillCls}>Next</button>
            )}
          </div>
        )}
      </div>

      {open === "claude" && <ClaudeConnectDialog onClose={() => { setOpen(null); setRefreshKey((k) => k + 1); }} />}
      {open && open !== "claude" && (
        <KeyConnectDialog
          guide={KEY_GUIDES[open]}
          status={connections?.[open] ?? null}
          onChanged={() => setRefreshKey((k) => k + 1)}
          onClose={() => { setOpen(null); setRefreshKey((k) => k + 1); }}
        />
      )}
    </Modal>
  );
}

/**
 * Where the welcome lives (the authed layout): open on start after the first
 * login (`openOnStart`, from kv onboardedAt), and again whenever Settings
 * fires SHOW_WELCOME_EVENT.
 */
export function WelcomeHost({ openOnStart }: { openOnStart: boolean }) {
  const [open, setOpen] = useState(openOnStart);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SHOW_WELCOME_EVENT, show);
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, show);
  }, []);
  return open ? <Welcome onClose={() => setOpen(false)} /> : null;
}
