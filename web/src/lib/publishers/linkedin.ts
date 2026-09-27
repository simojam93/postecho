/**
 * LinkedIn publisher (M3 plan, task P3 — owner decision 2026-09-22: no
 * developer app or Company Page, human-in-the-loop like X). The composer
 * prefill is LinkedIn's public feed URL with `shareActive=true&text=`: it
 * opens the share box with the text already in it — a URL, not an API.
 * Should LinkedIn ever drop the parameter, the box simply opens empty and
 * the text is right there in the email. Pure module (no server imports):
 * components/write/post-editor.tsx imports it for Post now → LinkedIn.
 * Automatic publishing through the official API stays possible later
 * behind the same Publisher shape (plan P4, deferred).
 */

export const LINKEDIN_COMPOSER_URL = "https://www.linkedin.com/feed/?shareActive=true&text=";

/** LinkedIn's composer, prefilled with `text`. */
export function composerUrl(text: string): string {
  return LINKEDIN_COMPOSER_URL + encodeURIComponent(text);
}
