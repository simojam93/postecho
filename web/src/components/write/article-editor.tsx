"use client";

import { useState } from "react";
import { YOUR_POST_ID } from "./post-editor";
import type { Draft } from "./types";

/** Where X writes articles: no app can post or schedule one there, so the owner pastes it in. */
export const X_ARTICLES_URL = "https://x.com/compose/articles";
/** The agent's limits for an article (agent/src/schemas.ts), and the drafts PATCH route's. */
const TITLE_MAX = 100;
const TEXT_MAX = 12000;
const JSON_HEADERS = { "Content-Type": "application/json" };
const COPIED_SHOWN_MS = 1500;

const fieldCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";

/** An X article (posts from a repo, 2026-10-10): a draft with an article title, even an emptied one. */
export function isArticle(draft: Pick<Draft, "articleTitle">): boolean {
  return draft.articleTitle !== null && draft.articleTitle !== undefined;
}

/** What Copy puts on the clipboard: the title, a blank line, the body. */
export function articleClipboard(title: string, text: string): string {
  return `${title.trim()}\n\n${text.trim()}`;
}

/**
 * The article in Write (spec 2026-10-10): its title and body, saved when the owner clicks away
 * (PATCH /api/drafts/:id), then Copy and Open X Articles, since X has no way for an app to post
 * one. Edit with Claude stays on X and LinkedIn posts: revise_draft rewrites those two texts only.
 */
export function ArticleEditor({ draft, onMutated }: {
  draft: Draft;
  /** A field changed in place: the page refetches. */
  onMutated: () => void;
}) {
  const [title, setTitle] = useState(draft.articleTitle ?? "");
  const [text, setText] = useState(draft.articleText ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = title !== (draft.articleTitle ?? "") || text !== (draft.articleText ?? "");

  async function patchDraft(fields: Record<string, unknown>, { notify = true } = {}): Promise<boolean> {
    const body = dirty ? { articleTitle: title, articleText: text, ...fields } : fields;
    if (Object.keys(body).length === 0) return true;
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (!res.ok) { setSaveError("Failed to save."); return false; }
      setSaveError(null);
      if (notify) onMutated();
      return true;
    } catch {
      setSaveError("network error");
      return false;
    }
  }

  function copy() {
    void navigator.clipboard?.writeText(articleClipboard(title, text)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_SHOWN_MS);
    }).catch(() => setCopied(false));
    void patchDraft({}, { notify: false });
  }

  async function discard() {
    if (busy) return;
    setBusy(true);
    try {
      await patchDraft({ status: "discarded" });
    } finally {
      setBusy(false);
    }
  }

  const empty = !title.trim() && !text.trim();

  return (
    <section id={YOUR_POST_ID} aria-label="Your article" className="flex scroll-mt-6 flex-col gap-4">
      <h2 className="text-sm font-medium text-text-dim">Your article</h2>
      <div className="space-y-1.5">
        <input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (dirty) void patchDraft({}); }}
          aria-label="Article title" className={`${fieldCls} font-semibold`} />
        <textarea value={text} maxLength={TEXT_MAX} onChange={(e) => setText(e.target.value)} onBlur={() => { if (dirty) void patchDraft({}); }}
          rows={24} aria-label="Article text" className={`${fieldCls} leading-relaxed`} />
      </div>

      {(dirty || saveError) && (
        <p className={`text-xs ${saveError ? "text-danger" : "text-text-dim"}`}>
          {saveError ?? "Unsaved — saves when you click away"}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button type="button" onClick={() => void discard()} disabled={busy}
          className="rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:border-danger hover:text-danger disabled:opacity-50">
          Discard
        </button>
        <button type="button" onClick={copy} disabled={empty} data-tip="The title, then the text" className={`ml-auto ${pillCls}`}>
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={X_ARTICLES_URL} target="_blank" rel="noreferrer" onClick={() => void patchDraft({}, { notify: false })}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink">
          Open X Articles
        </a>
      </div>
    </section>
  );
}
