import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { requireSession } from "@/lib/session";

/**
 * A new status, and for a From a repo source (kind "repo") its ☆: `favorite` is kept in
 * `meta.favorite`, which sorts it first among the chips (2026-10-10).
 */
const Body = z.object({
  status: z.enum(["new", "used", "archived", "dismissed", "kept"]).optional(),
  favorite: z.boolean().optional(),
}).refine((b) => b.status !== undefined || b.favorite !== undefined);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  const Uuid = z.uuid().safeParse(id);
  if (!Uuid.success) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const { status, favorite } = parsed.data;
    let meta: Record<string, unknown> | undefined;
    if (favorite !== undefined) {
      const [current] = await db.select({ kind: ideas.kind, meta: ideas.meta }).from(ideas).where(eq(ideas.id, id));
      if (!current) return Response.json({ error: "not found" }, { status: 404 });
      if (current.kind !== "repo") return Response.json({ error: "bad request" }, { status: 400 });
      meta = { ...current.meta, favorite };
    }
    const [idea] = await db.update(ideas).set({ ...(status ? { status } : {}), ...(meta ? { meta } : {}) }).where(eq(ideas.id, id)).returning();
    if (!idea) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ idea });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
