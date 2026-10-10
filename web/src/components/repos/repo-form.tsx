"use client";

import { useState } from "react";
import type { Idea } from "@/components/idea-card";
import { refreshWork } from "@/components/work-status";
import { parseGithubUrl } from "@/lib/repo-source";
import type { RepoFormat } from "./repo-steps";

/** The format control, in the order the spec names them. */
const FORMATS: { key: RepoFormat; label: string }[] = [
  { key: "x", label: "X post" },
  { key: "linkedin", label: "LinkedIn post" },
  { key: "article", label: "X article" },
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

const inputCls = "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim";

/**
 * From a repo's box (spec 2026-10-10): the source, a folder chosen with the Mac's own picker
 * (POST /api/repos/pick, then its pick_folder job) or typed, or a GitHub link; what the posts are
 * about; the format; Create. The job's progress and posts show below, under the
 * source's chip (RepoPosts). A chip clicked becomes the source (`repo`, the page's selection) and
 * stays after Create, so the same repo can be asked other things; its × (`onClear`) brings the
 * folder and link back.
 */
export function RepoForm({ onCreated, repo = null, onClear }: { onCreated: (ideaId: string) => void; repo?: Idea | null; onClear?: () => void }) {
  const [path, setPath] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  // The path field shows once a folder is chosen, or when the picker can't open (it takes focus then).
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
            setPathShown(true);
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
      setBrief("");
      onCreated(body.ideaId);
      void refreshWork();
    } catch (e) {
      console.error("repo posts request failed:", e);
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {repo ? (
        <span className="inline-flex w-fit max-w-full items-center rounded-full border border-text-dim bg-surface-2 text-sm text-text">
          <span className="truncate py-1.5 pl-4 pr-1">{repo.title ?? repo.url}</span>
          <button type="button" onClick={onClear} aria-label={`Clear ${repo.title ?? repo.url}`}
            className="rounded-r-full py-1.5 pl-1 pr-3 text-text-dim hover:text-text">
            ×
          </button>
        </span>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void chooseFolder()} disabled={picking}
            className="rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50">
            {picking ? "Choosing…" : "Choose a folder"}
          </button>
          {pathShown && (
            <input value={path} autoFocus={pathFocus} aria-label="Folder path" placeholder="/Users/you/dev/project"
              onChange={(e) => { setPath(e.target.value); if (e.target.value) setGithubUrl(""); }}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              className={`min-w-0 flex-1 ${inputCls}`} />
          )}
          <input value={githubUrl} aria-label="GitHub link" placeholder="Or paste a GitHub link"
            onChange={(e) => { setGithubUrl(e.target.value); if (e.target.value) setPath(""); }}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            className={`min-w-0 flex-1 ${inputCls}`} />
        </div>
      )}
      <p className="text-xs text-text-dim">The repository&apos;s content goes to Claude to write the posts.</p>
      <input value={brief} maxLength={BRIEF_MAX} aria-label="What the posts are about"
        placeholder="What they're about, like the launch of tier gating"
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void create()}
        className={inputCls} />
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Format" className="flex w-fit gap-1 rounded-full bg-surface p-1">
          {FORMATS.map(({ key, label }) => (
            <button key={key} type="button" role="radio" aria-checked={format === key} onClick={() => setFormat(key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${format === key ? "bg-surface-2 text-text" : "text-text-dim"}`}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void create()} disabled={busy}
          className="ml-auto rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      {error && <p role="status" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
