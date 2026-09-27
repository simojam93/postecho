import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { formatRomeSlot, TIME_ZONE } from "@/components/write/schedule-format";
import { PUBLISHERS, verifyMarkPostedSig } from "@/lib/publishers";
import { loadSharePageRow } from "@/lib/publishers/run";
import { ShareActions } from "./share-actions";
import { BrandMark } from "@/components/brand-mark";

export const metadata: Metadata = {
  title: "PostEcho — post",
  // A signed link, not a page anyone should find: keep it out of indexes.
  robots: { index: false, follow: false },
};

// The platform pill as components/plan/schedule-card.tsx spells it (that
// module is a client component, so the class string is copied, not imported).
const platformPillCls =
  "shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-dim";

/**
 * /post/[id]?sig=… — the share page the due-post email's "Post on X" /
 * "Post on LinkedIn" button opens (M3 plan P3, revised after the owner's
 * iPhone test of 2026-09-22: a composer URL straight from the email fails
 * on the phone, a native share sheet from a page of ours works). Public on
 * purpose (proxy.ts): it is opened from the mail app with no session, and
 * the signature in the link is the gate — the same HMAC that signs the
 * "Mark as posted" link (lib/publishers/index.ts's postPageUrl /
 * verifyMarkPostedSig). A missing or forged signature, a malformed id and
 * an unknown id all answer the same 404: nothing here confirms which ids
 * exist. The page shows this one row and nothing else — no navigation, no
 * other posts — and only the columns loadSharePageRow hands over.
 */
export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sig?: string | string[] }>;
}) {
  const { id } = await params;
  const { sig: rawSig } = await searchParams;
  const sig = (Array.isArray(rawSig) ? rawSig[0] : rawSig) ?? "";
  if (!z.uuid().safeParse(id).success || !verifyMarkPostedSig(id, sig)) notFound();

  const post = await loadSharePageRow(db, id);
  if (!post) notFound();

  const label = PUBLISHERS[post.platform].label;
  const when = formatRomeSlot(post.publishAt.toISOString(), new Date());
  const done = post.status === "posted_manually" || post.status === "published";
  const canceled = post.status === "canceled";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-text-dim">
          <BrandMark className="h-3 w-auto text-text-dim" />
          PostEcho
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {done ? "Marked as posted ✓" : canceled ? "Canceled" : `Post on ${label}`}
        </h1>
        <p className="flex items-center gap-2 text-sm text-text-dim">
          <span className={platformPillCls}>{label}</span>
          <span>
            {when} · {TIME_ZONE}
          </span>
        </p>
      </header>

      <div className="rounded-xl border border-border bg-surface p-4 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
        {post.text}
      </div>

      {done ? (
        <p className="text-sm text-text-dim">This post is in your Calendar. You can close this tab.</p>
      ) : canceled ? (
        <p className="text-sm text-text-dim">This post was canceled in your Calendar, so there is nothing to share here.</p>
      ) : (
        <ShareActions id={id} sig={sig} platform={post.platform} text={post.text} />
      )}
    </main>
  );
}
