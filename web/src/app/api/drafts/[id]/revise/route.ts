import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { drafts, ideas, jobs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { voiceOfIdea, type Voice } from "@/lib/voice";
import { withXAuthor } from "@/lib/x-handles";

// The source an edit is written against: the idea's full read when there is one, bounded.
const SOURCE_MAX_CHARS = 8000;
// How far up the version chain the conversation reaches.
const HISTORY_MAX = 8;

/** The requests that produced the versions above `draft`, oldest first — the chat's context. */
async function historyOf(draft: typeof drafts.$inferSelect): Promise<string[]> {
  const history: string[] = [];
  let current = draft;
  for (let hop = 0; hop < HISTORY_MAX; hop++) {
    const instruction = current.meta.instruction;
    if (typeof instruction === "string" && instruction.trim()) history.unshift(instruction);
    if (!current.parentId) break;
    const [parent] = await db.select().from(drafts).where(eq(drafts.id, current.parentId)).limit(1);
    if (!parent) break;
    current = parent;
  }
  return history;
}

const Body = z.object({
  instruction: z.string().min(1).max(500),
  // Write's Humanize (M3.6): run the agent's Claude <-> Jev loop on this
  // platform's text. The instruction still goes along, so an agent that
  // predates the loop falls back to a one-shot humanize.
  humanize: z.enum(["x", "linkedin"]).optional(),
  // Write's Edit with Claude (M3.7): the kind of request, the voice to switch
  // to (mode "voice" only) and the words the thread shows for it.
  mode: z.enum(["custom", "humanize", "sync_linkedin", "sync_x", "voice"]).optional(),
  voice: z.enum(["mine", "reaction"]).optional(),
  label: z.string().trim().min(1).max(120).optional(),
}).strict();

/**
 * POST /api/drafts/:id/revise
 *
 * The Create tab's "Refine" box: enqueues a `revise_draft` job carrying the
 * draft's CURRENT text (not the request body — the agent needs to see what
 * it's revising) plus the owner's free-text instruction ("punchier",
 * "shorter hook"). materialize.ts (task A3) turns the result into a new
 * draft with `parentId` pointing back at this one and `status: "kept"`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });

  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
    if (!draft) return Response.json({ error: "not found" }, { status: 404 });

    const { humanize, mode, label } = parsed.data;
    if (humanize && !(humanize === "x" ? draft.xText : draft.linkedinText)?.trim()) {
      return Response.json({ error: "nothing to humanize on that platform" }, { status: 400 });
    }
    if (mode === "sync_linkedin" && !draft.xText?.trim()) {
      return Response.json({ error: "there is no X text to write LinkedIn from" }, { status: 400 });
    }
    if (mode === "sync_x" && !draft.linkedinText?.trim()) {
      return Response.json({ error: "there is no LinkedIn text to write X from" }, { status: 400 });
    }
    if (mode === "voice" && !parsed.data.voice) {
      return Response.json({ error: "a voice switch needs the voice to switch to" }, { status: 400 });
    }

    // Edit with Claude: the source the post came from, its voice and the
    // conversation so far. A voice switch is remembered on the idea, so later
    // takes and edits keep it.
    let extra: Record<string, unknown> = {};
    if (mode) {
      const [idea] = draft.ideaId ? await db.select().from(ideas).where(eq(ideas.id, draft.ideaId)).limit(1) : [];
      let voice: Voice = parsed.data.voice ?? voiceOfIdea(idea ?? null, draft.meta.voice);
      if (idea && mode === "voice" && parsed.data.voice) {
        voice = parsed.data.voice;
        await db.update(ideas).set({ meta: { ...idea.meta, voice } }).where(eq(ideas.id, idea.id));
      }
      const deepRead = idea && typeof idea.meta.deepReadText === "string" ? idea.meta.deepReadText : null;
      const raw = deepRead ?? idea?.content ?? idea?.title ?? idea?.url ?? null;
      const source = raw && idea ? withXAuthor(raw, idea) : raw;
      extra = {
        mode,
        voice,
        sourceText: source ? source.slice(0, SOURCE_MAX_CHARS) : null,
        history: await historyOf(draft),
        ...(label ? { label } : {}),
      };
    }

    const [job] = await db.insert(jobs).values({
      kind: "revise_draft",
      payload: {
        draftId: draft.id,
        xText: draft.xText,
        linkedinText: draft.linkedinText,
        instruction: parsed.data.instruction,
        ...(humanize ? { humanize } : {}),
        ...extra,
      },
    }).returning();

    return Response.json({ job }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
