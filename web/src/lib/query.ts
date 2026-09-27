import type { Enriched } from "@/lib/enrich";

// Common English function words. Deliberately broad rather than minimal —
// this only ever discards candidate *query* terms, so over-including a rare
// borderline word costs nothing, while under-including lets noise words
// dominate the frequency ranking below.
const EN_STOPWORDS = [
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "cannot", "could", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "had",
  "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of",
  "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out",
  "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
  "yourself", "yourselves", "also", "like", "get", "got", "one", "two", "new",
  "via", "says", "said",
  // Generic "meta" vocabulary (review round 2): describes the act of
  // posting/thinking, or is filler, rather than ever being the actual
  // subject of a search. Deliberately doesn't touch nouns that can be a
  // real topic on their own (tools, audio, cloud, ...).
  "post", "posts", "thread", "check", "today", "thing", "things", "really",
  "make", "want", "need", "way", "lot", "time",
  // Narrative/bio filler (added beyond the review's literal list, to
  // actually clear its own "top-5 must include >=3 of {b2b, saas,
  // distribution, product, strategy}" bar on its LinkedIn-paragraph case —
  // "I've spent the last five years..." otherwise fills the top 5 with
  // spent/last/five/years ahead of the real topic nouns). "years"/"last"/
  // "spent" describe the shape of a career-bio sentence, not its subject;
  // "lesson(s)" announces content ("the lesson is...") rather than being
  // it — same spirit as "post"/"thread" above. "three".."ten" complete the
  // spelled-out-number exclusion the original one/two entries started.
  "spent", "last", "years", "year", "lesson", "lessons",
  "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  // Contraction/elision fragments (review round 2) that could otherwise
  // leak through as their own token if stripContraction() below ever
  // misses a case — a belt to its suspenders, not the primary mechanism.
  "don", "isn", "wasn", "couldn", "didn", "doesn", "hasn", "ve", "ll",
  // Instructions and hype (2026-09-24, live: "find interesting viral computer
  // use agents…" searched "use find interesting viral computer" and lost
  // "agents"): words that ask for a search or praise its results, never its
  // subject.
  "find", "finding", "search", "searching", "show", "showing", "look", "looking", "give", "list",
  "interesting", "viral", "cool", "best", "good", "great", "top", "amazing", "awesome",
  "trending", "popular", "latest", "recent", "example", "examples", "idea", "ideas", "people",
];

// Common Italian function words (articles, prepositions incl. articulated
// forms, conjunctions, pronouns, and the highest-frequency verb forms of
// essere/avere/stare/fare).
const IT_STOPWORDS = [
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "dello",
  "della", "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle",
  "da", "dal", "dallo", "dalla", "dai", "dagli", "dalle", "nel", "nello",
  "nella", "nei", "negli", "nelle", "con", "col", "coi", "su", "sul", "sullo",
  "sulla", "sui", "sugli", "sulle", "per", "tra", "fra", "e", "ed", "o", "od",
  "ma", "che", "chi", "cui", "non", "si", "come", "questo", "questa", "questi",
  "queste", "quello", "quella", "quelli", "quelle", "quel", "quei", "quegli",
  "sono", "sei", "è", "siamo", "siete", "essere", "stato", "stata", "stati",
  "state", "sto", "stai", "sta", "stiamo", "stanno", "ha", "hanno", "ho", "hai",
  "abbiamo", "avete", "avere", "fare", "fa", "fanno", "più", "meno", "molto",
  "poco", "tutto", "tutti", "tutta", "tutte", "anche", "pure", "quando", "dove",
  "perché", "perche", "cosa", "quale", "quali", "suo", "sua", "suoi", "sue",
  "mio", "mia", "miei", "mie", "tuo", "tua", "tuoi", "tue", "nostro", "nostra",
  "nostri", "nostre", "loro", "ci", "vi", "mi", "ti", "lui", "lei", "noi",
  "voi", "ne", "già", "ancora", "sempre", "mai", "oggi", "ieri", "domani",
  "qui", "qua", "li", "là", "cioè", "dunque", "quindi", "allora", "così",
  "ogni", "alcuni", "alcune", "altro", "altra", "altri", "altre",
  // Generic "meta" vocabulary (review round 2), mirroring the EN list above.
  "post", "vorrei", "pensando", "penso", "fatto", "cose", "nuovo", "nuova",
  // Elision-lead-in fragments (review round 2) — belt to stripContraction().
  "dell", "nell", "sull", "all", "dall", "coll", "quell",
  // Instructions and hype, Italian (2026-09-24 — see the English list).
  "trova", "trovami", "cerca", "cercami", "mostra", "mostrami", "interessante", "interessanti",
  "virale", "virali", "migliori", "migliore", "bello", "belli", "idee", "esempi", "persone",
];

