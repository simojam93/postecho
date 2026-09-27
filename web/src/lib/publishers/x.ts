/**
 * X publisher (M3 plan, task P3). Human-in-the-loop by design — spec §6.3:
 * X is never automated, no unofficial API, no browser driving. The only
 * artifact is the official web intent, which opens x.com's composer with
 * the text prefilled; the owner presses Post there. Pure module (no server
 * imports) so client code may use it too.
 */

/** X's hard per-post limit — mirrors lib/schedule.ts's X_LIMIT, counted the same way (string length). */
export const X_LIMIT = 280;
export const X_INTENT_URL = "https://x.com/intent/post?text=";

/** The official intent URL for `text`; refuses text X itself would refuse (> 280 characters). */
export function composerUrl(text: string): string {
  if (text.length > X_LIMIT) {
    throw new RangeError(`X text is ${text.length} characters — the limit is ${X_LIMIT}`);
  }
  return X_INTENT_URL + encodeURIComponent(text);
}
