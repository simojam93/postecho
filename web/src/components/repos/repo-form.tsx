"use client";

import { useEffect, useRef, useState } from "react";
import type { Idea } from "@/components/idea-card";
import { refreshWork } from "@/components/work-status";
import { parseGithubUrl } from "@/lib/repo-source";
import type { RepoFormat } from "./repo-steps";

/**
 * What gets written, said with how many (owner, 2026-10-11: "non è chiaro cosa ti fa fare quel
 * pulsante"). No LinkedIn post here: Compose writes each post's LinkedIn version from the repo.
 */
const FORMATS: { key: RepoFormat; label: string }[] = [
  { key: "x", label: "6 X posts" },
  { key: "article", label: "2 X articles" },
];
/** No count to pick (owner, 2026-10-10): six posts each time, two articles, which take far longer to write and read. */
const countFor = (format: RepoFormat) => (format === "article" ? 2 : 6);
const BRIEF_MAX = 500;

/** How often a folder pick is looked at, and how long it may sit unclaimed before the Mac counts as offline. */
const PICK_POLL_MS = 1000;
const PICK_QUEUED_MS = 15_000;
/** The picker stays open while the owner browses; past this, the path field takes over. */
const PICK_MAX_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type RepoSource = { type: "folder"; path: string } | { type: "github"; url: string };
/** `source`: a chip's, selected; it wins over the folder and link fields. */
export type RepoFormValues = { path: string; githubUrl: string; brief: string; format: RepoFormat; source?: RepoSource | null };
export type RepoPostsBody = { source: RepoSource; brief: string; format: RepoFormat; count: number };

/** A source chip's repo as POST /api/repos takes it: its folder (meta.path, else its file:// url) or its link. */
export function repoSource(repo: Idea): RepoSource {
  if (repo.meta.sourceType === "folder") {
    const path = repo.meta.path ?? (repo.url ?? "").replace(/^file:\/\//, "");
    return { type: "folder", path };
  }
  return { type: "github", url: repo.url ?? "" };
}

/**
 * What Create sends to POST /api/repos, or why it can't yet: a GitHub link when there is one
 * (typing it clears the folder), else the folder; a selected chip's source before either. The
 * route checks again and says the same.
 */
export function repoPayload(values: RepoFormValues): { ok: true; body: RepoPostsBody } | { ok: false; error: string } {
  const githubUrl = values.githubUrl.trim();
  const path = values.path.trim();
  let source: RepoSource;
  if (values.source) {
    source = values.source;
  } else if (githubUrl) {
    if (!parseGithubUrl(githubUrl)) return { ok: false, error: "Paste a public GitHub link, like https://github.com/owner/name." };
    source = { type: "github", url: githubUrl };
  } else if (path) {
    source = { type: "folder", path };
  } else {
    return { ok: false, error: "Choose a folder, or paste a GitHub link." };
  }
  return { ok: true, body: { source, brief: values.brief.trim().slice(0, BRIEF_MAX), format: values.format, count: countFor(values.format) } };
}

/** How many sources not pinned the folder chip's menu offers, latest first. */
const MENU_RECENT = 5;

const chipCls = "inline-flex h-9 max-w-full items-center gap-2 rounded-lg bg-surface-2 px-3 text-sm text-text hover:bg-border disabled:opacity-50";
const chipInputCls = "h-9 min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-text-dim";

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-text-dim">
    <path d={d} />
  </svg>
);
const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const BRANCH = "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9";

/** A folder's last part, a link's owner/name: what its chip says. */
function shortName(source: RepoSource): string {
  if (source.type === "github") {
    const parsed = parseGithubUrl(source.url);
    return parsed ? `${parsed.owner}/${parsed.name}` : source.url;
  }
  return source.path.replace(/\/+$/, "").split("/").pop() || source.path;
}

/**
 * From a repo's box (spec 2026-10-10), laid out like Claude's (owner, 2026-10-11: "sullo stile di
 * claude"), then "Choose a folder or Paste a GitHub link" and "Write ( 6 X posts | 2 X articles )": the source's chips and what to write above the box for what the posts are about
 * and Create, which look like Trends' and Video posts'. The source is a folder chosen with the Mac's own picker (POST /api/repos/pick, then its
 * pick_folder job) or typed, or a GitHub link. The job's progress and posts show below, under the
 * source's chip (RepoPosts). A chip clicked on the page becomes the source (`repo`, the page's
 * selection) and stays after Create, so the same repo can be asked other things; its × (`onClear`)
 * brings the folder and link back.
 */
