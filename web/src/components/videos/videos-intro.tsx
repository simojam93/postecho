"use client";

import { useId } from "react";
import { Modal } from "@/components/modal";

/**
 * What Videos does, the first time its tab is clicked (owner, 2026-09-27:
 * "la prima volta che ci clicco sopra deve uscire un pop up di una sola
 * finestra che me lo spiega"). One window, then never again (kv seenHints
 * "videos"; the welcome, shown again, brings it back).
 */
export function VideosIntro({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onRequestClose={onClose} width="30rem">
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <h2 id={titleId} className="text-lg font-semibold">Video posts</h2>
          <p className="text-sm text-text-dim">
            Paste a YouTube link and PostEcho reads the whole video, then writes 12 X posts from it, in your voice and as your own ideas, the best for you first.
            Press Use on one to edit and schedule it in Write.
          </p>
        </div>
        <div className="flex justify-end border-t border-border pt-4">
          <button type="button" onClick={onClose} className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-ink">Got it</button>
        </div>
      </div>
    </Modal>
  );
}
