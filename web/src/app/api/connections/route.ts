import { z } from "zod";
import { db } from "@/db";
import { connectionStatuses, isServiceId, removeServiceKeys, saveServiceKeys, SERVICES, testService, type ServiceId } from "@/lib/connections";
import { requireSession } from "@/lib/session";
import { getSetting, setSetting } from "@/lib/settings";

const Body = z.object({
  service: z.string(),
  values: z.record(z.string(), z.string().max(600)),
}).strict();

/** Sources that come back on for searches once their key is connected (adapter names). */
const SOURCE_SERVICES = new Set<ServiceId>(["bluesky", "youtube", "producthunt"]);

/**
 * GET /api/connections — whether each service is connected, and where its
 * key lives (pasted in the app, or on the server), never the key itself
 * (lib/connections.ts, 2026-09-26).
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  try {
    return Response.json({ services: await connectionStatuses(db) });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * PUT /api/connections { service, values } — the Connect button: every field
 * the service needs, tested for real first (testService), then kept sealed.
 * 400 with what to fix when the test fails: nothing is kept then. A source
 * connected this way comes back on for searches. `{ status }`.
 */
export async function PUT(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isServiceId(parsed.data.service)) return Response.json({ error: "bad request" }, { status: 400 });
  const service = parsed.data.service;
  const values: Record<string, string> = {};
  for (const name of SERVICES[service].env) {
    const value = parsed.data.values[name]?.trim();
    if (!value) return Response.json({ error: "Fill in every field." }, { status: 400 });
    values[name] = value;
  }
  try {
    const problem = await testService(service, values);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    await saveServiceKeys(db, service, values);
    if (SOURCE_SERVICES.has(service)) {
      const disabled = await getSetting(db as never, "disabledSources");
      if (disabled.includes(service)) await setSetting(db as never, "disabledSources", disabled.filter((n) => n !== service));
    }
    return Response.json({ status: (await connectionStatuses(db))[service] });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/** DELETE /api/connections?service= — takes the key pasted in the app back out (a key on the server applies again). `{ status }`. */
export async function DELETE(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const service = new URL(request.url).searchParams.get("service");
  if (!isServiceId(service)) return Response.json({ error: "bad request" }, { status: 400 });
  try {
    await removeServiceKeys(db, service);
    return Response.json({ status: (await connectionStatuses(db))[service] });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
