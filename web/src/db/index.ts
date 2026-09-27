import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// `Database` is the neon-http type — the CANONICAL surface for `db` in this app.
// neon-http does NOT support `.transaction()` (it throws at runtime): do not
// call db.transaction anywhere in this codebase. The PGlite instance used below
// for dev/tests DOES support .transaction(), so code that relies on it would
// pass every test (PGlite) and then explode against the real Neon connection in
// production. Multi-step writes must handle partial failure explicitly instead
// (see web/src/app/api/videos/route.ts, which cleans up the idea row if the
// follow-up job insert fails).
type Database = ReturnType<typeof drizzleNeon<typeof schema>>;

let instance: Database | undefined;
function getDb(): Database {
  if (!instance) {
    if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
      // Zero-setup local dev: file-backed PGlite (run `npm run db:migrate:dev` once).
      // Required lazily (not a top-level import) so prod server bundles never pull
      // in @electric-sql/pglite: this branch is dead code in production, both because
      // NODE_ENV === "production" there and because DATABASE_URL is required in prod.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PGlite } = require("@electric-sql/pglite");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle: drizzlePglite } = require("drizzle-orm/pglite");
      // globalThis singleton guards against re-instantiating (and re-locking) the
      // same file-backed PGlite database across Next.js HMR module reloads in dev.
      const g = globalThis as { __postechoPglite?: unknown };
      g.__postechoPglite ??= new PGlite(".pglite");
      // LIE WARNING: this cast claims the PGlite-backed instance is the neon-http
      // `Database` type so dev/test and prod can share one `db` surface. It is
      // not really neon-http — in particular PGlite supports `.transaction()`,
      // which would work here and then throw against real Neon in production.
      // Do not use db.transaction; see the comment on `Database` above.
      instance = drizzlePglite(g.__postechoPglite, { schema }) as unknown as Database;
      console.warn("[postecho] DATABASE_URL not set — using local PGlite dev database at web/.pglite");
    } else {
      instance = drizzleNeon(neon(process.env.DATABASE_URL!), { schema });
    }
  }
  return instance;
}

export const db: Database = new Proxy({} as Database, {
  get: (_t, prop, receiver) => Reflect.get(getDb(), prop, receiver),
});
export type Db = Database;
