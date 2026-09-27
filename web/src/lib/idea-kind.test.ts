import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JevClient } from "jev-judge";
import { createTestDb } from "@/test/db";
import { drafts, ideas } from "@/db/schema";
import { backfillIdeaKind } from "@/lib/idea-kind";

function jev(choice: string) {
  const systemOne = vi.fn(async () => ({ answers: { kind_0: { choice } } }));
  return { client: { systemOne } as JevClient, systemOne };
}

describe("the kind of an idea rated before kinds existed (2026-09-26)", () => {
  it("is asked of Jev once and kept in meta", async () => {
    const db = await createTestDb();
    const [idea] = await db.insert(ideas).values({ kind: "hackernews", title: "How I got to $46k a month", content: "a story", meta: { rank: 74 } }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "post", status: "used" }).returning();
    const { client, systemOne } = jev("story");
    await backfillIdeaKind(db as never, draft.id, client);
    const [row] = await db.select().from(ideas).where(eq(ideas.id, idea.id));
    expect(row.meta).toMatchObject({ rank: 74, postKind: "story", kindFit: 1 });
    await backfillIdeaKind(db as never, draft.id, client);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("leaves YouTube ideas and drafts without an idea alone, and survives a failed call", async () => {
    const db = await createTestDb();
    const [video] = await db.insert(ideas).values({ kind: "youtube", title: "a video", content: "t" }).returning();
    const [fromVideo] = await db.insert(drafts).values({ ideaId: video.id, xText: "p", status: "used" }).returning();
    const [loose] = await db.insert(drafts).values({ xText: "p", status: "used" }).returning();
    const { client, systemOne } = jev("story");
    await backfillIdeaKind(db as never, fromVideo.id, client);
    await backfillIdeaKind(db as never, loose.id, client);
    expect(systemOne).not.toHaveBeenCalled();

    const [idea] = await db.insert(ideas).values({ kind: "devto", content: "text" }).returning();
    const [draft] = await db.insert(drafts).values({ ideaId: idea.id, xText: "p", status: "used" }).returning();
    const failing = { systemOne: vi.fn(async () => { throw new Error("jev down"); }) } as unknown as JevClient;
    await expect(backfillIdeaKind(db as never, draft.id, failing)).resolves.toBeUndefined();
  });
});