export function RepoForm({ onCreated, repo = null, onClear, repos = [], onPick, onFavorite }: {
  onCreated: (ideaId: string) => void;
  repo?: Idea | null;
  onClear?: () => void;
  /** The sources used so far, pinned (★) first (repo-chips.tsx's sortRepos): the folder chip's menu offers them. */
  repos?: Idea[];
  /** A source picked from that menu: the page selects it, as a click on its chip below does. */
  onPick?: (repo: Idea) => void;
  /** ☆ on the chosen source's chip: pins it, so it heads the menu (meta.favorite). */
  onFavorite?: (repo: Idea) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // ☆ on a source not used yet: it's pinned once Create makes it.
  const [pinNew, setPinNew] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menuOpen]);
  // The menu: every pinned source, then the latest others.
  const offered = [...repos.filter((r) => r.meta.favorite === true), ...repos.filter((r) => r.meta.favorite !== true).slice(0, MENU_RECENT)];

  const [path, setPath] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  // The GitHub link field opens from its chip, and the path field when the picker can't open (it takes focus then).
  const [linkOpen, setLinkOpen] = useState(false);
  const [pathShown, setPathShown] = useState(false);
  const [pathFocus, setPathFocus] = useState(false);
  const [brief, setBrief] = useState("");
  const [format, setFormat] = useState<RepoFormat>("x");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function typePath(message: string | null) {
    setPathShown(true);
    setPathFocus(true);
    setError(message);
  }

  /** Choose a folder: the picker opens on the owner's Mac; its answer fills the path. */
  async function chooseFolder() {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const res = await fetch("/api/repos/pick", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(typeof body?.error === "string" ? body.error : "Couldn't open the folder picker."); return; }
      const started = Date.now();
      while (Date.now() - started < PICK_MAX_MS) {
        await sleep(PICK_POLL_MS);
        const poll = await fetch(`/api/jobs?id=${body.jobId}`);
        if (!poll.ok) continue;
        const job = (await poll.json()).jobs?.[0] as { status: string; result: Record<string, unknown> | null } | undefined;
        if (!job) return;
        if (job.status === "queued" && Date.now() - started > PICK_QUEUED_MS) {
          typePath("Your Mac agent looks offline: type the path instead.");
          return;
        }
        if (job.status === "done") {
          if (typeof job.result?.path === "string") {
            setPath(job.result.path);
            setGithubUrl("");
            setLinkOpen(false);
            setPathShown(false);
          }
          return;
        }
        // No picker on that computer: the agent's own sentence asks for the path, so the field says it by taking focus.
        if (job.status === "failed") { typePath(null); return; }
      }
      typePath(null);
    } catch (e) {
      console.error("folder pick failed:", e);
      typePath(null);
    } finally {
      setPicking(false);
    }
  }

  async function create() {
    if (busy) return;
    const payload = repoPayload({ path, githubUrl, brief, format, source: repo ? repoSource(repo) : null });
    if (!payload.ok) { setError(payload.error); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.body),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(typeof body?.error === "string" ? body.error : "Something went wrong. Try again."); return; }
      setPath("");
      setGithubUrl("");
      setPathShown(false);
      setLinkOpen(false);
      setBrief("");
      // ☆ pressed on a new source: pinned now that it exists.
      if (pinNew && !repo) {
        await fetch(`/api/ideas/${body.ideaId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite: true }),
        }).catch((e) => console.error("couldn't pin the source:", e));
      }
      setPinNew(false);
      onCreated(body.ideaId);
      void refreshWork();
    } catch (e) {
      console.error("repo posts request failed:", e);
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // The source chosen here, once there is one: a chip with its name and ×.
  const link = githubUrl.trim();
  const chosen: RepoSource | null = repo ? repoSource(repo)
    : path.trim() && !pathShown ? { type: "folder", path: path.trim() }
    : link && !linkOpen && parseGithubUrl(link) ? { type: "github", url: link }
    : null;
  function clearChosen() {
    if (repo) { onClear?.(); return; }
    setPath("");
    setGithubUrl("");
    setPinNew(false);
  }
  const chosenName = repo ? repo.title ?? repo.url ?? "" : chosen ? shortName(chosen) : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {chosen ? (
            <span className={`${chipCls} pr-1 hover:bg-surface-2`} title={chosen.type === "folder" ? chosen.path : chosen.url}>
              {(() => {
                // A source used before pins at once; a new one is pinned when Create makes it (pinNew).
                const pinned = repo ? repo.meta.favorite === true : pinNew;
                if (repo && !onFavorite) return <Icon d={chosen.type === "folder" ? FOLDER : BRANCH} />;
                return (
                  <button type="button" onClick={() => (repo ? onFavorite?.(repo) : setPinNew((on) => !on))}
                    aria-label={pinned ? `Unpin ${chosenName}` : `Pin ${chosenName}`}
                    data-tip={pinned ? "Unpin it" : "Keep it in this menu"}
                    className={pinned ? "text-text" : "text-text-dim hover:text-text"}>
                    {pinned ? "★" : "☆"}
                  </button>
                );
              })()}
              <span className="truncate">{chosenName}</span>
              <button type="button" onClick={clearChosen} aria-label={`Clear ${chosenName}`}
                className="rounded-md px-1.5 text-text-dim hover:text-text">
                ×
              </button>
            </span>
          ) : (
            <>
              <div ref={menuRef} className="relative">
                <button type="button" disabled={picking} className={chipCls}
                  {...(offered.length > 0 ? { "aria-haspopup": "menu" as const, "aria-expanded": menuOpen } : {})}
                  onClick={() => (offered.length > 0 ? setMenuOpen((open) => !open) : void chooseFolder())}>
                  <Icon d={FOLDER} />
                  {picking ? "Choosing…" : "Choose a folder"}
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-surface-2 p-1 shadow-lg">
                    {offered.map((r) => (
                      <button key={r.id} type="button" role="menuitem" title={r.url ?? undefined}
                        onClick={() => { setMenuOpen(false); onPick?.(r); }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-border">
                        <span className={`w-4 shrink-0 text-center ${r.meta.favorite ? "text-text" : "text-text-dim"}`}>
                          {r.meta.favorite ? "★" : ""}
                        </span>
                        <span className="truncate">{r.title ?? r.url}</span>
                      </button>
                    ))}
                    <div className="my-1 border-t border-border" />
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void chooseFolder(); }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-text-dim hover:bg-border hover:text-text">
                      <Icon d={FOLDER} />
                      Choose a folder…
                    </button>
                  </div>
                )}
              </div>
              {pathShown && (
                <input value={path} autoFocus={pathFocus} aria-label="Folder path" placeholder="/Users/you/dev/project"
                  onChange={(e) => { setPath(e.target.value); if (e.target.value) setGithubUrl(""); }}
                  onKeyDown={(e) => e.key === "Enter" && void create()}
                  className={`w-72 ${chipInputCls}`} />
              )}
              <span className="text-sm text-text-dim">or</span>
              {linkOpen ? (
                <input value={githubUrl} autoFocus aria-label="GitHub link" placeholder="https://github.com/owner/name"
                  onChange={(e) => { setGithubUrl(e.target.value); if (e.target.value) { setPath(""); setPathShown(false); } }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setGithubUrl(""); setLinkOpen(false); }
                    if (e.key === "Enter" && parseGithubUrl(githubUrl)) setLinkOpen(false);
                  }}
                  onBlur={() => { if (!githubUrl.trim() || parseGithubUrl(githubUrl)) setLinkOpen(false); }}
                  className={`w-72 ${chipInputCls}`} />
              ) : (
                <button type="button" onClick={() => setLinkOpen(true)} className={chipCls}>
                  <Icon d={BRANCH} />
                  Paste a GitHub link
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-dim">Write</span>
          <div role="radiogroup" aria-label="What to write" className="flex rounded-full border border-border p-0.5">
            {FORMATS.map(({ key, label }) => (
              <button key={key} type="button" role="radio" aria-checked={format === key} onClick={() => setFormat(key)}
                className={`rounded-full px-3 py-1 text-sm ${format === key ? "bg-border text-text" : "text-text-dim hover:text-text"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <input value={brief} maxLength={BRIEF_MAX} aria-label="What the posts are about"
          placeholder="What they're about, like the launch of tier gating"
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim" />
        <button type="button" onClick={() => void create()} disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      <p className="text-xs text-text-dim">The repository&apos;s content goes to Claude to write the posts.</p>
      {error && <p role="status" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
