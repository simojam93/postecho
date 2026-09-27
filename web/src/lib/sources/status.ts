import type { db as Db } from "@/db";
import { envReady } from "@/lib/sources/adapter";
import { ALL_ADAPTERS } from "@/lib/sources/all";
import { sourceLabel } from "@/lib/sources/labels";
import { getSetting } from "@/lib/settings";
import { X_SOURCE_NAME } from "@/lib/sources/x";
import { scoutEnv } from "@/lib/x-config";

/** One discovery source as Settings and the welcome show it: never a key's value, only whether it's there. */
export type SourceRow = {
  name: string;
  label: string;
  /** Searched: its keys are there and the owner hasn't disconnected it. */
  enabled: boolean;
  /** Its keys are there (a keyless source always is). */
  ready: boolean;
  /** The owner disconnected it. */
  off: boolean;
  /** Who holds its key: nobody needs one, the server's env, or the owner in Settings (X). */
  keyedBy: "none" | "server" | "owner";
  /** The env var NAMES it needs. */
  requiredEnv: string[];
};

/**
 * Every discovery adapter with its state (moved out of GET /api/sources on
 * 2026-09-26, so the welcome's "What's connected" reads the same rows): the
 * same env the scout runs with — X is on once a key is saved in Settings.
 */
export async function sourceRows(db: typeof Db): Promise<SourceRow[]> {
  const [env, disabled] = await Promise.all([scoutEnv(db), getSetting(db as never, "disabledSources")]);
  const off = new Set(disabled);
  // X first (owner, 2026-09-27: "X mettimelo prima in ordine nelle sources"), then the scout's order.
  const listed = [...ALL_ADAPTERS.filter((a) => a.name === X_SOURCE_NAME), ...ALL_ADAPTERS.filter((a) => a.name !== X_SOURCE_NAME)];
  return listed.map((adapter) => {
    const ready = envReady(adapter, env);
    return {
      name: adapter.name,
      label: sourceLabel(adapter.name).label,
      enabled: ready && !off.has(adapter.name),
      ready,
      off: off.has(adapter.name),
      keyedBy: !adapter.requiredEnv?.length ? "none" : adapter.name === X_SOURCE_NAME ? "owner" : "server",
      requiredEnv: adapter.requiredEnv ?? [],
    };
  });
}
