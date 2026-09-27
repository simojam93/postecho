"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Modal } from "@/components/modal";
import { SHOW_WELCOME_EVENT } from "@/components/onboarding/welcome";
import { FindOrderList, type KindCounts } from "@/components/settings/find-order";
import { ReferencesSection } from "@/components/settings/references-section";
import { StyleInspirationSection } from "@/components/settings/style-inspiration-section";
import { StyleLearning } from "@/components/settings/style-learning";
import { WorkProgress, type WorkStep } from "@/components/work-progress";
import { SourceConnectDialog, type SourceRow } from "@/components/settings/source-connect-dialog";
import { ClaudeConnectDialog } from "@/components/connections/claude-connect";
import { KeyConnectDialog, statusLine, type ConnectionStatus } from "@/components/connections/key-connect";
import { KEY_GUIDES } from "@/lib/connection-guides";
import { signOut } from "@/components/settings/sign-out";
import { type XKeyStatus } from "@/components/settings/x-source-section";
import { normalizeOrder } from "@/lib/find-kinds";
import { X_PRICES_USD, X_SOURCE_NAME } from "@/lib/sources/x";

/**
 * Settings, by category (owner, 2026-09-25: "non una marea di testo uno sotto
 * l'altro ma per categoria… un cog che se lo clicchi ti apre i settings divisi
 * per tab a sinistra e con le cose da fare a destra e con un save settings").
 * Tabs on the left, each tab's settings in grouped rows on the right — label
 * and hint on the left of a row, its control on the right — and one Save
 * settings for everything typed here. Style inspiration, reference material
 * and the X key save on their own, as before. Opened as a window from the cog
 * (settings-provider.tsx) or as the /settings page.
 */

// "sources": what to show first, every source (each connected or not; X with the owner's
// key), then the Advanced numbers;
// "agent": AI tools — who writes (Claude on the Mac; GPT coming soon) and who judges (Jev),
// apart from the sources (owner, 2026-09-25; the name and GPT 2026-09-26).
export type SettingsTab = "profile" | "voice" | "references" | "sources" | "agent";

/** Sent after a save with the saved name, so the account bar at the foot of the sidebar shows it at once. */
export const IDENTITY_CHANGED_EVENT = "postecho:identity-changed";

export type Settings = {
  identityName: string; identityHandle: string; identityAvatarUrl: string;
  topics: string[];
  scoutMinScore: number; scoutResultsTotal: number; scoutCandidatesPerSource: number;
  toneExamplesX: string; toneExamplesLinkedin: string;
  toneForm: Record<string, unknown>; styleGuide: string;
  imageSpecs: string;
  agentLastHeartbeatAt: string | null;
  styleGuideAnalyzedAt: string | null;
  xPostsPerSearch: number;
  disabledSources: string[];
  findOrder: string[];
  /** The Claude model the Mac agent writes with: "sonnet", "opus" or "haiku" (AI tools). */
  claudeModel: string;
};

/** GET /api/settings's `tasteCounts`: computed from the owner's kept/dismissed ideas and Plan's votes (lib/taste.ts). */
type TasteCounts = { kept: number; skipped: number; rated?: number };

// Each tab with the app's tooltip: what it's for, in a sentence (2026-09-27).
export const TABS: Array<{ id: SettingsTab; label: string; title: string; tip: string }> = [
  { id: "profile", label: "Profile", title: "Profile", tip: "Your name and handle on post previews" },
  { id: "voice", label: "Voice", title: "Tone of voice", tip: "Your posts, so PostEcho writes like you" },
  { id: "references", label: "References", title: "Reference material", tip: "Facts about you PostEcho can use" },
  { id: "sources", label: "Sources", title: "Sources", tip: "Where your ideas come from" },
  { id: "agent", label: "AI tools", title: "AI tools", tip: "Who writes your posts and who picks the best" },
];

