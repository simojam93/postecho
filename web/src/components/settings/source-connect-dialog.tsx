"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import { KeyConnectForm, type ConnectionStatus } from "@/components/connections/key-connect";
import { KEY_GUIDES } from "@/lib/connection-guides";
import { X_SOURCE_NAME } from "@/lib/sources/x";
import { XSourceSection, type XKeyStatus } from "./x-source-section";

/** One row of GET /api/sources (app/api/sources/route.ts). */
export type SourceRow = {
  name: string;
  label: string;
  /** Searched: its keys are there and the owner hasn't disconnected it. */
  enabled: boolean;
  /** Its keys are there (a keyless source always is). */
  ready: boolean;
  /** The owner disconnected it. */
  off: boolean;
  keyedBy: "none" | "server" | "owner";
  requiredEnv: string[];
};

const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

/**
 * Connect a source (owner, 2026-09-25: "if I have all of them disconnected I
 * should see a connect button that for each source opens a small popup
 * explaining me what to do to link it. Like it will be X for me, I shouldn't
 * see it if I am not clicking connect"). A public source has nothing to set
 * up; one keyed on the server connects when its keys are there, else the
 * window says what to add; X takes the owner's own key and budget here. Also
 * X's Edit, once connected.
 */
export function SourceConnectDialog({ source, xStatus, xPostsPerSearch, onXKeyChanged, connection, onKeysChanged, onConnect, onClose }: {
  source: SourceRow;
  xStatus: XKeyStatus | null;
  xPostsPerSearch: number;
  /** The X key was saved or removed — the panel re-reads its status and the list. */
  onXKeyChanged: () => Promise<void>;
  /** A keyed source's connection (GET /api/connections): where its key lives. */
  connection: ConnectionStatus | null;
  /** A key was connected or removed here (2026-09-26): the panel re-reads the list. */
  onKeysChanged: () => void;
  /** Connects it (and saves X's budget); resolves to an error message, or null. */
  onConnect: (extra?: { xPostsPerSearch?: number }) => Promise<string | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [posts, setPosts] = useState(xPostsPerSearch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isX = source.name === X_SOURCE_NAME;
  const guide = source.keyedBy === "server" ? KEY_GUIDES[source.name as keyof typeof KEY_GUIDES] : undefined;
  const editing = (isX || Boolean(guide)) && source.enabled;
  const canConnect = isX ? Boolean(xStatus?.connected) : source.ready;
  // X's Connect shows from the start, waiting for a saved key. A keyed source connects with its own
  // button in the guide, once the key passes; the footer's only turns a ready one back on.
  const showConnect = isX || (canConnect && !(guide && source.enabled));

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await onConnect(isX ? { xPostsPerSearch: posts } : undefined);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  let body: React.ReactNode;
  if (isX) {
    body = <XSourceSection status={xStatus} postsPerSearch={posts} onPostsPerSearch={setPosts} onKeyChanged={onXKeyChanged} />;
  } else if (source.keyedBy === "none") {
    body = <p className="text-sm text-text-dim">{source.label} is public: there&apos;s nothing to set up. Once connected, every search reads it again.</p>;
  } else if (guide) {
    // Step by step, with a real Connect (2026-09-26: "ogni collegamento… spiegato step by step").
    body = <KeyConnectForm guide={guide} status={connection} onChanged={(next) => { onKeysChanged(); if (next.connected && !source.enabled) onClose(); }} />;
  } else if (source.ready) {
    body = <p className="text-sm text-text-dim">{source.label} uses the account already set up on PostEcho&apos;s server. Once connected, every search reads it again.</p>;
  } else {
    body = <p className="text-sm text-text-dim">{source.label} needs its own keys: add {source.requiredEnv.join(" and ")} to the server&apos;s environment.</p>;
  }

  return (
    <Modal labelledBy={titleId} onRequestClose={() => { if (!busy) onClose(); }} width="32rem">
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">{editing ? source.label : `Connect ${source.label}`}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text disabled:opacity-50">
            ×
          </button>
        </div>
        {body}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <button type="button" onClick={onClose} disabled={busy} className={pillCls}>{showConnect ? "Cancel" : "Close"}</button>
          {showConnect && (
            <button type="button" onClick={() => void connect()} disabled={busy || !canConnect} className={primaryPillCls}>
              {busy ? "Saving…" : editing ? "Save" : `Connect ${source.label}`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
