/**
 * The owner's library (2026-09-24), kept in the settings store:
 *
 * - **Style inspiration** — posts by other people whose style the owner likes
 *   ("se vedo post interessanti in find ideas e voglio infilarmi nel mio tone
 *   of voice… anche se sono scritti da altri può aiutare a migliorare il mio
 *   stile in modo furbo"), added from Find Ideas. Analyze my posts borrows
 *   their structure and rhythm for the style guide, never their voice or
 *   content (agent/src/prompts.ts's styleGuidePrompt). Kept apart from the
 *   tone examples, which are the owner's own posts.
 * - **Reference material** — facts about the owner and their work that
 *   Claude may use ("un posto… dove ci posso mettere dei file miei personali
 *   dai quali claude può prendere per i suoi contenuti"): pasted text or the
 *   text of .txt/.md, PDF and Word (.docx) files, read in the browser
 *   (2026-09-26, lib/file-text.ts), each switchable, the enabled ones sent to
 *   the agent with its profile within REFERENCE_BUDGET_CHARS.
 */

export type StyleInspirationItem = {
  id: string;
  ideaId: string | null;
  text: string;
  author: string | null;
  url: string | null;
  kind: string;
  /** Jev's slopScore for the post when the card had one (lib/human-score.ts shows it as Human N/10). */
  slopScore: number | null;
  addedAt: string;
};

export type ReferenceItem = {
  id: string;
  name: string;
  text: string;
  enabled: boolean;
  addedAt: string;
};

export const STYLE_INSPIRATION_MAX = 40;
export const STYLE_INSPIRATION_TEXT_MAX = 2000;
/** How many inspiration posts, and how much of each, Analyze my posts reads. */
export const INSPIRATION_FOR_ANALYSIS = 12;
export const INSPIRATION_ANALYSIS_CHARS = 800;

export const REFERENCES_MAX = 20;
export const REFERENCE_NAME_MAX = 80;
export const REFERENCE_TEXT_MAX = 20000;
/** How much reference text, over all enabled items, goes into every generation. */
export const REFERENCE_BUDGET_CHARS = 12000;

/** The enabled references in order, within the budget: whole items while they fit, the last one cut. */
export function referencesForAgent(items: ReferenceItem[], budget = REFERENCE_BUDGET_CHARS): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  let left = budget;
  for (const item of items) {
    if (!item.enabled || !item.text.trim() || left <= 0) continue;
    const text = item.text.length > left ? `${item.text.slice(0, left)} …` : item.text;
    out.push({ name: item.name, text });
    left -= item.text.length;
  }
  return out;
}

/** The inspiration texts Analyze my posts reads: the newest first, bounded. */
export function inspirationForAnalysis(items: StyleInspirationItem[]): string[] {
  return items
    .filter((i) => i.text.trim())
    .slice(0, INSPIRATION_FOR_ANALYSIS)
    .map((i) => (i.text.length > INSPIRATION_ANALYSIS_CHARS ? `${i.text.slice(0, INSPIRATION_ANALYSIS_CHARS)} …` : i.text));
}

/** How many inspiration posts were added after the style guide was last analyzed (all of them, if never). */
export function inspirationSinceAnalysis(items: StyleInspirationItem[], analyzedAt: string | null): number {
  if (!analyzedAt) return items.length;
  const at = new Date(analyzedAt).getTime();
  return items.filter((i) => new Date(i.addedAt).getTime() > at).length;
}
