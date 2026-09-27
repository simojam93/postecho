import { classifyUrl, decodeEntities, isPrivateHost, stripTags } from "@/lib/enrich";
import type { Fetcher } from "@/lib/sources/types";

/**
 * Deep read at Use time (owner, 2026-09-23: "questo post se lo uso mi prende
 * solo il titolo o anche tutto quello che abbiamo dentro?" — it was the
 * title). A scouted card carries what its source API gave the scout: for a
 * Hacker News or Lobsters story that links to an article, that is the title
 * alone; for a Bluesky/Mastodon post, the post text with a link in it. The
 * agent never opens a URL, so Claude was writing a "reaction" to a headline.
 *
 * `deepRead` runs inside POST /api/drafts/from-idea, right before the job is
 * enqueued, and gathers in one to two requests what a person would read
 * before reacting:
 *   - the **discussion** for Hacker News (Algolia items API, one request:
 *     story text, the external link, the comment tree) and Lobsters
 *     (`/s/<id>.json`): the most-discussed / best-scored top-level comments,
 *     clamped — a thread's replies are often worth more than the article;
 *   - the **article** the story or post links to: a readable extract of the
 *     page (prefers <article>, then <main>, then the body; scripts, nav,
 *     header/footer stripped), a couple of thousand characters, cut at a
 *     sentence.
 * The result is one composed text (title, link, post text, article extract,
 * discussion highlights) that becomes the job's `seedText`, is written back
 * to `ideas.content` so the card and Write's source card show what Claude
 * actually read, and is marked in `meta.deepReadAt` so it's done once.
 *
 * Best effort by design: any failing request is noted, never fatal — the
 * route falls back to today's title-plus-link behaviour when nothing could
 * be gathered. Reads are bounded (per-request timeout, size caps) and the
 * article fetch goes through the same string-only SSRF guard as
 * lib/enrich.ts, since the URL comes from third-party content.
 */

/** Content at least this long is rich enough to skip the read (an arXiv abstract, a Dev.to body). */
export const RICH_CONTENT_CHARS = 1200;

// Sources with a discussion the read can pull (both have a one-request JSON API).
const DISCUSSION_KINDS = new Set(["hackernews", "lobsters"]);
// Sources whose card may link to an article worth reading in full.
const LINK_KINDS = new Set(["article", "x_post", "bluesky", "mastodon", "lemmy", "devto"]);

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_CHARS = 1_500_000;
const ARTICLE_MAX_CHARS = 2500;
/** When clamping, back up to a sentence end only if that keeps at least this share of the cap. */
const SENTENCE_CUT_MIN_SHARE = 0.7;
/** A region shorter than this (a stub <article>, a JS shell) isn't the article — try the next region. */
const ARTICLE_MIN_CHARS = 200;
const STORY_TEXT_MAX_CHARS = 2000;
/** The card summary's length (owner, 2026-09-23: "un mini summary di cosa c'è dentro"). */
const CARD_SUMMARY_CHARS = 280;
/** The card summary opens at the first line that reads like prose: at least this long, with sentence punctuation. */
const SUMMARY_PROSE_MIN_CHARS = 60;
// A short line with a year, or one starting like a byline/crumb, is chrome above the article: "Jun 22, 2022 • Written by…", "By Ada", "← All posts".
const CHROME_LINE = /^(←|by\b|written by\b|posted\b|published\b|updated\b|\d{1,2}\s+min(ute)?s?\s+read\b)|\b(19|20)\d{2}\b/i;
const MAX_COMMENTS = 5;
const COMMENT_MAX_CHARS = 400;
const TITLE_MAX_CHARS = 160;

// Post pages on these hosts are never "the article".
const SOCIAL_HOSTS = /(^|\.)(bsky\.app|x\.com|twitter\.com|news\.ycombinator\.com|lobste\.rs|youtube\.com|youtu\.be)$/i;

export type DeepReadIdea = {
  kind: string;
  url: string | null;
  title: string | null;
  content: string | null;
  meta: Record<string, unknown>;
};

export type DeepReadPart = "article" | "discussion";

export type DeepReadOptions = {
  /** Per-request timeout; the default suits a single Use, the scout passes a shorter one for its batch of card summaries. */
  timeoutMs?: number;
};

