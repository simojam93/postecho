import type { Metadata } from "next";
import { ConfirmButton } from "./confirm-button";
import { BrandMark } from "@/components/brand-mark";

export const metadata: Metadata = { title: "PostEcho — mark as posted" };

/**
 * /mark-posted — where the email's "Mark as posted" link lands, via
 * GET /api/mark-posted (which only checks the signature and 302s here with
 * id+sig). Public on purpose (listed in proxy.ts): it's opened on the phone
 * with no session. With id+sig it shows ONE confirm button that POSTs the
 * change — a GET must never be the thing that records a post, since mail
 * clients prefetch links. `?ok=1` (older links) shows the done state;
 * nothing at all — someone typed the URL — a neutral note.
 */
export default async function MarkPostedPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string | string[]; id?: string | string[]; sig?: string | string[] }>;
}) {
  const { ok, id, sig } = await searchParams;
  const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const done = ok === "1";
  const confirmable = single(id) !== "" && single(sig) !== "";

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-3">
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-text-dim">
          <BrandMark className="h-3 w-auto text-text-dim" />
          PostEcho
        </p>
        {done ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Marked as posted ✓</h1>
            <p className="text-sm text-text-dim">You can close this tab.</p>
          </>
        ) : confirmable ? (
          <ConfirmButton id={single(id)} sig={single(sig)} />
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Nothing to mark</h1>
            <p className="text-sm text-text-dim">
              Open the “Mark as posted” link from your PostEcho email to record a post here.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