/** Analyze my posts, step by step: waiting for the Mac, then writing the guide. */
export function analyzeSteps(status: string): WorkStep[] {
  if (status === "queued") return [{ label: "Waiting for your Mac", done: false }];
  return [{ label: "Your Mac picked it up", done: true }, { label: "Writing your style guide", done: false }];
}

/** The agent heartbeats every 60 s; three missed ones and it's presumed off (same rule as Write's progress block). */
const AGENT_ONLINE_MINUTES = 3;

/**
 * Settings › AI tools (owner, 2026-09-26: "Jev… va con sources o ai agents?
 * magari si mette AI tools… se non uso claude ma gpt?"): who writes — Claude on
 * the Mac through the PostEcho agent, GPT marked "Coming soon" ("va solo messo
 * tipo coming soon") — and who judges, Jev on the server.
 */
/** The Claude models the agent can write with (aliases `claude --model` knows). */
const CLAUDE_MODELS: Array<{ id: string; name: string; detail: string }> = [
  { id: "sonnet", name: "Sonnet", detail: "The default: quick, and writes well." },
  { id: "opus", name: "Opus", detail: "Writes best. Slower, and uses more of your plan's limits." },
  { id: "haiku", name: "Haiku", detail: "The fastest." },
];

export function AiTools({ heartbeatAge, jev, claudeModel, onModel, onSetUpClaude, onConnectJev }: {
  heartbeatAge: number | null;
  jev: ConnectionStatus | null;
  claudeModel: string;
  onModel: (model: string) => void;
  onSetUpClaude: () => void;
  onConnectJev: () => void;
}) {
  const online = heartbeatAge !== null && heartbeatAge <= AGENT_ONLINE_MINUTES;
  const model = CLAUDE_MODELS.some((m) => m.id === claudeModel) ? claudeModel : "sonnet";
  return (
    <>
      <Group title="Who writes" hint="A new model is used from the next job.">
        <div className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0">
            <span className="block">Claude</span>
            <span className="block text-xs text-text-dim">
              <span aria-hidden className={online ? "text-ok" : "text-text-dim"}>{online ? "● " : "○ "}</span>
              {heartbeatAge === null ? "Your Mac hasn't connected yet." : online ? `Your Mac is connected · last heartbeat ${heartbeatAge} min ago` : `Your Mac is offline · last heartbeat ${heartbeatAge} min ago`}
            </span>
          </span>
          <button type="button" onClick={onSetUpClaude} className={pillCls}>{online ? "Setup steps" : "Connect your Mac"}</button>
        </div>
        <div role="radiogroup" aria-label="Claude model" className="space-y-2 px-4 py-3 text-sm">
          <span className="block text-xs text-text-dim">Model</span>
          {CLAUDE_MODELS.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-start gap-3">
              <input type="radio" name="claude-model" value={m.id} checked={model === m.id} onChange={() => onModel(m.id)} className="mt-1" />
              <span className="min-w-0">
                <span className="block">{m.name}</span>
                <span className="block text-xs text-text-dim">{m.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0 text-text-dim">
            <span className="block">GPT</span>
            <span className="block text-xs">OpenAI&apos;s Codex on your Mac, on your ChatGPT plan.</span>
          </span>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim">Coming soon</span>
        </div>
      </Group>
      <Group title="Who judges" hint="Jev runs on the server: nothing to install on your Mac.">
        <div className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
          <span className="min-w-0">
            <span className="block">Jev, by TypeSafe</span>
            <span className="block text-xs text-text-dim">Ranks what you find, scores how human a post reads, and picks the best takes.</span>
            <span className={`block text-xs ${jev?.connected ? "text-ok" : jev ? "text-danger" : "text-text-dim"}`}>{jev ? statusLine(jev) : "Checking…"}</span>
          </span>
          <button type="button" onClick={onConnectJev} className={pillCls}>{jev?.connected ? "Change key" : "Connect Jev"}</button>
        </div>
      </Group>
    </>
  );
}

/**
 * What Save settings sends: every field edited in this panel. Server-managed
 * ones stay out — agentLastHeartbeatAt is the agent's, toneForm has no editor
 * here and would be clobbered with the {} it loads as — and so do the ones a
 * source's Connect window saves at once (disabledSources, xPostsPerSearch).
 */
export function settingsPayload(s: Settings) {
  return {
    identityName: s.identityName,
    identityHandle: s.identityHandle,
    identityAvatarUrl: s.identityAvatarUrl,
    scoutMinScore: s.scoutMinScore,
    scoutResultsTotal: s.scoutResultsTotal,
    scoutCandidatesPerSource: s.scoutCandidatesPerSource,
    findOrder: normalizeOrder(s.findOrder),
    claudeModel: s.claudeModel,
    toneExamplesX: s.toneExamplesX,
    toneExamplesLinkedin: s.toneExamplesLinkedin,
    styleGuide: s.styleGuide,
  };
}

const inputCls = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

/** A card of rows under an optional heading (with what to do, right under it), with an optional hint below. */
function Group({ title, intro, hint, children }: { title?: string; intro?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && (
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {intro && <p className="mt-0.5 text-xs text-text-dim">{intro}</p>}
        </div>
      )}
      <div className="divide-y divide-border rounded-xl border border-border bg-surface-2">{children}</div>
      {hint && <p className="text-xs text-text-dim">{hint}</p>}
    </section>
  );
}

/** Label and hint on the left, the control on the right (stacked on a phone). */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-text-dim">{hint}</span>}
      </span>
      <span className="block shrink-0 sm:w-64">{children}</span>
    </label>
  );
}

