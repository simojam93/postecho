import { db } from "@/db";
import { requireSession } from "@/lib/session";
import { sourceRows } from "@/lib/sources/status";

/**
 * Read-only adapter roster for the Settings page's "Sources" block: every
 * discovery adapter's machine name, display label (from the shared
 * sources/labels.ts map, so it matches the source pills/filter row
 * elsewhere in the app), whether it's currently enabled (`envReady` against
 * `process.env`), and which env var NAMES it needs — never the values
 * themselves, so this is safe to expose to the logged-in owner's own
 * browser without leaking secrets. See lib/sources/status.ts.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    return Response.json({ sources: await sourceRows(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