const STOPWORDS = new Set([...EN_STOPWORDS, ...IT_STOPWORDS]);

// Short acronyms/initialisms that are real, high-value search terms despite
// being under MIN_TOKEN_LENGTH (review round 2) — without this list "ai"
// (2 chars) would be silently dropped by the length filter, which is wrong
// for a product built around AI-adjacent content. The 3+ letter ones are
// listed too even though they already clear the length bar, for clarity.
// "yc", "hn", "pm", "os" added 2026-09-27 (owner: "se scrivo harness batch
// YC, mi esce… solo" harness batch — YC was dropped).
const ACRONYM_ALLOWLIST = new Set([
  "ai", "ml", "ux", "ui", "vc", "ar", "vr", "3d", "yc", "hn", "pm", "os",
  "nlp", "llm", "api", "seo", "saas", "b2b", "b2c", "ceo", "cto", "cfo", "gpt",
]);

const MIN_TOKEN_LENGTH = 3;
const MAX_TERMS = 5;
const MAX_QUERY_LENGTH = 80;
// Rank bonuses (review round 2): a word the author bothered to hashtag or
// capitalize mid-sentence is a stronger signal of "this is the topic" than
// raw frequency alone — see tokenizeWithSalience().
const CAPITALIZED_BONUS = 2;
const HASHTAG_BONUS = 3;

const URL_RE = /https?:\/\/\S+/g;
// Punctuation strip: anything that isn't a Unicode letter, digit, or
// whitespace becomes empty. Applied per already-isolated word piece (see
// tokenizeWithSalience) rather than globally, so it can't merge two
// adjacent words when it removes an internal punctuation mark.
const NON_WORD_RE = /[^\p{L}\p{N}]/gu;

