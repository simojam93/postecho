"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArchiveButton } from "@/components/archive";
import { isVideoPost } from "@/lib/video-post";
import { InProgressStrip, type StripChip } from "@/components/write/in-progress-strip";
import { NewPostComposer } from "@/components/write/new-post-composer";
import { SourceCard } from "@/components/write/source-card";
import { TakesRow } from "@/components/write/takes-row";
import { PostEditor, YOUR_POST_ID } from "@/components/write/post-editor";
import { chosenOf, ideaLabel, isInFlight, takesOf, versionChain } from "@/components/write/post-state";
import { useSlopQueue } from "@/components/write/use-slop-queue";
import type { Draft, Identity, JobInfo, Platform, PostInProgress, SourceIdea } from "@/components/write/types";
import { isVoice, voiceOfIdea, type Voice } from "@/lib/voice";

// Matches every other "Claude is …" wait in the app (lib/poll-job.ts).
const POLL_MS = 3000;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** The post on screen: its idea's drafts (every status) and latest generation job. Keyed by idea so a stale load never shows under another idea. */
type LoadedPost = { ideaId: string; drafts: Draft[]; latestJob: JobInfo | null };

async function patchDraft(id: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`/api/drafts/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(fields) });
  return res.ok;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * Write (M2.5 plan, task W3; route path stays /create): one post at a time.
 * `?ideaId=` picks the post; without it the most recent post in progress
 * opens (and the URL is pinned to it), or the empty state. Top to bottom:
 * the in-progress strip, the source idea, Claude's takes with **Pick this**,
 * and — once a take is chosen — the editor. `useSearchParams` needs a
 * Suspense boundary (the default export below); this inner component holds
 * all the page's state, same "one big client component" shape as
 * (authed)/page.tsx.
 *
 * Data: GET /api/drafts?view=in-progress (strip), GET /api/ideas (the source
 * card and the chips' excerpts — there is no GET /api/ideas/:id yet, and
 * Find Ideas loads the same list), GET /api/settings (identity for the
 * X-style take previews), and per post GET /api/jobs?ideaId= then
 * GET /api/drafts?ideaId= — polled every POLL_MS while a generation job is
 * queued/claimed (the takes row turns that job into the progress block).
 * Takes without a persisted AI-style score are scored one at a time in the
 * background (useSlopQueue), each followed by a reload of the post.
 *
 * Status dance (no new endpoints — plan W2): a post's chosen take is its
 * `kept` draft. Picking a take PATCHes it `kept` FIRST and then PATCHes the
 * previously chosen one(s) back to `candidate`, so a failure between the two
 * leaves two kept drafts (the most recently updated wins, see
 * post-state.ts's chosenOf) rather than none. A Refine lands its revision
 * as `kept` (lib/materialize.ts); onRefined then demotes the take it
 * replaced the same way.
 */
function WriteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedIdeaId = searchParams.get("ideaId");

  const [posts, setPosts] = useState<PostInProgress[] | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [postsKey, setPostsKey] = useState(0);
  const [ideasById, setIdeasById] = useState<Map<string, SourceIdea> | null>(null);
  const [ideasError, setIdeasError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loaded, setLoaded] = useState<LoadedPost | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [removingIdeaId, setRemovingIdeaId] = useState<string | null>(null);
  // Write's + New (2026-09-24): the composer for a post from the owner's own text.
  const [composerOpen, setComposerOpen] = useState(false);

  // Drafts with no idea (none exist today) come back as an ideaId-null entry
  // that `?ideaId=` can't address — the strip skips it.
  const firstIdeaId = posts?.find((p) => p.ideaId !== null)?.ideaId ?? null;
  const currentIdeaId = requestedIdeaId ?? firstIdeaId;

  // Pin the URL to the post on screen when none was requested, so a reload
  // or a later strip refresh (another post becoming the most recent) keeps
  // showing this one.
  useEffect(() => {
    if (!requestedIdeaId && firstIdeaId) router.replace(`/create?ideaId=${firstIdeaId}`);
  }, [requestedIdeaId, firstIdeaId, router]);

  // The strip. Every setState here happens after an await — the accepted
  // pattern for react-hooks/set-state-in-effect (see settings/page.tsx).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/drafts?view=in-progress");
        if (!res.ok) throw new Error(`in-progress ${res.status}`);
        const body = await res.json();
        if (!cancelled) { setPosts(body.posts); setPostsError(null); }
      } catch (e) {
        console.error("failed to load posts in progress:", e);
        if (!cancelled) { setPosts((current) => current ?? []); setPostsError("Failed to load posts in progress."); }
      }
    })();
    return () => { cancelled = true; };
  }, [postsKey]);

  // Identity for the take previews — optional: without it the cards say "You".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const { settings } = await res.json();
        if (!cancelled) {
          setIdentity({
            name: typeof settings.identityName === "string" ? settings.identityName : "",
            handle: typeof settings.identityHandle === "string" ? settings.identityHandle : "",
            avatarUrl: typeof settings.identityAvatarUrl === "string" ? settings.identityAvatarUrl : "",
          });
        }
      } catch (e) {
        console.error("failed to load identity:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The ideas, refreshed whenever the post switches (a newly captured video
  // may not have been in the last list) — source card + chip excerpts.
  useEffect(() => {
    if (!currentIdeaId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ideas");
        if (!res.ok) throw new Error(`ideas ${res.status}`);
        const body = await res.json();
        if (!cancelled) {
          setIdeasById(new Map((body.ideas as SourceIdea[]).map((i) => [i.id, i])));
          setIdeasError(null);
        }
      } catch (e) {
        console.error("failed to load ideas:", e);
        if (!cancelled) setIdeasError("Failed to load the idea.");
      }
    })();
    return () => { cancelled = true; };
  }, [currentIdeaId]);

  // The post: its latest generation job, then its drafts — in that order,
  // because a job flips to `done` only after its drafts are materialized
  // (see api/agent/jobs/[id]/result), so drafts fetched after a `done`
  // always include the new takes. Re-polled every POLL_MS while the job is
  // queued/claimed; when it settles, the strip is refreshed too (its dot
  // and counts are stale).
  useEffect(() => {
    if (!currentIdeaId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawInFlight = false;

    const check = async () => {
      try {
        const jobsRes = await fetch(`/api/jobs?ideaId=${currentIdeaId}`);
        const latestJob = jobsRes.ok ? ((await jobsRes.json()).jobs?.[0] as JobInfo | undefined) ?? null : null;
        const draftsRes = await fetch(`/api/drafts?ideaId=${currentIdeaId}&limit=100`);
        if (!draftsRes.ok) throw new Error(`drafts ${draftsRes.status}`);
        const drafts = (await draftsRes.json()).drafts as Draft[];
        if (cancelled) return;
        setLoaded({ ideaId: currentIdeaId, drafts, latestJob });
        setLoadError(null);
        if (isInFlight(latestJob?.status)) {
          sawInFlight = true;
          timer = setTimeout(check, POLL_MS);
        } else if (sawInFlight) {
          setPostsKey((k) => k + 1);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("failed to load the post:", e);
        setLoadError("Failed to load this post.");
      }
    };
    check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [currentIdeaId, reloadKey]);

  /** Refetch the post on screen (job + drafts) only — stable, so the slop queue's effect isn't re-run by every render. */
  const reloadPost = useCallback(() => setReloadKey((k) => k + 1), []);

  function reload() {
    reloadPost();
    setPostsKey((k) => k + 1);
  }

  const post = loaded && loaded.ideaId === currentIdeaId ? loaded : null;
  // AI-style on every take (M3.5, task U2): scores the takes without a
  // persisted meta.slop, one request at a time, reloading the post after
  // each so the cards' badges read the persisted truth.
  const checkingSlopId = useSlopQueue(post?.drafts ?? null, reloadPost);
  // undefined = still loading; null = no such idea.
  const idea: SourceIdea | null | undefined =
    currentIdeaId && ideasById ? ideasById.get(currentIdeaId) ?? null : undefined;
  const takes = post ? takesOf(post.drafts) : [];
  const chosen = post ? chosenOf(post.drafts) : null;
  const chain = post && chosen ? versionChain(chosen, post.drafts) : [];
  // The post's voice: the latest version's (a switch lands on the version it
  // produced), else the idea's, else the default for where it came from.
  const chainVoice = [...chain].reverse().map((d) => d.meta.voice).find(isVoice);
  const voice: Voice = chainVoice ?? voiceOfIdea(idea ? { kind: idea.kind, meta: idea.meta as Record<string, unknown> } : null);

  const chips: StripChip[] = (posts ?? [])
    .filter((p): p is PostInProgress & { ideaId: string } => p.ideaId !== null)
    .map((p) => ({
      ideaId: p.ideaId,
      label: ideaLabel(ideasById?.get(p.ideaId) ?? p.idea),
      inFlight: isInFlight(p.latestJobStatus),
      takeCount: p.takeCount,
      chosen: p.chosenDraftId !== null,
    }));
  // The post on screen always has a chip — right after Use, before its first
  // take lands, it isn't in the in-progress list yet.
  if (currentIdeaId && posts && !chips.some((c) => c.ideaId === currentIdeaId)) {
    chips.unshift({
      ideaId: currentIdeaId,
      label: idea === undefined ? "…" : ideaLabel(idea),
      inFlight: isInFlight(post?.latestJob?.status),
      takeCount: takes.length,
      chosen: chosen !== null,
    });
  }

  // The editor's platform tab, per post: kept here so a new version (which remounts the editor) stays on it.
  const [editorTabs, setEditorTabs] = useState<Record<string, Platform>>({});
  const editorTab: Platform = (currentIdeaId && editorTabs[currentIdeaId]) || "x";

  // Pick this scrolls down to Your post once the picked take is the one on screen (owner, 2026-09-27:
  // "basta che quando uno clicca pick this c'è uno scroll down che lo porta alla parte interessante").
  const scrollToPicked = useRef<string | null>(null);
  const chosenId = chosen?.id ?? null;
  useEffect(() => {
    if (!scrollToPicked.current || chosenId !== scrollToPicked.current) return;
    scrollToPicked.current = null;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(YOUR_POST_ID)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [chosenId]);

  /**
   * Pick this / back to vN-1: PATCH the new take `kept`, then the previously
   * chosen one(s) back to `candidate` — see the status-dance note above.
   * Applied optimistically to the loaded post (with a fresh updatedAt so
   * chosenOf agrees), then the server's truth is reloaded either way.
   */
  async function pickTake(id: string) {
    if (pickBusy || !post) return;
    const previous = post.drafts.filter((d) => d.status === "kept" && d.id !== id);
    setPickBusy(true);
    setActionError(null);
    const now = new Date().toISOString();
    setLoaded((current) => current && current.ideaId === post.ideaId
      ? {
        ...current,
        drafts: current.drafts.map((d) => {
          if (d.id === id) return { ...d, status: "kept" as const, updatedAt: now };
          if (previous.some((p) => p.id === d.id)) return { ...d, status: "candidate" as const, updatedAt: now };
          return d;
        }),
      }
      : current);
    try {
      if (!(await patchDraft(id, { status: "kept" }))) throw new Error("keep failed");
      for (const p of previous) {
        if (!(await patchDraft(p.id, { status: "candidate" }))) throw new Error("demote failed");
      }
    } catch (e) {
      console.error("failed to pick the take:", e);
      setActionError("Failed to pick this take.");
    } finally {
      setPickBusy(false);
      reload();
    }
  }

  /** A Refine finished: its revision is already kept — demote the take it replaced, then reload (the editor remounts on the revision). */
  async function handleRefined(supersededId: string) {
    if (!(await patchDraft(supersededId, { status: "candidate" }))) {
      setActionError("The revision landed, but the previous take could not be set aside.");
    }
    reload();
  }

  /**
   * New takes: a fresh generation job for this idea (POST /api/videos for a
   * video, else POST /api/drafts/from-idea), then poll. Claude writes three
   * more, and the post keeps the three most human of all (lib/takes.ts).
   */
  async function moreTakes() {
    if (moreBusy || !idea) return;
    setMoreBusy(true);
    setActionError(null);
    try {
      const res = idea.kind === "youtube" && idea.url
        ? await fetch("/api/videos", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ url: idea.url, count: 3 }) })
        : await fetch("/api/drafts/from-idea", {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ideaId: idea.id, count: 3 }),
        });
      if (!res.ok) setActionError(await errorMessage(res, "Failed to ask for new takes."));
    } catch (e) {
      console.error("failed to ask for new takes:", e);
      setActionError("Failed to ask for new takes.");
    } finally {
      setMoreBusy(false);
      reload();
    }
  }

  /**
   * Remove post (the × on a strip chip, or the source card's button — owner
   * direction, 2026-09-22): after a confirm, DELETE /api/drafts?ideaId=
   * discards the post's kept/candidate takes (lib/drafts.ts's
   * discardIdeaDrafts; the idea itself stays on Liked). On success the post
   * is dropped from `posts` at once and the strip refreshed; if it was the
   * one on screen, the page moves to the next post in progress, or to the
   * empty state when none is left. The local drop matters for that last
   * case: with the removed post still in `posts` until the refresh lands,
   * the pin-the-URL effect above would re-open it.
   */
  async function removePost(ideaId: string) {
    if (removingIdeaId) return;
    if (!window.confirm("Remove this post and its takes from Write? The idea stays in Liked.")) return;
    setRemovingIdeaId(ideaId);
    setActionError(null);
    try {
      const res = await fetch(`/api/drafts?ideaId=${ideaId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`remove ${res.status}`);
      setPosts((current) => current?.filter((p) => p.ideaId !== ideaId) ?? current);
      setPostsKey((k) => k + 1);
      if (ideaId === currentIdeaId) {
        const next = posts?.find((p) => p.ideaId !== null && p.ideaId !== ideaId)?.ideaId ?? null;
        router.replace(next ? `/create?ideaId=${next}` : "/create");
      }
    } catch (e) {
      console.error("failed to remove the post:", e);
      setActionError("Failed to remove this post.");
    } finally {
      setRemovingIdeaId(null);
    }
  }

  /** + New finished: the owner's text is an idea with a generation job — open it (its takes row shows Claude working). */
  function openNewPost(ideaId: string) {
    setComposerOpen(false);
    setPostsKey((k) => k + 1);
    router.push(`/create?ideaId=${ideaId}`);
  }

  /** The video transcript fallback (see takes-row.tsx's TranscriptForm): re-POST /api/videos with the pasted text, then poll. */
  async function submitTranscript(transcript: string) {
    if (!idea?.url) throw new Error("This idea has no video url.");
    const res = await fetch("/api/videos", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ url: idea.url, transcript }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, "Failed to submit the transcript."));
    reload();
  }

  if (!currentIdeaId) {
    if (posts === null) return <p className="text-sm text-text-dim">Loading…</p>;
    return (
      <div className="space-y-4">
        {postsError && <p className="text-sm text-danger">{postsError}</p>}
        <div className="flex items-start gap-3">
          <p className="text-sm text-text-dim">
            Nothing in progress: press Use on an idea in <Link href="/" className="underline hover:text-text">Find Ideas</Link>.
          </p>
          <ArchiveButton refreshKey={postsKey} className="ml-auto" />
        </div>
        <NewPostComposer onCreated={openNewPost} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <InProgressStrip
            chips={chips}
            currentIdeaId={currentIdeaId}
            removingIdeaId={removingIdeaId}
            onSelect={(id) => router.replace(`/create?ideaId=${id}`)}
            onRemove={removePost}
            onNew={() => setComposerOpen((open) => !open)}
            newOpen={composerOpen}
          />
        </div>
        <ArchiveButton refreshKey={postsKey} className="ml-auto" />
      </div>
      {composerOpen && <NewPostComposer onCreated={openNewPost} onCancel={() => setComposerOpen(false)} autoFocus />}
      {postsError && <p className="text-sm text-danger">{postsError}</p>}

      {idea === undefined && !ideasError && <p className="text-sm text-text-dim">Loading…</p>}
      {ideasError && <p className="text-sm text-danger">{ideasError}</p>}
      {idea === null && !ideasError && <p className="text-sm text-text-dim">This idea no longer exists.</p>}
      {idea && <SourceCard idea={idea} onRemove={() => removePost(idea.id)} removeBusy={removingIdeaId !== null} />}

      {loadError && <p className="text-sm text-danger">{loadError}</p>}
      {actionError && <p className="text-sm text-danger">{actionError}</p>}

      {/* A video's ready post has no takes: it's the chosen version from the start (lib/video-post.ts). */}
      {post && (idea || takes.length > 0) && !isVideoPost(idea) && (
        <TakesRow
          takes={takes}
          chosenId={chosen?.id ?? null}
          identity={identity}
          job={post.latestJob}
          transcriptFallback={idea?.kind === "youtube" && Boolean(idea.url)}
          pickBusy={pickBusy}
          moreBusy={moreBusy}
          moreDisabled={!idea}
          checkingId={checkingSlopId}
          onPick={(id) => { scrollToPicked.current = id; void pickTake(id); }}
          onMoreTakes={moreTakes}
          onSubmitTranscript={submitTranscript}
        />
      )}

      {post && chosen && (
        <PostEditor
          key={chosen.id}
          draft={chosen}
          chain={chain}
          voice={voice}
          tab={editorTab}
          onTab={(next) => { if (currentIdeaId) setEditorTabs((tabs) => ({ ...tabs, [currentIdeaId]: next })); }}
          onMutated={reload}
          onRefined={handleRefined}
          onPickVersion={pickTake}
        />
      )}
    </div>
  );
}

export default function WritePage() {
  return (
    <Suspense fallback={<div className="text-text-dim">Loading…</div>}>
      <WriteContent />
    </Suspense>
  );
}
