import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ideas } from "@/db/schema";
import { requireSession } from "@/lib/session";

const Body = z.object({ status: z.enum(["new", "used", "archived", "dismissed", "kept"]) });

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
    const [idea] = await db.update(ideas).set({ status: parsed.data.status }).where(eq(ideas.id, id)).returning();
    if (!idea) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ idea });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