/** Label above, the control full width: the long texts. */
function StackRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-2 px-4 py-3">
      <span className="block">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-text-dim">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function TabIcon({ id }: { id: SettingsTab }) {
  const paths: Record<SettingsTab, ReactNode> = {
    profile: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.3 2.8-3.5 5-3.5s4.2 1.2 5 3.5" /></>,
    voice: <><path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.3 12.8 2.2 13.8l1-3.1z" /></>,
    references: <><path d="M3 2.5h7l3 3v8H3z" /><path d="M5.5 8h5M5.5 10.5h5" /></>,
    sources: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
    agent: <><rect x="3" y="4" width="10" height="8" rx="2" /><path d="M8 1.8V4M6 8h.01M10 8h.01M1.5 8h1.5M13 8h1.5" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {paths[id]}
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6" /><path d="M10.5 11l3-3-3-3M13.5 8H6" />
    </svg>
  );
}

/** The Settings panel — a window (`mode: "modal"`, with `onClose`) or the /settings page. */
export function SettingsPanel({ mode, initialTab = "profile", onClose, onStyleProposalSettled }: {
  mode: "modal" | "page";
  initialTab?: SettingsTab;
  onClose?: () => void;
  /** Voice's suggested style guide update was applied or dismissed. */
  onStyleProposalSettled?: () => void;
}) {
  const titleId = useId();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [s, setS] = useState<Settings | null>(null);
  /** The payload as last loaded or saved — Save settings lights up once the fields differ from it. */
  const [savedPayload, setSavedPayload] = useState<string | null>(null);
  const [tasteCounts, setTasteCounts] = useState<TasteCounts | null>(null);
  const [kindCounts, setKindCounts] = useState<KindCounts | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  // Where each service's key lives (GET /api/connections): AI tools and the sources' Connect.
  const [connections, setConnections] = useState<Record<string, ConnectionStatus> | null>(null);
  // AI tools' windows: Claude's setup steps, or Jev's key.
  const [aiDialog, setAiDialog] = useState<"claude" | "jev" | null>(null);
  const [sourcesVersion, setSourcesVersion] = useState(0);
  const [xStatus, setXStatus] = useState<XKeyStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read once when the settings load, so render never reads the clock (react-hooks purity).
  const [heartbeatAge, setHeartbeatAge] = useState<number | null>(null);
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  // The analyze_style job while it runs, for its steps.
  const [analyzeJob, setAnalyzeJob] = useState<{ status: string; createdAt: string } | null>(null);
  // The source whose Connect window is open (X's Edit too).
  const [connecting, setConnecting] = useState<SourceRow | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  function applyLoaded(data: { settings: Settings; tasteCounts?: TasteCounts; kindCounts?: KindCounts; x?: XKeyStatus }) {
    setS(data.settings);
    setSavedPayload(JSON.stringify(settingsPayload(data.settings)));
    setTasteCounts(data.tasteCounts ?? null);
    setKindCounts(data.kindCounts ?? null);
    setXStatus(data.x ?? { connected: false, hint: null });
    const hb = data.settings.agentLastHeartbeatAt;
    setHeartbeatAge(hb ? Math.round((Date.now() - new Date(hb).getTime()) / 60000) : null);
  }

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("failed to load settings");
        const data = await res.json();
        if (!cancelled) applyLoaded(data);
      } catch {
        if (!cancelled) setLoadError("Could not load settings — is the database migrated?");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [res, conn] = await Promise.all([fetch("/api/sources").catch(() => null), fetch("/api/connections").catch(() => null)]);
      if (res?.ok) {
        const data = await res.json();
        if (!cancelled) setSources(data.sources);
      }
      if (conn?.ok) {
        const data = await conn.json().catch(() => null);
        if (!cancelled && data?.services) setConnections(data.services);
      }
    })();
    return () => { cancelled = true; };
  }, [sourcesVersion]);

  const dirty = s !== null && savedPayload !== null && JSON.stringify(settingsPayload(s)) !== savedPayload;
  // The guide as saved: what Voice's suggested update changes.
  const savedGuide = useMemo(() => (savedPayload ? String(JSON.parse(savedPayload).styleGuide ?? "") : ""), [savedPayload]);

  /** A suggested update was applied: it's saved already, so the box and the saved copy both take it, and other unsaved edits stay. */
  function guideApplied(guide: string) {
    setS((prev) => (prev ? { ...prev, styleGuide: guide } : prev));
    setSavedPayload((prev) => (prev ? JSON.stringify({ ...JSON.parse(prev), styleGuide: guide }) : prev));
  }

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));
    setSaved(false);
    setError(null);
  }

  async function save() {
    if (busy || !s) return;
    setBusy(true);
    setError(null);
    try {
      const payload = settingsPayload(s);
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        // A field-level message ("fieldName: message") when the API sent one.
        const firstField: string | undefined = d?.fields ? Object.keys(d.fields)[0] : undefined;
        const firstFieldMsg: string | undefined = firstField ? d.fields[firstField]?.[0] : undefined;
        setError(firstField && firstFieldMsg ? `${firstField}: ${firstFieldMsg}` : typeof d?.error === "string" ? d.error : "save failed");
        return;
      }
      setSavedPayload(JSON.stringify(payload));
      setSaved(true);
      window.dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT, { detail: { name: payload.identityName } }));
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  async function reloadSettings() {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error("failed to reload settings");
    applyLoaded(await res.json());
  }

  /** The X key was saved or removed: re-read its status (never the key) and the Sources list. */
  async function reloadXStatus() {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const data = await res.json();
      setXStatus(data.x ?? { connected: false, hint: null });
    }
    setSourcesVersion((v) => v + 1);
  }

  /**
   * Connect or disconnect a source, saved at once: the owner's disconnected
   * list (Settings' disabledSources), plus X's budget from its window.
   * Resolves to an error message, or null.
   */
  async function setSourceOff(name: string, off: boolean, extra: { xPostsPerSearch?: number } = {}): Promise<string | null> {
    if (!s) return "Settings aren't loaded yet.";
    const next = off ? [...new Set([...s.disabledSources, name])] : s.disabledSources.filter((n) => n !== name);
    setSourceError(null);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabledSources: next, ...extra }) });
      if (!res.ok) return "Couldn't save that. Try again.";
      setS((prev) => (prev ? { ...prev, disabledSources: next, ...extra } : prev));
      setSourcesVersion((v) => v + 1);
      return null;
    } catch {
      return "Network error: nothing changed.";
    }
  }

  async function analyzeMyPosts() {
    if (analyzeBusy) return;
    setAnalyzeBusy(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/settings/analyze-style", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setAnalyzeError(typeof body?.error === "string" ? body.error : "failed to start analysis");
        return;
      }
      setAnalyzeJob(body.job);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const poll = await fetch(`/api/jobs?id=${body.job.id}`);
        if (!poll.ok) { setAnalyzeError("failed to check analysis status"); return; }
        const job = (await poll.json()).jobs?.[0];
        if (job) setAnalyzeJob(job);
        if (!job || job.status === "queued" || job.status === "claimed") continue;
        if (job.status === "failed") {
          setAnalyzeError(typeof job.result?.error === "string" ? job.result.error : "analysis failed");
          return;
        }
        await reloadSettings();
        return;
      }
    } catch {
      setAnalyzeError("network error");
    } finally {
      setAnalyzeBusy(false);
      setAnalyzeJob(null);
    }
  }

  /** Settings › Profile: close this window (asking first about unsaved changes) and open the welcome. */
  function showWelcome() {
    if (dirty && !window.confirm("You have unsaved settings. Close without saving?")) return;
    onClose?.();
    window.dispatchEvent(new Event(SHOW_WELCOME_EVENT));
  }

  /** Sign out, at the bottom left (owner, 2026-09-27: "signout mettilo in basso a sx qui"). */
  function requestSignOut() {
    if (busy) return;
    if (dirty && !window.confirm("You have unsaved settings. Sign out without saving?")) return;
    void signOut();
  }

  function requestClose() {
    if (busy || analyzeBusy) return;
    if (dirty && !window.confirm("You have unsaved settings. Close without saving?")) return;
    onClose?.();
  }

  const current = TABS.find((t) => t.id === tab)!;

  function content(settings: Settings): ReactNode {
    switch (tab) {
      case "profile":
        return (
          <>
            <Group title="Identity">
              <Row label="Name"><input className={inputCls} value={settings.identityName} onChange={(e) => set("identityName", e.target.value)} /></Row>
              <Row label="Handle" hint="Your X handle, e.g. @lovera_simone"><input className={inputCls} value={settings.identityHandle} onChange={(e) => set("identityHandle", e.target.value)} /></Row>
              <Row label="Avatar" hint="An image link (optional)"><input className={inputCls} value={settings.identityAvatarUrl} onChange={(e) => set("identityAvatarUrl", e.target.value)} /></Row>
            </Group>
            {/* The welcome again (2026-09-26), and with it every first-time window. */}
            <Group>
              <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0">The welcome tour</span>
                <button type="button" onClick={showWelcome} className={pillCls}>Show it again</button>
              </div>
            </Group>
          </>
        );
      case "voice":
        return (
          <>
            <StyleLearning savedGuide={savedGuide} guideEdited={settings.styleGuide !== savedGuide} onApplied={guideApplied} onSettled={onStyleProposalSettled} />
            <Group title="Your best posts"
              intro="Paste 3 or more posts you wrote, one blank line apart.">
              <StackRow label="On X"><textarea rows={6} className={inputCls} value={settings.toneExamplesX} onChange={(e) => set("toneExamplesX", e.target.value)} /></StackRow>
              <StackRow label="On LinkedIn"><textarea rows={6} className={inputCls} value={settings.toneExamplesLinkedin} onChange={(e) => set("toneExamplesLinkedin", e.target.value)} /></StackRow>
            </Group>
            <Group title="Style guide">
              <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <span className="min-w-0 text-sm">PostEcho writes the guide from your posts and your style inspiration.</span>
                <span className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                  <button type="button" onClick={analyzeMyPosts} disabled={analyzeBusy} className={pillCls}>
                    {analyzeBusy ? "Analyzing…" : "Analyze my posts"}
                  </button>
                  {analyzeError && <span className="text-xs text-danger">{analyzeError}</span>}
                </span>
              </div>
              {analyzeBusy && analyzeJob && (
                <div className="px-4 py-3">
                  <WorkProgress steps={analyzeSteps(analyzeJob.status)} startedAt={analyzeJob.createdAt} typical="usually under a minute" label="Style guide progress" />
                </div>
              )}
              <StackRow label="The guide">
                <textarea rows={8} className={inputCls} value={settings.styleGuide} onChange={(e) => set("styleGuide", e.target.value)}
                  placeholder="Press “Analyze my posts”, or write a short style guide yourself." />
              </StackRow>
            </Group>
            <StyleInspirationSection analyzedAt={settings.styleGuideAnalyzedAt ?? null} />
          </>
        );
      case "references":
        return <ReferencesSection />;
      case "sources":
        return (
          <>
            <Group
              title="What to show you first"
              hint="Drag to reorder. PostEcho also learns from what you like, dismiss and rate in Calendar."
            >
              <FindOrderList order={settings.findOrder} counts={kindCounts} onChange={(next) => set("findOrder", next)} />
            </Group>
            <Group title="Sources" hint={sourceError ?? undefined}>
              {sources ? sources.map((src) => {
                const isX = src.name === X_SOURCE_NAME;
                return (
                  <div key={src.name} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={src.enabled ? "text-ok" : "text-text-dim"}>{src.enabled ? "●" : "○"}</span>
                      <span>{src.label}</span>
                      {isX && src.enabled && (
                        <span className="truncate text-xs text-text-dim">
                          · {settings.xPostsPerSearch} posts per search, about ${(settings.xPostsPerSearch * X_PRICES_USD.postRead).toFixed(2)}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-xs">
                      {(isX || src.keyedBy === "server") && src.enabled && (
                        <button type="button" onClick={() => setConnecting(src)} className="text-text-dim underline hover:text-text">Edit</button>
                      )}
                      {src.enabled ? (
                        <button type="button" onClick={() => void setSourceOff(src.name, true).then((e) => setSourceError(e))}
                          className="rounded-full border border-border px-3 py-1 text-text-dim hover:border-danger hover:text-danger">
                          Disconnect
                        </button>
                      ) : (
                        <button type="button" onClick={() => setConnecting(src)}
                          className="rounded-full border border-border px-3 py-1 text-text hover:border-text-dim">
                          Connect
                        </button>
                      )}
                    </span>
                  </div>
                );
              }) : <p className="px-4 py-3 text-sm text-text-dim">Loading…</p>}
            </Group>
            {/* The numbers behind a search (2026-09-26: "deve capirlo chiunque"): out of the way until asked for. */}
            <details className="space-y-2">
              <summary className="cursor-pointer text-sm font-semibold text-text-dim hover:text-text">Advanced</summary>
              <Group
                hint={<>Each search keeps going, up to 4 rounds, until it has that many results over the minimum score, then keeps the best across every source.{tasteCounts ? ` Learning from ${tasteCounts.kept} liked or used · ${tasteCounts.skipped} dismissed · ${tasteCounts.rated ?? 0} rated posts.` : ""}</>}
              >
                <Row label="Minimum score" hint="Ideas scoring below it are never saved (0–100)">
                  <input type="number" min={0} max={100} className={inputCls} value={settings.scoutMinScore} onChange={(e) => set("scoutMinScore", Number(e.target.value))} />
                </Row>
                <Row label="Results per search" hint="The best across all sources (5–50)">
                  <input type="number" min={5} max={50} className={inputCls} value={settings.scoutResultsTotal} onChange={(e) => set("scoutResultsTotal", Number(e.target.value))} />
                </Row>
                <Row label="Candidates per source" hint="Judged per round (5–50)">
                  <input type="number" min={5} max={50} className={inputCls} value={settings.scoutCandidatesPerSource} onChange={(e) => set("scoutCandidatesPerSource", Number(e.target.value))} />
                </Row>
              </Group>
            </details>
          </>
        );
      case "agent":
        return (
          <AiTools
            heartbeatAge={heartbeatAge}
            jev={connections?.jev ?? null}
            claudeModel={settings.claudeModel}
            onModel={(model) => set("claudeModel", model)}
            onSetUpClaude={() => setAiDialog("claude")}
            onConnectJev={() => setAiDialog("jev")}
          />
        );
    }
  }

  const body = (
    <div className={mode === "modal" ? "flex h-full min-h-0 flex-col md:flex-row" : "flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-border bg-surface md:flex-row"}>
      <aside className="flex shrink-0 items-center gap-2 border-b border-border p-3 md:w-52 md:flex-col md:items-stretch md:gap-0 md:border-b-0 md:border-r md:p-4 md:pb-3">
        <p id={titleId} className="mb-3 hidden px-3 text-sm font-semibold md:block">Settings</p>
        <div role="tablist" aria-label="Settings" aria-orientation="vertical" className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:mx-0 md:flex-none md:flex-col md:overflow-visible md:px-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              data-tip={t.tip}
              onClick={() => setTab(t.id)}
              className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium ${
                t.id === tab ? "bg-accent text-accent-ink" : "text-text-dim hover:bg-surface-2 hover:text-text"
              }`}
            >
              <TabIcon id={t.id} />
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={requestSignOut}
          className="flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium text-text-dim hover:bg-surface-2 hover:text-text md:mt-auto">
          <SignOutIcon />
          Sign out
        </button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 px-6 pb-3 pt-5">
          <h2 className="text-base font-semibold">{current.title}</h2>
          {mode === "modal" && (
            <button type="button" onClick={requestClose} aria-label="Close settings"
              className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text">
              ×
            </button>
          )}
        </div>
        <div role="tabpanel" aria-label={current.title} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
          {s ? content(s) : <p className={`text-sm ${loadError ? "text-danger" : "text-text-dim"}`}>{loadError ?? "Loading…"}</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-3">
          {(tab === "sources" || tab === "voice" || tab === "references") && (
            <p className="text-xs text-text-dim">{tab === "sources" ? "Connecting and disconnecting save at once." : tab === "voice" ? "Style inspiration saves as you change it." : "References save as you change them."}</p>
          )}
          <div className="ml-auto flex items-center gap-3">
            {error && <span className="text-sm text-danger">{error}</span>}
            {saved && !dirty && !error && <span className="text-sm text-ok">Saved</span>}
            {dirty && !error && <span className="text-xs text-text-dim">Unsaved changes</span>}
            <button type="button" onClick={save} disabled={busy || !dirty} className={primaryPillCls}>
              {busy ? "Saving…" : "Save settings"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  const connectWindow = connecting && s && (
    <SourceConnectDialog
      key={connecting.name}
      source={connecting}
      xStatus={xStatus}
      xPostsPerSearch={s.xPostsPerSearch}
      onXKeyChanged={reloadXStatus}
      connection={connections?.[connecting.name] ?? null}
      onKeysChanged={() => setSourcesVersion((v) => v + 1)}
      onConnect={(extra) => setSourceOff(connecting.name, false, extra)}
      onClose={() => setConnecting(null)}
    />
  );
  const aiWindow = aiDialog === "claude"
    ? <ClaudeConnectDialog onClose={() => setAiDialog(null)} />
    : aiDialog === "jev"
      ? <KeyConnectDialog guide={KEY_GUIDES.jev} status={connections?.jev ?? null} onChanged={() => setSourcesVersion((v) => v + 1)} onClose={() => setAiDialog(null)} />
      : null;

  if (mode === "page") return <>{body}{connectWindow}{aiWindow}</>;
  return (
    <Modal labelledBy={titleId} onRequestClose={requestClose} width="60rem" height="44rem">
      {body}
      {connectWindow}
      {aiWindow}
    </Modal>
  );
}
