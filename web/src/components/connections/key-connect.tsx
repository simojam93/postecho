"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/modal";
import type { KeyGuide } from "@/lib/connection-guides";
import { GuideSteps } from "./guide-steps";

/** GET /api/connections's row for one service: never the key, only where it lives. */
export type ConnectionStatus = { connected: boolean; via: "app" | "server" | null; hint: string | null };

const inputCls = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-text-dim";
const pillCls = "rounded-full border border-border px-4 py-2 text-sm text-text-dim hover:text-text disabled:opacity-50";
const primaryPillCls = "rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50";

/** Where the key lives, in words: pasted here, set on the server, or not yet. */
export function statusLine(status: ConnectionStatus | null): string {
  if (!status?.connected) return "Not connected yet.";
  const hint = status.hint ? ` · ${status.hint}` : "";
  return status.via === "server" ? `Connected on the server${hint}.` : `Connected${hint}.`;
}

/**
 * One service's connection (2026-09-26: "tutte le connessioni… semplicissime"):
 * what it adds and costs, the steps with their links, the fields, and Connect
 * — PUT /api/connections tests the key for real before keeping it. A key
 * pasted here can be taken out again; one on the server stays as it is.
 */
export function KeyConnectForm({ guide, status, onChanged }: {
  guide: KeyGuide;
  status: ConnectionStatus | null;
  /** The new status, after a connect or a removal. */
  onChanged: (status: ConnectionStatus) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const showFields = !status?.connected || replacing;

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: guide.id, values }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Couldn't connect it. Try again.");
        return;
      }
      setValues({});
      setReplacing(false);
      onChanged(body.status);
    } catch {
      setError("Network error: nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !window.confirm(`Remove the ${guide.name} key from PostEcho?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/connections?service=${guide.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError("Couldn't remove it. Try again."); return; }
      onChanged(body.status);
    } catch {
      setError("Network error: nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>{guide.what}</p>
        <p className="text-xs text-text-dim">{guide.cost}</p>
      </div>
      <p className={`flex items-center gap-2 text-sm ${status?.connected ? "text-ok" : "text-text-dim"}`}>
        <span aria-hidden>{status?.connected ? "●" : "○"}</span>
        {statusLine(status)}
      </p>
      {showFields ? (
        <form onSubmit={(e) => { e.preventDefault(); void connect(); }} className="space-y-4">
          <GuideSteps steps={guide.steps} />
          <div className="space-y-3">
            {guide.fields.map((field) => (
              <label key={field.name} className="block space-y-1.5">
                <span className="text-xs text-text-dim">{field.label}</span>
                <input
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.name] ?? ""}
                  onChange={(e) => { setValues((v) => ({ ...v, [field.name]: e.target.value })); setError(null); }}
                  placeholder={field.placeholder}
                  className={inputCls}
                />
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {replacing && <button type="button" onClick={() => setReplacing(false)} disabled={busy} className={pillCls}>Keep the current one</button>}
            <button type="submit" disabled={busy || guide.fields.some((f) => !(values[f.name] ?? "").trim())} className={primaryPillCls}>
              {busy ? "Checking…" : `Connect ${guide.name}`}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button type="button" onClick={() => setReplacing(true)} className="text-text-dim underline hover:text-text">Use a different key</button>
          {status?.via === "app" && (
            <button type="button" onClick={() => void remove()} disabled={busy} className="text-text-dim underline hover:text-danger">Remove the key</button>
          )}
          {error && <span className="text-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** KeyConnectForm in a window: Settings' Connect and Edit, and the welcome's Connect step. */
export function KeyConnectDialog({ guide, status, onChanged, onClose }: {
  guide: KeyGuide;
  status: ConnectionStatus | null;
  onChanged: (status: ConnectionStatus) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onRequestClose={onClose} width="34rem">
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">Connect {guide.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-sm text-text-dim hover:text-text">×</button>
        </div>
        <KeyConnectForm guide={guide} status={status} onChanged={(next) => { onChanged(next); if (next.connected) onClose(); }} />
      </div>
    </Modal>
  );
}
