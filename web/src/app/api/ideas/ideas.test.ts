import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import { ideas } from "@/db/schema";

const state: { db: Awaited<ReturnType<typeof createTestDb>> | null } = { db: null };
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig()),
  requireSession: vi.fn(async () => null),
}));

process.env.CAPTURE_TOKEN = "cap-token";

const fakeEnrich = { kind: "x_post", title: "t", content: "c", author: "a", meta: {} };
vi.mock("@/lib/enrich", async (orig) => ({
  ...(await orig()),
  enrich: vi.fn(async () => fakeEnrich),
}));

const { POST, GET } = await import("@/app/api/ideas/route");
const { PATCH } = await import("@/app/api/ideas/[id]/route");

function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test/api/ideas", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  state.db = await createTestDb();
  // The bearer-token path in authorized() correctly never calls requireSession()
  // when the token matches (see self-review focus: it must not consume a session
  // check), so a mockResolvedValueOnce queued by one test can go unconsumed and
  // leak into the next test's call. Reset the queue/default before every test.
  const { requireSession } = await import("@/lib/session");
  const mock = requireSession as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  mock.mockResolvedValue(null);
});

afterEach(() => {
  // Restores CAPTURE_TOKEN (and anything else) stubbed with vi.stubEnv below.
  vi.unstubAllEnvs();
});