export type DeepRead = {
  /** The composed source text for the job — stored on the idea as `meta.deepReadText`. */
  text: string;
  /** The story's title as the read found it (API, og:title) or the card's own first line. */
  title: string;
  /** One paragraph for the card: the article's opening, else the post's own text, else the top comment. Null when the read gave no prose. */
  summary: string | null;
  /** The external article the story/post links to, when one was read. */
  articleUrl: string | null;
  /** The discussion page, when comments were read. */
  discussionUrl: string | null;
  parts: DeepReadPart[];
  /** What could not be gathered, for logs — never shown as an error. */
  notes: string[];
};

type Comment = { author: string | null; text: string };
type Discussion = {
  name: string;
  url: string;
  title: string | null;
  articleUrl: string | null;
  /** The submission's own text (Ask HN / text-only Lobsters), in full within the cap. */
  storyText: string | null;
  comments: Comment[];
};
type Article = { url: string; title: string | null; excerpt: string };

const defaultFetcher: Fetcher = (url, init) =>
  fetch(url, {
    ...init,
    headers: { "User-Agent": "PostEchoBot/1.0", Accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...(init?.headers as Record<string, string> | undefined) },
  });

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A source whose card is a bare title (plus, at most, the submitter's note): the scout summarizes these right after the pick. */
export function isDiscussionKind(kind: string): boolean {
  return DISCUSSION_KINDS.has(kind);
}

/**
 * Whether Use should read before enqueueing: never twice (`meta.deepReadAt`);
 * always for a discussion source (comments add to any story, however long
 * its text); for a link source only when the content is thin and there is
 * an article to fetch. Notes, videos, arXiv, GitHub, Product Hunt: no.
 */
export function needsDeepRead(idea: DeepReadIdea): boolean {
  if (idea.meta.deepReadAt) return false;
  if (DISCUSSION_KINDS.has(idea.kind)) return true;
  if (!LINK_KINDS.has(idea.kind)) return false;
  if ((idea.content?.trim().length ?? 0) >= RICH_CONTENT_CHARS) return false;
  return linkedArticleUrl(idea) !== null;
}

/** An http(s) URL to a page that could be an article: not a social post page, not a private host. */
export function isArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (SOCIAL_HOSTS.test(u.hostname)) return false;
    if (isPrivateHost(u.hostname)) return false;
    return classifyUrl(url) === "article";
  } catch {
    return false;
  }
}