// Contractions collapsed entirely (review round 2) — the base left behind
// would just be a stopword-ish auxiliary/pronoun ("do", "is", "there", "i")
// with no search value of its own, so the whole token is dropped rather
// than reduced.
const CONTRACTION_DROP = new Set([
  "don't", "doesn't", "isn't", "wasn't", "can't", "won't",
  "i've", "i'm", "it's", "that's", "there's",
]);
// Italian elision: a short lead-in fused to the next word by an apostrophe
// (dell', sull', un', l', ...). The lead-in carries no search value, so it's
// dropped as a UNIT — this is what keeps "sull'automazione" from leaving a
// stray "sull" token behind the way a generic apostrophe→space strip would.
const IT_ELISION_RE = /^[a-zà-ù]{1,5}['’]/i;
// English possessive/contraction tail on a word NOT in CONTRACTION_DROP
// (e.g. "creator's", "we're") — keep the base, drop the tail.
const EN_CONTRACTION_TAIL_RE = /^([a-z]+)['’](t|s|re|ve|ll|d|m)$/i;

function cap(s: string): string {
  return s.slice(0, MAX_QUERY_LENGTH).trim();
}

// Alphanumeric-aware: "B2B"/"3D" are as much "all caps" as "AI"/"SEO" for
// this purpose, so digits are allowed as long as at least one letter is
// present (a pure number like "2026" must NOT count).
function isAllCaps(s: string): boolean {
  return /^[A-Z0-9]{2,}$/.test(s) && /[A-Z]/.test(s);
}
function isTitleCase(s: string): boolean {
  return /^[A-Z][a-z]/.test(s);
}

/** Resolves one raw word piece's elision/contraction, keeping its casing. */
function stripContraction(piece: string): string {
  const lower = piece.toLowerCase();
  if (CONTRACTION_DROP.has(lower)) return "";
  const delided = piece.replace(IT_ELISION_RE, "");
  const tailMatch = delided.match(EN_CONTRACTION_TAIL_RE);
  return tailMatch ? tailMatch[1] : delided;
}

// `acronym`: typed in capitals (YC, HN, EU…), so a short word is kept as a
// search term whatever its length (2026-09-27).
type Candidate = { word: string; bonus: number; acronym: boolean };

/**
 * Splits seed text into per-word salience candidates, preserving enough of
 * each raw word's original shape (casing, leading #, internal hyphens,
 * trailing sentence punctuation) to score it BEFORE the text is normalized
 * to lowercase for matching. Mentions and URLs are dropped entirely;
 * hyphenated compounds ("AI-Native") are split into their parts, each
 * scored on its own.
 */
function tokenizeWithSalience(seedText: string): Candidate[] {
  const withoutUrls = seedText.replace(URL_RE, " ");
  const rawWords = withoutUrls.split(/\s+/).filter(Boolean);

  const candidates: Candidate[] = [];
  // Sentence-initial capitalization is just English convention, not a
  // salience signal — only a Capitalized word appearing MID-sentence (or an
  // ALLCAPS one anywhere) earns the bonus below. A colon doesn't count as a
  // sentence end (it introduces a clause, e.g. a headline's subtitle).
  let sentenceStart = true;

  for (const raw of rawWords) {
    const endsSentence = /[.!?]+$/.test(raw);
    if (raw.startsWith("@")) {
      sentenceStart = endsSentence;
      continue;
    }

    const isHashtag = raw.startsWith("#");
    const body = isHashtag ? raw.slice(1) : raw;
    const pieces = body.split(/-+/).filter(Boolean);
    const wasSentenceStart = sentenceStart;
    sentenceStart = endsSentence;

    pieces.forEach((rawPiece, i) => {
      const cleaned = stripContraction(rawPiece).replace(NON_WORD_RE, "");
      if (!cleaned) return;

      // Only the FIRST piece of a raw word can plausibly be sentence-initial
      // — later hyphen-parts never are, regardless of the word's position.
      const atSentenceStart = wasSentenceStart && i === 0;
      let bonus = 0;
      if (isHashtag) {
        bonus = HASHTAG_BONUS;
      } else if (isAllCaps(cleaned) || (isTitleCase(cleaned) && !atSentenceStart)) {
        bonus = CAPITALIZED_BONUS;
      }

      candidates.push({ word: cleaned.toLowerCase(), bonus, acronym: isAllCaps(cleaned) });
    });
  }

  return candidates;
}

/**
 * Derives a short keyword query from free-form seed text (an X post, an
 * article title, or a raw idea) for the scout worker to search X with.
 * Pure and deterministic: same input always yields the same output.
 */
export function deriveQuery(seedText: string): string {
  const all = tokenizeWithSalience(seedText);
  // Acronym allow-listing is an unconditional bypass, not just of the length
  // floor: "ai" is also the Italian preposition "ai" ("to the", plural
  // masc.) in IT_STOPWORDS, so a length-only bypass would still lose it to
  // the stopword check. A word deliberately curated onto this short list is
  // a stronger signal than "happens to double as a common word", so it wins
  // outright.
  const candidates = all.filter(
    (t) => ACRONYM_ALLOWLIST.has(t.word) || t.acronym || (t.word.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t.word)),
  );

  if (candidates.length === 0) {
    // Nothing survived stopword/length filtering (e.g. an all-stopword
    // sentence) — fall back to the first few literal words, URLs aside, so a
    // query is still produced instead of an empty string.
    const rawWords = seedText.replace(URL_RE, " ").toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
    return cap(rawWords.join(" "));
  }

  const frequency = new Map<string, number>();
  const maxBonus = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  candidates.forEach((c, i) => {
    frequency.set(c.word, (frequency.get(c.word) ?? 0) + 1);
    maxBonus.set(c.word, Math.max(maxBonus.get(c.word) ?? 0, c.bonus));
    if (!firstIndex.has(c.word)) firstIndex.set(c.word, i);
  });
  const score = (w: string) => frequency.get(w)! + maxBonus.get(w)!;

  const ranked = [...frequency.keys()].sort((a, b) => {
    const byScore = score(b) - score(a);
    return byScore !== 0 ? byScore : firstIndex.get(a)! - firstIndex.get(b)!;
  });

  // The top MAX_TERMS by score, written in the order they appear in the text
  // (2026-09-24): the query reads like what was typed — "computer use
  // agents", not "use computer agents" — and a phrase stays together.
  const chosen = new Set(ranked.slice(0, MAX_TERMS));
  const inOrder = [...chosen].sort((a, b) => firstIndex.get(a)! - firstIndex.get(b)!);
  return cap(inOrder.join(" "));
}

// Below this, a variant is too short/broad to be worth searching a source
// with on its own (a lone 2-letter acronym like "ai" — see
// ACRONYM_ALLOWLIST — passes deriveQuery's own length floor but is still too
// noisy as a standalone keyword search).
const MIN_VARIANT_LENGTH = 3;

/**
 * Expands one seed into an ordered, deduped list of progressively narrower
 * search queries: the full derived query (deriveQuery's own ranked, ≤5-term
 * output), then its top-3 and top-2 terms, then each of its top-3 individual
 * terms — reusing deriveQuery's ranking rather than re-deriving it, since
 * deriveQuery is idempotent on an already-derived, space-joined term list
 * (no stopwords/URLs left to strip, no repeats/casing bonuses to re-score).
 *
 * Exists because a single derived query (all 5 terms AND-ed together, per
 * lib/sources/{bluesky,hackernews}.ts's keyword search engines) is often too
 * narrow to return anything — see scout-run.ts, which runs these variants
 * per source, in order, until it has enough candidates.
 */
export function queryVariants(seedText: string): string[] {
  const full = deriveQuery(seedText);
  if (!full) return [];

  const terms = full.split(" ");
  const raw = [full, terms.slice(0, 3).join(" "), terms.slice(0, 2).join(" "), ...terms.slice(0, 3)];

  const seen = new Set<string>();
  const variants: string[] = [];
  for (const v of raw) {
    if (v.length < MIN_VARIANT_LENGTH || seen.has(v)) continue;
    seen.add(v);
    variants.push(v);
  }
  return variants;
}

function isIdLikeSegment(s: string): boolean {
  return /^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s);
}

