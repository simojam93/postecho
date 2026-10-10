import Link from "next/link";

/** The line Compose shows after Add to queue (schedule in a row, 2026-10-10): the post is in Schedule's queue. */
export function QueuedNotice() {
  return (
    <p role="status" className="text-sm text-ok">
      ✓ In the queue · <Link href="/calendar" className="underline hover:text-text">See it in Schedule</Link>
    </p>
  );
}