/** The first http(s) link in a text, trailing punctuation dropped. */
export function firstLinkIn(text: string | null): string | null {
  if (!text) return null;
  const m = /https?:\/\/[^\s<>"'()\]]+/i.exec(text);
  return m ? m[0].replace(/[.,;:!?…]+$/, "") : null;
}

/**
 * The article a card links to, per source: an article/Dev.to card is the
 * article; a Lobsters card's url is the external link for a link story (its
 * comments page otherwise, which is not an article); a Lemmy card's url is
 * the external link unless it is the post itself (`/post/<id>`);
 * X/Bluesky/Mastodon posts link from their text. A Hacker News card always
 * links to its item page — its article comes from the items API instead.
 */
export function linkedArticleUrl(idea: DeepReadIdea): string | null {
  if (idea.kind === "article" || idea.kind === "devto" || idea.kind === "lobsters") {
    return idea.url && isArticleUrl(idea.url) ? idea.url : null;
  }
  if (idea.kind === "lemmy") {
    if (idea.url && isArticleUrl(idea.url) && !/\/post\/\d+\/?$/.test(new URL(idea.url).pathname)) return idea.url;
    return articleLinkInText(idea);
  }
  if (idea.kind === "x_post" || idea.kind === "bluesky" || idea.kind === "mastodon") return articleLinkInText(idea);
  return null;
}

function articleLinkInText(idea: DeepReadIdea): string | null {
  const link = firstLinkIn(idea.content);
  return link && link !== idea.url && isArticleUrl(link) ? link : null;
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

type HnItem = {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  author?: string | null;
  children?: HnItem[] | null;
};

export function hackerNewsItemId(url: string | null): string | null {
  const m = url ? /news\.ycombinator\.com\/item\?id=(\d+)/.exec(url) : null;
  return m ? m[1] : null;
}

function descendants(item: HnItem, depth = 0): number {
  if (depth > 6 || !item.children) return 0;
  return item.children.reduce((n, c) => n + 1 + descendants(c, depth + 1), 0);
}

function cleanComment(html: string | null | undefined): string {
  const text = html ? stripTags(html).replace(/\s+/g, " ").trim() : "";
  return /^\[(deleted|dead|flagged|removed)\]$/i.test(text) ? "" : text;
}

function clampText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Hacker News via Algolia's items API — the whole tree in one request. The
 * API carries no comment points, so the top-level comments most replied to
 * (then the longest) stand in for the best ones.
 */
async function readHackerNews(idea: DeepReadIdea, fetcher: Fetcher, timeoutMs: number): Promise<Discussion | null> {
  const id = hackerNewsItemId(idea.url);
  if (!id || !idea.url) return null;
  const res = await fetcher(`https://hn.algolia.com/api/v1/items/${id}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Hacker News items API returned ${res.status}`);
  const item = JSON.parse(await res.text()) as HnItem;
  const ranked = (item.children ?? [])
    .map((c) => ({ author: c.author ?? null, text: cleanComment(c.text), replies: descendants(c) }))
    .filter((c) => c.text)
    .sort((a, b) => b.replies - a.replies || b.text.length - a.text.length)
    .slice(0, MAX_COMMENTS)
    .map(({ author, text }) => ({ author, text: clampText(text, COMMENT_MAX_CHARS) }));
  return {
    name: "Hacker News",
    url: idea.url,
    title: item.title ? decodeEntities(item.title) : null,
    articleUrl: item.url && isArticleUrl(item.url) ? item.url : null,
    storyText: item.text ? clampText(stripTags(item.text).trim(), STORY_TEXT_MAX_CHARS) : null,
    comments: ranked,
  };
}

type LobstersComment = {
  comment_plain?: string | null;
  comment?: string | null;
  score?: number | null;
  commenting_user?: string | { username?: string } | null;
  user?: { username?: string } | null;
  is_deleted?: boolean;
  is_moderated?: boolean;
};
type LobstersStory = {
  short_id?: string;
  url?: string | null;
  title?: string | null;
  description_plain?: string | null;
  description?: string | null;
  comments?: LobstersComment[] | null;
};

/**
 * The story's short id: what the scout saved (`meta.sourceId`, namespaced
 * `lobsters:<short_id>` by lib/scout-run.ts), else parsed from a
 * comments-page url.
 */
export function lobstersShortId(idea: DeepReadIdea): string | null {
  const saved = typeof idea.meta.sourceId === "string" ? idea.meta.sourceId.replace(/^lobsters:/, "") : "";
  if (/^[a-z0-9]+$/i.test(saved)) return saved;
  const m = idea.url ? /lobste\.rs\/s\/([a-z0-9]+)/i.exec(idea.url) : null;
  return m ? m[1] : null;
}

function lobstersAuthor(c: LobstersComment): string | null {
  if (typeof c.commenting_user === "string") return c.commenting_user;
  return c.commenting_user?.username ?? c.user?.username ?? null;
}

/** Lobsters via the story's `.json` — comments carry a score, so the best-scored top ones are kept. */
async function readLobsters(idea: DeepReadIdea, fetcher: Fetcher, timeoutMs: number): Promise<Discussion | null> {
  const id = lobstersShortId(idea);
  if (!id) return null;
  const res = await fetcher(`https://lobste.rs/s/${id}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Lobsters story API returned ${res.status}`);
  const story = JSON.parse(await res.text()) as LobstersStory;
  const comments = (story.comments ?? [])
    .filter((c) => !c.is_deleted && !c.is_moderated)
    .map((c) => ({ author: lobstersAuthor(c), text: cleanComment(c.comment_plain ?? c.comment), score: c.score ?? 0 }))
    .filter((c) => c.text)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
    .slice(0, MAX_COMMENTS)
    .map(({ author, text }) => ({ author, text: clampText(text, COMMENT_MAX_CHARS) }));
  const description = story.description_plain?.trim() || (story.description ? stripTags(story.description).trim() : "");
  return {
    name: "Lobsters",
    url: `https://lobste.rs/s/${id}`,
    title: story.title ? decodeEntities(story.title) : null,
    articleUrl: story.url && isArticleUrl(story.url) ? story.url : null,
    storyText: description ? clampText(description, STORY_TEXT_MAX_CHARS) : null,
    comments,
  };
}

async function readDiscussion(idea: DeepReadIdea, fetcher: Fetcher, timeoutMs: number): Promise<Discussion | null> {
  if (idea.kind === "hackernews") return readHackerNews(idea, fetcher, timeoutMs);
  if (idea.kind === "lobsters") return readLobsters(idea, fetcher, timeoutMs);
  return null;
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

function regionOf(html: string, tag: "article" | "main"): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(html);
  return m ? m[1] : null;
}

function bodyOf(html: string): string {
  const start = html.search(/<body\b[^>]*>/i);
  return start >= 0 ? html.slice(start) : html;
}

function visibleText(fragment: string): string {
  const text = fragment
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|figure|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|section|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    // Whatever named entity decodeEntities doesn't know is noise to a reader — drop it.
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The page's readable text, a couple of thousand characters at most, cut at
 * a sentence end when that keeps most of it. Tries <article>, then <main>,
 * then the whole body, moving on when a region is too short to be the
 * article (a card in a list, a client-rendered shell). Null when the page
 * has no visible text at all.
 */
export function readableExcerpt(html: string, maxChars = ARTICLE_MAX_CHARS): string | null {
  const bounded = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const candidates = [regionOf(bounded, "article"), regionOf(bounded, "main"), bodyOf(bounded)];
  let best = "";
  for (const region of candidates) {
    if (region === null) continue;
    const text = visibleText(region);
    if (text.length >= ARTICLE_MIN_CHARS) { best = text; break; }
    if (text.length > best.length) best = text;
  }
  if (!best) return null;
  if (best.length <= maxChars) return best;
  const cut = best.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const keep = end >= Math.floor(maxChars * SENTENCE_CUT_MIN_SHARE) ? cut.slice(0, end + 1) : cut;
  return `${keep.trim()} …`;
}

function articleTitle(html: string): string | null {
  const head = html.slice(0, 200_000);
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(head) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(head);
  const raw = og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "";
  const title = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return title ? clampText(title, TITLE_MAX_CHARS) : null;
}

async function readArticle(url: string, fetcher: Fetcher, timeoutMs: number): Promise<Article | null> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`article returned ${res.status}`);
  const html = await res.text();
  const excerpt = readableExcerpt(html);
  if (!excerpt || excerpt.length < ARTICLE_MIN_CHARS) return null;
  return { url, title: articleTitle(html), excerpt };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Where the article's own words start: the first line that reads like prose
 * — long enough, with sentence punctuation, not the title said again, not a
 * date/byline/crumb line (live, 2026-09-23, plausible.io: "← All posts How
 * we built…", "Jun 22, 2022 • Written by Marko Saric" came before the first
 * real sentence). Falls back to the first line when nothing qualifies.
 */
function proseStart(lines: string[], title: string | null | undefined): number {
  const wanted = title ? normalize(title) : "";
  const idx = lines.findIndex((line) => {
    if (line.length < SUMMARY_PROSE_MIN_CHARS || !/[.!?]/.test(line)) return false;
    if (wanted && normalize(line).includes(wanted)) return false;
    return !(line.length < 120 && CHROME_LINE.test(line));
  });
  return Math.max(0, idx);
}

/**
 * One paragraph for a card, from prose: the first sentences within the cap
 * (a sentence end past half the cap wins, else a word boundary and "…"),
 * starting where the article's own words start (proseStart).
 */
export function summaryOf(prose: string, maxChars = CARD_SUMMARY_CHARS, title?: string | null): string | null {
  const lines = prose.split("\n").map((l) => l.trim()).filter(Boolean);
  const flat = lines.slice(proseStart(lines, title)).join(" ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentenceEnd >= maxChars / 2) return cut.slice(0, sentenceEnd + 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

/** What the card shows after a read: "title — summary", the shape every other source's card already has. Falls back to the card's own content. */
export function cardContent(idea: DeepReadIdea, read: DeepRead): string | null {
  return read.summary ? `${read.title} — ${read.summary}` : idea.content ?? read.title;
}

/**
 * The idea columns a read updates — the same whether the scout read the card
 * right after the pick or Use read it on demand: the card's content, and in
 * `meta` the full text for the agent (`deepReadText`), the links and the
 * done-marker (`deepReadAt`) that keeps it from being read twice.
 */
export function deepReadPatch(idea: DeepReadIdea, read: DeepRead, at: Date = new Date()): { content: string | null; meta: Record<string, unknown> } {
  return {
    content: cardContent(idea, read),
    meta: {
      ...idea.meta,
      deepReadAt: at.toISOString(),
      deepReadText: read.text,
      deepReadParts: read.parts,
      articleUrl: read.articleUrl,
      discussionUrl: read.discussionUrl,
    },
  };
}

/** The composed source text: title, link, the post's own text, the article extract, the discussion highlights. */
export function composeDeepRead(idea: DeepReadIdea, article: Article | null, discussion: Discussion | null, notes: string[]): DeepRead {
  const fallbackTitle = idea.title?.trim() || idea.content?.split("\n")[0]?.trim() || idea.url || "";
  const title = clampText((discussion?.title ?? article?.title ?? fallbackTitle).trim(), TITLE_MAX_CHARS);
  const articleUrl = article?.url ?? discussion?.articleUrl ?? null;
  const lines: string[] = [title];
  if (articleUrl) lines.push(`Link: ${articleUrl}`);
  if (discussion?.storyText) lines.push("", `Post text (${discussion.name}):`, discussion.storyText);
  if (article) lines.push("", `Article extract (${hostOf(article.url)}):`, article.excerpt);
  if (discussion && discussion.comments.length > 0) {
    lines.push("", `Discussion highlights on ${discussion.name} (${discussion.comments.length} of the comments):`);
    for (const c of discussion.comments) lines.push(`— ${c.author ?? "anonymous"}: ${c.text}`);
    lines.push(`Discussion: ${discussion.url}`);
  }
  const parts: DeepReadPart[] = [];
  if (article) parts.push("article");
  if (discussion && (discussion.comments.length > 0 || discussion.storyText)) parts.push("discussion");
  const top = discussion?.comments[0];
  const summary = article
    ? summaryOf(article.excerpt, CARD_SUMMARY_CHARS, title)
    : discussion?.storyText
      ? summaryOf(discussion.storyText)
      : top
        ? summaryOf(`Top comment (${top.author ?? "anonymous"}): ${top.text}`)
        : null;
  return {
    text: lines.join("\n").trim(),
    title,
    summary,
    articleUrl,
    discussionUrl: discussion && parts.includes("discussion") ? discussion.url : null,
    parts,
    notes,
  };
}

/**
 * Read what a person would before reacting to this card. Null when nothing
 * beyond what the card already has could be gathered (the caller keeps
 * today's title-plus-link seed). Never throws for a failing source — each
 * failure lands in `notes`.
 */
export async function deepRead(
  idea: DeepReadIdea,
  fetcher: Fetcher = defaultFetcher,
  { timeoutMs = FETCH_TIMEOUT_MS }: DeepReadOptions = {},
): Promise<DeepRead | null> {
  const notes: string[] = [];
  let discussion: Discussion | null = null;
  if (DISCUSSION_KINDS.has(idea.kind)) {
    try {
      discussion = await readDiscussion(idea, fetcher, timeoutMs);
    } catch (e) {
      notes.push(`discussion: ${messageOf(e)}`);
    }
  }
  const articleUrl = discussion?.articleUrl ?? linkedArticleUrl(idea);
  let article: Article | null = null;
  if (articleUrl) {
    try {
      article = await readArticle(articleUrl, fetcher, timeoutMs);
      if (!article) notes.push(`article: no readable text at ${hostOf(articleUrl)}`);
    } catch (e) {
      notes.push(`article: ${messageOf(e)}`);
    }
  }
  const gotDiscussion = discussion !== null && (discussion.comments.length > 0 || discussion.storyText !== null);
  if (!article && !gotDiscussion) return null;
  return composeDeepRead(idea, article, discussion, notes);
}
