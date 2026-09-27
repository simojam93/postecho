import { serviceEnv } from "@/lib/connections";
import { getSetting } from "@/lib/settings";
import { openSecret } from "@/lib/secret-box";
import { X_POSTS_PER_SEARCH } from "@/lib/sources/x";
import type { db as Db } from "@/db";

/**
 * The owner's X API key and budget, from Settings (2026-09-24). The key is
 * stored sealed (lib/secret-box.ts) and never leaves the server: GET
 * /api/settings reports only whether it's there and its last four characters.
 */
export type XConfig = { token: string | null; postsPerSearch: number };

export async function loadXConfig(db: typeof Db): Promise<XConfig> {
  const [sealed, postsPerSearch] = await Promise.all([
    getSetting(db as never, "xBearerToken"),
    getSetting(db as never, "xPostsPerSearch"),
  ]);
  return { token: openSecret(sealed), postsPerSearch: postsPerSearch ?? X_POSTS_PER_SEARCH.default };
}

/** "…abcd" for Settings, so the owner can tell which key is in use; null without one. */
export function keyHint(token: string | null): string | null {
  return token ? `…${token.slice(-4)}` : null;
}

/**
 * The env the scout's adapters read (lib/scout-run.ts, api/sources): the
 * process env with the keys pasted in the app on top (lib/connections.ts,
 * 2026-09-26), plus X_BEARER_TOKEN and X_POSTS_PER_SEARCH when the owner saved
 * an X key — a saved key wins over one set in the deployment.
 */
export async function scoutEnv(db: typeof Db, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const [env, x] = await Promise.all([serviceEnv(db, base), loadXConfig(db)]);
  if (!x.token) return env;
  return { ...env, X_BEARER_TOKEN: x.token, X_POSTS_PER_SEARCH: String(x.postsPerSearch) };
}
