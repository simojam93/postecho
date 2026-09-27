import { PlanView } from "@/components/plan/plan-view";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar (named Plan until 2026-09-27 — owner: "più che plan la chiamerei
 * calendar… che faccia capire che lì controlli solo la situa con le date";
 * /plan redirects here, next.config.ts; M3 plan, task P5): the Europe/Rome month calendar of what is
 * queued, emailed, posted by hand, or failed, with the selected day's free
 * slots and posts — all of it in components/plan/plan-view.tsx, a client
 * component; this page only mounts it inside the authed layout. `?day=`
 * (YYYY-MM-DD, Rome) opens that day.
 */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ day?: string | string[] }> }) {
  const { day } = await searchParams;
  const initialDay = typeof day === "string" && DAY.test(day) ? day : undefined;
  return <PlanView initialDay={initialDay} />;
}
