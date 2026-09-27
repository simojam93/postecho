"use client";

import { useEffect, useState } from "react";
import { ClampedText } from "@/components/clamped-text";
import { extractText, FILE_ACCEPT, fileKind } from "@/lib/file-text";
import { REFERENCE_BUDGET_CHARS, REFERENCE_NAME_MAX, REFERENCE_TEXT_MAX, type ReferenceItem } from "@/lib/library";

const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Settings' **Reference material** (owner, 2026-09-23: "un posto che sia di
 * riferimento dove ci posso mettere dei file miei personali dai quali claude
 * può prendere per i suoi contenuti… non solo il tone of voice"): facts about
 * the owner and their work — bio, projects, numbers, case studies — pasted
 * or read in the browser from .txt/.md files, and from PDF and Word (.docx)
 * files too (2026-09-26: "PDF e Word nei Reference"; lib/file-text.ts). Only
 * the text is kept: the file itself is never uploaded. Each item can be
 * switched off; the enabled ones go to Claude with every generation, edit
 * and humanize, up to REFERENCE_BUDGET_CHARS in all, with the rule to keep
 * private details out of posts (agent/src/prompts.ts).
 */
export function ReferencesSection() {
  const [items, setItems] = useState<ReferenceItem[] | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every setState here happens after an await (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/references");
        if (!res.ok) throw new Error(`references ${res.status}`);
        const body = await res.json();
        if (!cancelled) setItems(body.items);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError("Couldn't load your reference material.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function request(method: "POST" | "PATCH" | "DELETE", body?: unknown, query = ""): Promise<void> {
    const res = await fetch(`/api/references${query}`, { method, headers: JSON_HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "Something went wrong.");
    setItems(data.items);
  }

  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request("POST", { name: name.trim() || "Note", text });
      setName("");
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add it.");
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setError(null);
    // A PDF or a Word file takes a moment: its reader loads the first time.
    const kind = fileKind(file.name, file.type);
    setReading(kind === "pdf" || kind === "docx");
    try {
      const content = await extractText(file);
      setText(content.slice(0, REFERENCE_TEXT_MAX));
      setName(file.name.replace(/\.[^.]+$/, "").slice(0, REFERENCE_NAME_MAX));
      if (content.length > REFERENCE_TEXT_MAX) setError(`Only the first ${REFERENCE_TEXT_MAX.toLocaleString("en")} characters are kept.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the file.");
    } finally {
      setReading(false);
    }
  }

  const enabledChars = (items ?? []).filter((i) => i.enabled).reduce((n, i) => n + i.text.length, 0);

  return (
    <section className="space-y-3">
      <p className="text-xs text-text-dim">
        Facts about you and your work that PostEcho can draw on: bio, projects, numbers, case studies. PostEcho reads the enabled ones
        with every post, up to {REFERENCE_BUDGET_CHARS.toLocaleString("en")} characters, and keeps private details out of posts
        unless a post is about them.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}
      {items === null && !error && <p className="text-sm text-text-dim">Loading…</p>}
      {items && items.length > 0 && (
        <>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(e) => void request("PATCH", { id: item.id, enabled: e.target.checked }).catch((err) => setError(String(err.message ?? err)))}
                  aria-label={`PostEcho can use ${item.name}`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">
                    {item.name} <span className="text-xs font-normal text-text-dim">· {item.text.length.toLocaleString("en")} characters</span>
                  </p>
                  <ClampedText lines={2} text={item.text} className="whitespace-pre-wrap break-words text-xs text-text-dim" />
                </div>
                <button type="button" onClick={() => void request("DELETE", undefined, `?id=${encodeURIComponent(item.id)}`).catch((err) => setError(String(err.message ?? err)))}
                  aria-label={`Remove ${item.name}`} data-tip="Remove this reference" className="px-1.5 text-text-dim hover:text-danger">
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className={`text-xs tabular-nums ${enabledChars > REFERENCE_BUDGET_CHARS ? "text-accent" : "text-text-dim"}`}>
            Enabled: {enabledChars.toLocaleString("en")} of {REFERENCE_BUDGET_CHARS.toLocaleString("en")} characters
            {enabledChars > REFERENCE_BUDGET_CHARS ? " — PostEcho reads them in order until the limit, so put the important ones first." : ""}
          </p>
        </>
      )}

      <div className="space-y-2 rounded-xl border border-dashed border-border p-3">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={REFERENCE_NAME_MAX} placeholder="Name, e.g. Bio, PostEcho, a case study"
          aria-label="Reference name" className={inputCls} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={REFERENCE_TEXT_MAX}
          placeholder="Paste the text, or pick a .txt, .md, .pdf or .docx file" aria-label="Reference text" className={inputCls} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className={`text-xs text-text-dim ${reading ? "cursor-wait" : "cursor-pointer hover:text-text"}`}>
            <span aria-live="polite">{reading ? "Reading the file…" : "Upload a file (.txt, .md, .pdf, .docx)"}</span>
            <input type="file" accept={FILE_ACCEPT} disabled={reading} className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
          </label>
          <button type="button" onClick={() => void add()} disabled={!text.trim() || busy || reading}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text disabled:opacity-50">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </section>
  );
}
