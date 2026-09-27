"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useHintSeen } from "@/components/onboarding/tab-hints";
import { SettingsPanel, type SettingsTab } from "./settings-panel";
import { SettingsTour } from "./settings-tour";

/**
 * Settings as a window over any page (owner, 2026-09-25: "un cog… che se lo
 * clicchi ti apre i settings… un pop up"). The authed layout wraps the app in
 * this provider; the cog (at the foot of the sidebar since 2026-09-27, by the
 * logo on a phone) and any "Settings" link open the window at a tab.
 * /settings still shows the same panel as a page.
 */
const SettingsContext = createContext<{ open: (tab?: SettingsTab) => void; suggestion: boolean } | null>(null);

export function SettingsProvider({ suggestion: waiting = false, children }: {
  /** A suggested style guide update is waiting in Voice (lib/style-learning.ts): the cog shows a dot and opens there. */
  suggestion?: boolean;
  children?: ReactNode;
}) {
  // The window's state: the tab it opens at. The first time the cog is clicked, the tour
  // comes first, a page per tab (2026-09-27: "lo vorrei come quello ad ingresso app").
  const [opened, setOpened] = useState<{ tab: SettingsTab } | null>(null);
  const [touring, setTouring] = useState(false);
  const [suggestion, setSuggestion] = useState(waiting);
  const { unseen, markSeen } = useHintSeen("settings");
  const value = useMemo(() => ({
    open: (next?: SettingsTab) => {
      if (!next && unseen) {
        markSeen();
        setTouring(true);
        return;
      }
      setOpened({ tab: next ?? (suggestion ? "voice" : "profile") });
    },
    suggestion,
  }), [unseen, markSeen, suggestion]);
  return (
    <SettingsContext.Provider value={value}>
      {children}
      {touring && <SettingsTour onDone={() => { setTouring(false); setOpened({ tab: suggestion ? "voice" : "profile" }); }} />}
      {opened && (
        <SettingsPanel key={opened.tab} mode="modal" initialTab={opened.tab}
          onClose={() => setOpened(null)} onStyleProposalSettled={() => setSuggestion(false)} />
      )}
    </SettingsContext.Provider>
  );
}

/**
 * The gear, in the style of Apple's gearshape (owner, 2026-09-27: "mi cambi
 * anche il cog… tipo in stile apple"): eight teeth with rounded corners on a
 * 20×20 box, sampled from a smooth radius profile (tip radius 8.6, root 6.4).
 */
const GEAR_PATH = "M10 1.4L10.3 1.4L10.7 1.4L11 1.5L11.3 2.1L11.3 3.4L11.5 3.8L11.7 3.8L12 3.9L12.2 4L12.4 4.1L12.7 4.2L12.9 4.3L13.1 4.4L13.3 4.5L13.7 4.4L14.7 3.5L15.3 3.2L15.6 3.5L15.8 3.7L16.1 3.9L16.3 4.2L16.5 4.4L16.8 4.7L16.5 5.3L15.6 6.3L15.5 6.7L15.6 6.9L15.7 7.1L15.8 7.3L15.9 7.6L16 7.8L16.1 8L16.2 8.3L16.2 8.5L16.6 8.7L17.9 8.7L18.5 9L18.6 9.3L18.6 9.7L18.6 10L18.6 10.3L18.6 10.7L18.5 11L17.9 11.3L16.6 11.3L16.2 11.5L16.2 11.7L16.1 12L16 12.2L15.9 12.4L15.8 12.7L15.7 12.9L15.6 13.1L15.5 13.3L15.6 13.7L16.5 14.7L16.8 15.3L16.5 15.6L16.3 15.8L16.1 16.1L15.8 16.3L15.6 16.5L15.3 16.8L14.7 16.5L13.7 15.6L13.3 15.5L13.1 15.6L12.9 15.7L12.7 15.8L12.4 15.9L12.2 16L12 16.1L11.7 16.2L11.5 16.2L11.3 16.6L11.3 17.9L11 18.5L10.7 18.6L10.3 18.6L10 18.6L9.7 18.6L9.3 18.6L9 18.5L8.7 17.9L8.7 16.6L8.5 16.2L8.3 16.2L8 16.1L7.8 16L7.6 15.9L7.3 15.8L7.1 15.7L6.9 15.6L6.7 15.5L6.3 15.6L5.3 16.5L4.7 16.8L4.4 16.5L4.2 16.3L3.9 16.1L3.7 15.8L3.5 15.6L3.2 15.3L3.5 14.7L4.4 13.7L4.5 13.3L4.4 13.1L4.3 12.9L4.2 12.7L4.1 12.4L4 12.2L3.9 12L3.8 11.7L3.8 11.5L3.4 11.3L2.1 11.3L1.5 11L1.4 10.7L1.4 10.3L1.4 10L1.4 9.7L1.4 9.3L1.5 9L2.1 8.7L3.4 8.7L3.8 8.5L3.8 8.3L3.9 8L4 7.8L4.1 7.6L4.2 7.3L4.3 7.1L4.4 6.9L4.5 6.7L4.4 6.3L3.5 5.3L3.2 4.7L3.5 4.4L3.7 4.2L3.9 3.9L4.2 3.7L4.4 3.5L4.7 3.2L5.3 3.5L6.3 4.4L6.7 4.5L6.9 4.4L7.1 4.3L7.3 4.2L7.6 4.1L7.8 4L8 3.9L8.3 3.8L8.5 3.8L8.7 3.4L8.7 2.1L9 1.5L9.3 1.4L9.7 1.4Z";

/** The cog: opens Settings. A round button, like the one in Apple's apps; a dot when a suggestion waits. */
export function SettingsButton({ className = "" }: { className?: string }) {
  const settings = useContext(SettingsContext);
  const suggestion = settings?.suggestion ?? false;
  return (
    <button type="button" onClick={() => settings?.open()} aria-haspopup="dialog"
      aria-label={suggestion ? "Settings, a suggested update to your style guide is waiting" : "Settings"}
      data-tip={suggestion ? "Settings: a suggested update to your style guide is waiting" : "Settings"}
      className={`relative grid h-8 w-8 place-items-center rounded-full border border-border bg-surface-2 text-text-dim hover:border-text-dim hover:text-text ${className}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d={GEAR_PATH} />
        <circle cx="10" cy="10" r="2.8" />
      </svg>
      {suggestion && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" />}
    </button>
  );
}

/** A "Settings" link inside the app: opens the window at `tab`; the /settings page outside the provider. */
export function SettingsLink({ tab, className = "", tip, children }: {
  tab?: SettingsTab;
  className?: string;
  /** The app's tooltip (components/tooltip-layer.tsx). */
  tip?: string;
  children?: ReactNode;
}) {
  const settings = useContext(SettingsContext);
  if (!settings) return <Link href="/settings" className={className} data-tip={tip}>{children}</Link>;
  return <button type="button" onClick={() => settings.open(tab)} className={className} data-tip={tip}>{children}</button>;
}
