"use client";

import { useState } from "react";
import { handlesIn, isXHandle, splitHandles, tagSearchUrl, xProfileUrl } from "@/lib/x-handles";

const linkCls = "underline decoration-border underline-offset-2 hover:text-text";

export type TextSelection = { start: number; end: number };

/** A text's @handles as links to their X profiles — the takes row's previews. */
export function LinkedHandles({ text }: { text: string }) {
  return (
    <>
      {splitHandles(text).map((part, i) =>
        "handle" in part ? (
          <a key={i} href={xProfileUrl(part.handle)} target="_blank" rel="noopener noreferrer" className="text-text underline decoration-border underline-offset-2 hover:decoration-text">
            @{part.handle}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ))}
    </>
  );
}

/** The trimmed selection, when it looks like a name: one line, 2–60 characters. */
export function selectedName(text: string, selection: TextSelection | null): (TextSelection & { name: string }) | null {
  if (!selection || selection.end <= selection.start) return null;
  let { start, end } = selection;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const name = text.slice(start, end);
  if (name.length < 2 || name.length > 60 || name.includes("\n")) return null;
  return { start, end, name };
}

/** The text with the selected name replaced by `@handle`. */
export function tagSelection(text: string, at: TextSelection, handle: string): string {
  return `${text.slice(0, at.start)}@${handle}${text.slice(at.end)}`;
}

/**
 * Tags, checked by the owner (2026-09-24: "diretto con hyperlink che se le
 * clicco posso controllarle", and, free, "quando seleziono un nome cerca su
 * google quel nome con X o linkedin"). Under a platform's text: every @handle
 * it tags (X) as a link to the profile, and — once a name is selected in the
 * text — a Google search for it on X or LinkedIn, opened in the owner's own
 * browser (nothing is fetched here), plus, on X, a field to put its @handle
 * in the name's place. LinkedIn tags are picked in LinkedIn's own editor.
 */
export function TagTools({ platform, text, selection, onTag }: {
  platform: "x" | "linkedin";
  text: string;
  selection: TextSelection | null;
  /** X only: the text with the selected name replaced by its @handle. */
  onTag?: (next: string) => void;
}) {
  const handles = platform === "x" ? handlesIn(text) : [];
  const selected = selectedName(text, selection);
  // Only once there's something to show: the hint to select a name went (2026-09-27, "in casinato").
  if (handles.length === 0 && !selected) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-dim">
      {handles.length > 0 && (
        <span className="flex flex-wrap items-center gap-x-2">
          <span>Tagged</span>
          {handles.map((handle) => (
            <a key={handle} href={xProfileUrl(handle)} target="_blank" rel="noopener noreferrer" className={linkCls} data-tip={`Check @${handle} on X`}>
              @{handle} ↗
            </a>
          ))}
        </span>
      )}
      {selected && (
        <SelectedName
          key={`${selected.start}:${selected.name}`}
          name={selected.name}
          onTag={onTag ? (handle) => onTag(tagSelection(text, selected, handle)) : undefined}
        />
      )}
    </div>
  );
}

function SelectedName({ name, onTag }: { name: string; onTag?: (handle: string) => void }) {
  const [handle, setHandle] = useState("");
  const clean = handle.trim().replace(/^@/, "");
  const valid = isXHandle(clean);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="max-w-48 truncate">Find “{name}” on</span>
      <a href={tagSearchUrl(name, "x")} target="_blank" rel="noopener noreferrer" className={linkCls}>X ↗</a>
      <a href={tagSearchUrl(name, "linkedin")} target="_blank" rel="noopener noreferrer" className={linkCls}>LinkedIn ↗</a>
      {onTag && (
        <form onSubmit={(e) => { e.preventDefault(); if (valid) onTag(clean); }} className="flex items-center gap-1">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@handle"
            aria-label={`X handle for ${name}`}
            spellCheck={false}
            className="w-28 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-text outline-none focus:border-text-dim"
          />
          <button type="submit" disabled={!valid} className="rounded-full border border-border px-2.5 py-0.5 hover:text-text disabled:opacity-50">
            Tag
          </button>
        </form>
      )}
    </span>
  );
}
