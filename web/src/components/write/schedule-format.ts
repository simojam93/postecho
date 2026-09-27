/**
 * Pure time/URL helpers for the Write page's Schedule and Post now actions
 * (M3 plan, P1) — no React, no fetch, unit-tested in schedule-format.test.ts.
 * Two clocks meet here: the app displays Europe/Rome (spec: "timezone
 * handled once — Europe/Rome display, UTC storage"), while an
 * <input type="datetime-local"> can only speak the BROWSER's local wall
 * clock. The two helpers below that touch the input therefore use the
 * browser zone (so a value round-trips to the same instant), and the labels
 * use Rome. For the owner in Rome they coincide.
 */

export const TIME_ZONE = "Europe/Rome";
const DAY_MS = 86_400_000;
/** A slot this far ahead (or less) is labeled by weekday alone; beyond it the date is spelled out. */
const WEEKDAY_ONLY_WINDOW_MS = 6 * DAY_MS;

const romeParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, hourCycle: "h23",
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

/**
 * "Tue 17:00" (Europe/Rome) for a slot within the coming six days of `now`,
 * else "Tue 14 Oct 17:00" — the chips and the "Scheduled: X · Tue 17:00"
 * line. Composed from parts, not `format()`, so locale punctuation can't
 * creep in.
 */
export function formatRomeSlot(iso: string, now: Date | string): string {
  const at = new Date(iso);
  const parts = romeParts.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  const distance = at.getTime() - new Date(now).getTime();
  if (distance >= -DAY_MS && distance <= WEEKDAY_ONLY_WINDOW_MS) return `${get("weekday")} ${time}`;
  return `${get("weekday")} ${get("day")} ${get("month")} ${time}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The datetime-local value ("YYYY-MM-DDTHH:mm", browser-local wall clock) showing the instant `iso`. */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The instant (UTC ISO) a datetime-local value denotes in the browser's zone; null when empty or malformed. */
export function fromDatetimeLocal(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  // A date-time string with no offset is parsed as LOCAL time per ECMA-262 —
  // exactly what the input meant.
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** X's official web intent — the only way this app ever posts to X (spec §6.3, no automation). */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
