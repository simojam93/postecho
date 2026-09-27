import { PUBLISHERS, type Platform } from "./index";

/**
 * The due-post email (M3 plan, task P3): what the owner gets a few minutes
 * before a slot — one email even when X and LinkedIn share the slot, one
 * section per platform, each with the post text, a big "Post on …" button
 * and its own signed "Mark as posted" link. The button opens the row's
 * signed share page (app/post/[id], lib/publishers/index.ts's postPageUrl),
 * not the platform's composer: on the phone a composer URL from an email
 * lands in the mail app's browser (x.com logged out) or in the LinkedIn app
 * (which ignores the prefill) — owner test 2026-09-22 — while the page's
 * Share… puts the text in the platform's app through the native share
 * sheet, and keeps the composer links for a desktop. No composer URL
 * appears in the email at all. Dark and minimal, in the app's own
 * tokens (globals.css: #08080a ground, #f5f5f7 text, #7c7c86 dim), laid
 * out with tables and inline styles because mail clients strip <style>.
 * Times are shown in Europe/Rome — the app's one display zone.
 */

export type DueEmailItem = {
  platform: Platform;
  /** The frozen post text (scheduled_posts.text). */
  text: string;
  /** The row's signed share page (postPageUrl) — what the "Post on …" button opens. */
  pageUrl: string;
  markPostedUrl: string;
};

export type RenderedEmail = { subject: string; html: string; text: string };

export const EMAIL_TIME_ZONE = "Europe/Rome";
const SUBJECT_PREVIEW_CHARS = 40;

const BG = "#08080a";
const SURFACE = "#101013";
const BORDER = "#26262c";
const TEXT = "#f5f5f7";
const DIM = "#7c7c86";
const BUTTON_INK = "#0b0b0d";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The five characters that matter in HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Post text as HTML: escaped, newlines kept as <br> (the one line-break form every mail client honors). */
function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/**
 * "17:00" and "Tue 22 Sep, 17:00" for `date` on a wall clock in `timeZone`.
 * Composed from parts so locale punctuation can't creep in; en-US parts
 * because en-GB's ICU data spells September "Sept".
 */
function formatDue(date: Date, timeZone: string): { time: string; when: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  return { time, when: `${get("weekday")} ${get("day")} ${get("month")}, ${time}` };
}

/** The subject's quote of the post: whitespace collapsed, the first 40 characters, an ellipsis when cut. */
export function subjectPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUBJECT_PREVIEW_CHARS ? `${flat.slice(0, SUBJECT_PREVIEW_CHARS).trimEnd()}…` : flat;
}

function sectionHtml(item: DueEmailItem): string {
  const label = escapeHtml(PUBLISHERS[item.platform].label);
  return `
      <tr><td style="padding:0 0 32px;">
        <p style="margin:0 0 10px;font:13px ${FONT};color:${DIM};">${label}</p>
        <div style="border:1px solid ${BORDER};border-radius:12px;background:${SURFACE};padding:16px 18px;font:15px/1.5 ${FONT};color:${TEXT};word-break:break-word;">${textToHtml(item.text)}</div>
        <p style="margin:18px 0 0;"><a href="${escapeHtml(item.pageUrl)}" style="display:inline-block;background:${TEXT};color:${BUTTON_INK};text-decoration:none;font:600 16px ${FONT};padding:14px 28px;border-radius:999px;">Post on ${label}</a></p>
        <p style="margin:12px 0 0;font:13px ${FONT};"><a href="${escapeHtml(item.markPostedUrl)}" style="color:${DIM};text-decoration:underline;">Mark as posted</a></p>
      </td></tr>`;
}

function sectionText(item: DueEmailItem): string {
  const label = PUBLISHERS[item.platform].label;
  return [
    `── ${label} ──`,
    "",
    item.text,
    "",
    `Post on ${label}:`,
    item.pageUrl,
    "Mark as posted:",
    item.markPostedUrl,
  ].join("\n");
}

/**
 * Subject, HTML and plain text for the posts due at `dueAt`. Subject:
 * `Post at 17:00 · X + LinkedIn · "<first 40 chars>"` — the platform list
 * follows the items (in their order), the quote is the first item's text.
 * The plain-text part carries the same links, so a text-only client can
 * post too. Everything that came from the post is HTML-escaped.
 */
export function renderDueEmail(
  { items, dueAt, timeZone = EMAIL_TIME_ZONE }: { items: DueEmailItem[]; dueAt: Date; timeZone?: string },
): RenderedEmail {
  if (items.length === 0) throw new Error("renderDueEmail: nothing to send");

  const { time, when } = formatDue(dueAt, timeZone);
  const platforms = items.map((item) => PUBLISHERS[item.platform].label).join(" + ");
  const subject = `Post at ${time} · ${platforms} · "${subjectPreview(items[0].text)}"`;
  const footer = `Scheduled for ${when} (${timeZone}) · PostEcho`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};color:${TEXT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding:0 0 24px;font:13px ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${DIM};">PostEcho · post at ${escapeHtml(time)}</td></tr>${items.map(sectionHtml).join("")}
      <tr><td style="padding:24px 0 0;border-top:1px solid ${BORDER};font:12px ${FONT};color:${DIM};">${escapeHtml(footer)}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`;

  const text = [
    `Post at ${time} (${timeZone}) · ${platforms}`,
    "",
    ...items.map(sectionText).flatMap((section) => [section, ""]),
    footer,
    "",
  ].join("\n");

  return { subject, html, text };
}
