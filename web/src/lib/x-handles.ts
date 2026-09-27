/**
 * @handles on X, for Write's tags (owner, 2026-09-24: "vorrei poter aver
 * taggate persone o aziende con il loro tag dentro X… magari diretto con
 * hyperlink che se le clicco posso controllarle", and, to find the ones Claude
 * didn't tag without paying for the X API, "quando seleziono un nome cerca su
 * google quel nome con X o linkedin"). Pure: client and server both use it.
 */

/** X's own rule for a username: letters, digits and underscores, at most 15. */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
// "@name" not glued to a word, an email or a path before it, and not running on after.
const HANDLE_IN_TEXT = /(^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_@])/g;

export function isXHandle(value: string): boolean {
  return HANDLE.test(value);
}

/** The @handles a text tags, without the @, each once, in order. */
export function handlesIn(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(HANDLE_IN_TEXT)) {
    const key = m[2].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m[2]);
  }
  return out;
}

export type TextPart = { text: string } | { handle: string };

/** The text in plain runs and @handles, so a preview can link each handle. */
export function splitHandles(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(HANDLE_IN_TEXT)) {
    const at = m.index! + m[1].length;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ handle: m[2] });
    last = at + 1 + m[2].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function xProfileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

/** A Google search for a name on X or LinkedIn — opened in the owner's own browser; nothing here fetches it. */
export function tagSearchUrl(name: string, site: "x" | "linkedin"): string {
  const q = `"${name.replace(/"/g, "").trim()}" site:${site === "x" ? "x.com" : "linkedin.com"}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/**
 * The X handle of an X post's author, for the source text Claude writes from
 * (its tag is then exact, and free): the handle in the post's link
 * (x.com/<handle>/status/…), else an author stored as "@handle" (a post the
 * scout found with the owner's X key). Null for anything else.
 */
export function xAuthorHandle(idea: { kind: string; url: string | null; author: string | null }): string | null {
  if (idea.kind !== "x_post") return null;
  if (idea.url) {
    try {
      const u = new URL(idea.url);
      const [handle, status] = u.pathname.split("/").filter(Boolean);
      if (/(^|\.)(x|twitter)\.com$/i.test(u.hostname) && status === "status" && handle && handle !== "i" && isXHandle(handle)) return handle;
    } catch { /* not a url */ }
  }
  const author = idea.author?.trim() ?? "";
  return author.startsWith("@") && isXHandle(author.slice(1)) ? author.slice(1) : null;
}

/** The source text with its X author named, when there is one: "Post on X by @handle:" first. */
export function withXAuthor(text: string, idea: { kind: string; url: string | null; author: string | null }): string {
  const handle = xAuthorHandle(idea);
  return handle && text.trim() ? `Post on X by @${handle}:\n${text}` : text;
}
