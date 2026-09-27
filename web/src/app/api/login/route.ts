import { z } from "zod";
import { getSession, safeEqual } from "@/lib/session";
import { makeRateLimiter } from "@/lib/rate-limit";

const allow = makeRateLimiter({ max: 5, windowMs: 60_000 });
const Body = z.object({ password: z.string().min(1) });

export async function POST(request: Request) {
  // Trust assumption: Vercel overwrites x-forwarded-for on the way in, so a
  // client cannot spoof it there. Self-hosters behind a different reverse
  // proxy must verify their proxy does the same before relying on this key.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (!allow(ip)) {
    return Response.json({ error: "too many attempts, wait a minute" }, { status: 429 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  if (!safeEqual(parsed.data.password, process.env.ADMIN_PASSWORD ?? "")) {
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  try {
    const session = await getSession();
    session.loggedIn = true;
    await session.save();
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json(
      { error: "server configuration error — check SESSION_SECRET (see server logs)" },
      { status: 500 },
    );
  }
}