describe("POST /api/ideas", () => {
  it("creates an enriched idea from a url (session path)", async () => {
    const res = await POST(req("POST", { url: "https://x.com/a/status/1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.kind).toBe("x_post");
    expect(body.idea.author).toBe("a");
  });

  it("accepts a bearer capture token instead of a session", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await POST(req("POST", { url: "https://x.com/a/status/2" }, { Authorization: "Bearer cap-token" }));
    expect(res.status).toBe(201);
  });

  it("rejects when neither session nor valid token", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await POST(req("POST", { url: "https://x.com/a/status/3" }, { Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("creates a note from free text", async () => {
    const res = await POST(req("POST", { text: "post about latency" }));
    const body = await res.json();
    expect(body.idea.kind).toBe("note");
    expect(body.idea.content).toBe("post about latency");
  });
});

describe("scout-aware capture (bearer only)", () => {
  it("accepts source and meta on a bearer POST, merging with enrichment meta (score/topic survive)", async () => {
    const res = await POST(
      req(
        "POST",
        { url: "https://x.com/a/status/10", source: "scout", meta: { score: 87, topic: "ai audio" } },
        { Authorization: "Bearer cap-token" },
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.source).toBe("scout");
    expect(body.idea.meta.score).toBe(87);
    expect(body.idea.meta.topic).toBe("ai audio");

    // Persisted, not just echoed back — and merged with whatever the (mocked)
    // real enrich() shape returns, per the `{...enriched.meta, ...bodyMeta}`
    // contract: enrich() never produces score/topic today, so this also
    // pins that those two keys survive the merge rather than relying on a
    // contrived mock that happens to agree with the body.
    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("scout");
    expect((rows[0].meta as { score?: number; topic?: string }).score).toBe(87);
    expect((rows[0].meta as { score?: number; topic?: string }).topic).toBe("ai audio");
  });

  it("rejects source on a session-authenticated request (only the bearer token may claim scout provenance)", async () => {
    const res = await POST(req("POST", { url: "https://x.com/a/status/11", source: "scout" }));
    expect(res.status).toBe(400);
  });

  it("rejects meta on a session-authenticated request even without source", async () => {
    const res = await POST(req("POST", { url: "https://x.com/a/status/12", meta: { score: 50 } }));
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range score even on the bearer path", async () => {
    const res = await POST(
      req(
        "POST",
        { url: "https://x.com/a/status/13", source: "scout", meta: { score: 101 } },
        { Authorization: "Bearer cap-token" },
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("url dedupe (onConflictDoNothing)", () => {
  it("returns the existing row with existing:true when the same url is captured twice (bearer then session)", async () => {
    const first = await POST(
      req("POST", { url: "https://x.com/a/status/dup" }, { Authorization: "Bearer cap-token" }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await POST(req("POST", { url: "https://x.com/a/status/dup" }));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.existing).toBe(true);
    expect(secondBody.idea.id).toBe(firstBody.idea.id);

    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(1);
  });

  it("leaves two different urls unaffected (201 each)", async () => {
    const a = await POST(req("POST", { url: "https://x.com/a/status/diff-a" }));
    const b = await POST(req("POST", { url: "https://x.com/a/status/diff-b" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const rows = await state.db!.select().from(ideas);
    expect(rows).toHaveLength(2);
  });
});

describe("GET /api/ideas", () => {
  it("filters by kind", async () => {
    await POST(req("POST", { url: "https://x.com/a/status/1" }));
    await POST(req("POST", { text: "note" }));
    const res = await GET(new Request("http://test/api/ideas?kind=x_post"));
    const body = await res.json();
    expect(body.ideas).toHaveLength(1);
    expect(body.ideas[0].kind).toBe("x_post");
  });

  it("rejects an invalid kind filter", async () => {
    const res = await GET(new Request("http://test/api/ideas?kind=DROP"));
    expect(res.status).toBe(400);
  });

  // Regression: KindFilter is derived from db/schema.ts's ideaKind enum
  // specifically so a future added kind (like these two, added for the
  // M1.5 scout) doesn't have to be hand-duplicated here to be filterable.
  it("accepts the M1.5 scout idea kinds as valid filters", async () => {
    for (const kind of ["bluesky", "hackernews"]) {
      const res = await GET(new Request(`http://test/api/ideas?kind=${kind}`));
      expect(res.status).toBe(200);
    }
  });
});

describe("PATCH /api/ideas/:id", () => {
  it("updates status", async () => {
    const created = await (await POST(req("POST", { text: "n" }))).json();
    const res = await PATCH(
      new Request("http://test/api/ideas/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
      { params: Promise.resolve({ id: created.idea.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).idea.status).toBe("dismissed");
  });

  // ♥ keep (M1.5 search-results UX round) — "kept" is a valid PATCH target
  // distinct from "used", and toggling back to "new" (heart clicked again)
  // is the existing, already-valid "new" status.
  it("accepts 'kept' as a status, and toggling back to 'new'", async () => {
    const created = await (await POST(req("POST", { text: "n" }))).json();
    const kept = await PATCH(
      new Request("http://test/api/ideas/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "kept" }),
      }),
      { params: Promise.resolve({ id: created.idea.id }) },
    );
    expect(kept.status).toBe(200);
    expect((await kept.json()).idea.status).toBe("kept");

    const unkept = await PATCH(
      new Request("http://test/api/ideas/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "new" }),
      }),
      { params: Promise.resolve({ id: created.idea.id }) },
    );
    expect(unkept.status).toBe(200);
    expect((await unkept.json()).idea.status).toBe("new");
  });

  // Pinning current behavior per review: validation order and status codes.
  it("returns 404 for a non-uuid id", async () => {
    const res = await PATCH(
      new Request("http://test/api/ideas/not-a-uuid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a well-formed uuid that doesn't exist", async () => {
    const res = await PATCH(
      new Request("http://test/api/ideas/00000000-0000-0000-0000-000000000000", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid status value", async () => {
    const created = await (await POST(req("POST", { text: "n" }))).json();
    const res = await PATCH(
      new Request("http://test/api/ideas/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "not-a-real-status" }),
      }),
      { params: Promise.resolve({ id: created.idea.id }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("capture token scope (review regression)", () => {
  it("POST session-gates without throwing when a bearer is sent but CAPTURE_TOKEN is unset/empty", async () => {
    vi.stubEnv("CAPTURE_TOKEN", "");
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    // Must not throw (e.g. from safeEqual on an empty CAPTURE_TOKEN) and must
    // fall through to the session check rather than silently authorizing.
    const res = await POST(req("POST", { url: "https://x.com/a/status/9" }, { Authorization: "Bearer anything" }));
    expect(res.status).toBe(401);
  });

  it("GET with a valid capture token but no session still returns 401", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await GET(new Request("http://test/api/ideas", {
      headers: { Authorization: "Bearer cap-token" },
    }));
    expect(res.status).toBe(401);
  });

  it("PATCH with a valid capture token but no session still returns 401", async () => {
    const { requireSession } = await import("@/lib/session");
    (requireSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const res = await PATCH(
      new Request("http://test/api/ideas/00000000-0000-0000-0000-000000000000", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer cap-token" },
        body: JSON.stringify({ status: "dismissed" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });
});
