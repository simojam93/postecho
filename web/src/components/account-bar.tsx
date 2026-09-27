"use client";

import { useEffect, useState } from "react";
import { IDENTITY_CHANGED_EVENT } from "@/components/settings/settings-panel";
import { SettingsButton } from "@/components/settings/settings-provider";

/**
 * The foot of the sidebar, as in Claude (owner, 2026-09-27: "i settings mettili
 * in basso… in stile claude. lascia un avatar generico per ora e il cog a destra
 * per i settings, il dropdown a me non serve"): a generic avatar, the name from
 * Settings › Profile, and the cog. The name follows a save in Settings at once.
 */
export function AccountBar({ name: savedName }: { name: string }) {
  const [name, setName] = useState(savedName);

  useEffect(() => {
    const onSaved = (e: Event) => {
      const next = (e as CustomEvent<{ name?: unknown }>).detail?.name;
      if (typeof next === "string") setName(next);
    };
    window.addEventListener(IDENTITY_CHANGED_EVENT, onSaved);
    return () => window.removeEventListener(IDENTITY_CHANGED_EVENT, onSaved);
  }, []);

  return (
    <div className="flex items-center gap-2.5 border-t border-border px-1 pt-3">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-text-dim">
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5c.8-2.3 2.8-3.5 5-3.5s4.2 1.2 5 3.5" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium" data-tip={name.trim() || undefined}>{name.trim() || "You"}</span>
      <SettingsButton className="shrink-0" />
    </div>
  );
}
