"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { TabIcon, type SettingsTab } from "./settings-panel";

const pillCls = "rounded-full border border-border px-4 py-2 text-sm font-medium text-text-dim hover:text-text";
const primaryPillCls = "rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink";

/** A page for each Settings tab that needs explaining (Profile doesn't: owner, 2026-09-27), in the tabs' order. */
export const TOUR_PAGES: Array<{ tab: SettingsTab; title: string; text: string }> = [
  { tab: "voice", title: "Voice: how you write", text: "Paste a few of your best posts and PostEcho writes like you. The style guide is yours to edit, and PostEcho suggests updates to it from the takes you keep." },
  { tab: "references", title: "References: facts about you", text: "Add files about you and your work, PDF or Word. PostEcho uses what's in them and never invents beyond it." },
  { tab: "sources", title: "Sources: where ideas come from", text: "Connect the sites PostEcho searches, and put the kinds of post you want to see first on top." },
  { tab: "agent", title: "AI tools: who writes, who picks", text: "Claude on your Mac writes your takes, on your own plan. Jev picks the posts worth your time and checks how human a text reads." },
];

/** A page of the tour, pure so it's tested without the window. */
export function TourPage({ index, titleId }: { index: number; titleId: string }) {
  const page = TOUR_PAGES[index]!;
  return (
    <div className="space-y-4">
      <span aria-hidden className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-surface-2 text-text [&_svg]:h-5 [&_svg]:w-5">
        <TabIcon id={page.tab} />
      </span>
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">{page.title}</h2>
        <p className="text-sm text-text-dim">{page.text}</p>
      </div>
    </div>
  );
}

/**
 * The first time the cog is clicked, before Settings opens (owner,
 * 2026-09-27: "lo vorrei come quello ad ingresso app, prima volta che clicco
 * i settings mi escono delle pagine che mi spiegano tab per tab cosa fa",
 * then "valutiamo solo dove serve"): a page for each tab that needs it, like
 * the welcome's. Done or skipped, Settings opens.
 */
export function SettingsTour({ onDone }: { onDone: () => void }) {
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const last = index === TOUR_PAGES.length - 1;
  return (
    <Modal labelledBy={titleId} onRequestClose={onDone} width="32rem">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between gap-3 text-xs text-text-dim">
          <span>Settings · {index + 1} of {TOUR_PAGES.length}</span>
          <button type="button" onClick={onDone} className="underline hover:text-text">Skip</button>
        </div>
        <TourPage index={index} titleId={titleId} />
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          {index > 0 && <button type="button" onClick={() => setIndex(index - 1)} className={pillCls}>Back</button>}
          {last
            ? <button type="button" onClick={onDone} className={primaryPillCls}>Open Settings</button>
            : <button type="button" onClick={() => setIndex(index + 1)} className={primaryPillCls}>Next</button>}
        </div>
      </div>
    </Modal>
  );
}
