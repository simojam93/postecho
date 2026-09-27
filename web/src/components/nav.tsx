"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Turning, WorkingStyle } from "@/components/work-progress";
import { refreshWork, serverWorkSnapshot, subscribeWork, workSnapshot, type WorkMark, type WorkTab } from "@/components/work-status";

// Each with the app's tooltip: what the tab is for, in a sentence (2026-09-27).
const tabs: Array<{ href: string; label: string; tip: string; work?: WorkTab }> = [
  { href: "/", label: "Find Ideas", tip: "Find posts worth reacting to", work: "find" },
  // The AI slop tab went on 2026-09-27 ("di base voglio che AI slop venga
  // messo qui"): a text pasted in Write gets its human score at once, and
  // its Humanize loop lives in jev-judge.
  { href: "/create", label: "Write", tip: "Turn an idea into a post", work: "write" },
  // Calendar, named Plan until 2026-09-27 ("più che plan la chiamerei calendar").
  { href: "/calendar", label: "Calendar", tip: "Your posts by date" },
  // Settings: the cog at the foot of the sidebar opens them as a window, and
  // Sign out lives at their bottom left (2026-09-27).
];

/** A tab working, and then done for a moment (components/work-status.ts): the turning glyph, then a green ✓, or a red ! when it failed. */
function WorkIndicator({ mark }: { mark: WorkMark | null }) {
  if (mark === "running") {
    return <span role="img" aria-label="Working" className="flex"><WorkingStyle /><Turning /></span>;
  }
  if (mark === "done") return <span role="img" aria-label="Done" className="w-3 text-center text-ok">✓</span>;
  if (mark === "failed") return <span role="img" aria-label="Failed" className="w-3 text-center text-danger">!</span>;
  return null;
}

export function Nav() {
  const pathname = usePathname();
  const work = useSyncExternalStore(subscribeWork, workSnapshot, serverWorkSnapshot);
  // What's running, read again on every tab change and whenever the window comes back into focus.
  useEffect(() => { void refreshWork(); }, [pathname]);
  useEffect(() => {
    const onFocus = () => { void refreshWork(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return (
    // The tabs can be wider than a phone: the row scrolls sideways there (no page scroll), and stacks from md up.
    <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] md:mx-0 md:flex-col md:overflow-visible md:px-0">
      {tabs.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            data-tip={t.tip}
            className={`flex shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium ${
              active ? "bg-surface-2 text-text" : "text-text-dim hover:text-text"
            }`}
          >
            {t.label}
            {t.work && <WorkIndicator mark={work[t.work]} />}
          </Link>
        );
      })}
    </nav>
  );
}