/**
 * URL-path fallback for a query: mines the last non-numeric/non-hash-like
 * path segment — the conventional home for a page's descriptive slug, e.g.
 * "/blog/the-future-of-remote-work" or "/blog/the-future-of-remote-work/12345"
 * (walking back past the trailing id) both yield "future remote work".
 * Used when `deriveQuery` on the seed text itself comes up empty — most
 * often a bare link with no enrichable title/content.
 */
export function queryFromUrlSlug(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }

  const segments = pathname.split("/").filter(Boolean);
  let slug = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!isIdLikeSegment(segments[i])) {
      slug = segments[i];
      break;
    }
  }

  // "ds.html" → "ds", not "ds html": a file extension is never a topic
  // (live, 2026-09-23: paulgraham.com/ds.html searched "html").
  const words = slug
    .replace(/\.(html?|php|aspx?|jsp|md|txt|xml)$/i, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .filter((w) => !isIdLikeSegment(w))
    // Same unconditional acronym bypass as deriveQuery — see its comment.
    .filter((w) => ACRONYM_ALLOWLIST.has(w) || (w.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(w)));

  return cap(words.slice(0, MAX_TERMS).join(" "));
}

/** Builds the seed text `deriveQuery` should run on, from an enriched URL. */
export function seedTextFromEnriched(e: Enriched, url: string): string {
  switch (e.kind) {
    case "x_post":
      return e.content ?? url;
    case "youtube":
      return [e.title, e.author].filter(Boolean).join(" — ") || url;
    default: // "article" | "note"
      return [e.title, e.content].filter(Boolean).join(" — ") || url;
  }
}
