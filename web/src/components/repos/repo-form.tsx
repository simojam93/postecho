"use client";

import { useState } from "react";
import { refreshWork } from "@/components/work-status";
import { parseGithubUrl } from "@/lib/repo-source";
import type { RepoFormat } from "./repo-steps";

/** The format control, in the order the spec names them. */
const FORMATS: { key: RepoFormat; label: string }[] = [
  { key: "x", label: "X post" },
  { key: "linkedin", label: "LinkedIn post" },
  { key: "article", label: "X article" },
];
const COUNTS = [1, 2, 3, 4, 5, 6];
const DEFAULT_COUNT = 3;
const BRIEF_MAX = 500;

/** How often a folder pick is looked at, and how long it may sit unclaimed before the Mac counts as offline. */
const PICK_POLL_MS = 1000;
const PICK_QUEUED_MS = 15_000;
/** The picker stays open while the owner browses; past this, the path field takes over. */
const PICK_MAX_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type RepoFormValues = { path: string; githubUrl: string; brief: string; format: RepoFormat; count: number };
export type RepoPostsBody = {
  source: { type: "folder"; path: string } | { type: "github"; url: string };
  brief: string;
  format: RepoFormat;
  count: number;
};

/**
 * What Create sends to POST /api/repos, or why it can't yet: a GitHub link when there is one
 * (typing it clears the folder), else the folder. The route checks again and says the same.
 */
export function repoPayload(values: RepoFormValues): { ok: true; body: RepoPostsBody } | { ok: false; error: string } {
  const githubUrl = values.githubUrl.trim();
  const path = values.path.trim();
  let source: RepoPostsBody["source"];
  if (githubUrl) {
    if (!parseGithubUrl(githubUrl)) return { ok: false, error: "Paste a public GitHub link, like https://github.com/owner/name." };
    source = { type: "github", url: githubUrl };
  } else if (path) {
    source = { type: "folder", path };
  } else {
    return { ok: false, error: "Choose a folder, or paste a GitHub link." };
  }
  const count = Math.min(COUNTS.length, Math.max(1, Math.round(values.count)));
  return { ok: true, body: { source, brief: values.brief.trim().slice(0, BRIEF_MAX), format: values.format, count } };
}

const inputCls = "rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-text-dim";

/**
 * From a repo's box (spec 2026-10-10): the source, a folder chosen with the Mac's own picker
 * (POST /api/repos/pick, then its pick_folder job) or typed, or a GitHub link; what the posts are
 * about; how many and in which format; Create. The job's progress and posts show below, under the
 * source's chip (RepoPosts).
 */
export function RepoForm({ onCreated }: { onCreated: (ideaId: string) => void }) {
  const [path, setPath] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  // The path field shows once a folder is chosen, or when the picker can't open (it takes focus then).
  const [pathShown, setPathShown] = useState(false);
  const [pathFocus, setPathFocus] = useState(false);
  const [brief, setBrief] = useState("");
  const [format, setFormat] = useState<RepoFormat>("x");
  const [count, setCount] = useState(DEFAULT_COUNT);
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
    const payload = repoPayload({ path, githubUrl, brief, format, count });
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
      <p className="text-xs text-text-dim">The repository&apos;s content goes to Claude to write the posts.</p>
      <input value={brief} maxLength={BRIEF_MAX} aria-label="What the posts are about"
        placeholder="What they're about, like the launch of tier gating"
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void create()}
        className={inputCls} />
      <div className="flex flex-wrap items-center gap-2">
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many"
          className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-text-dim">
          {COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
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
