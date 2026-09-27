import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { onTestFinished } from "vitest";
import * as schema from "@/db/schema";

export async function createTestDb() {
  const client = new PGlite();
  onTestFinished(() => client.close());
  const testDb = drizzle(client, { schema });
  await migrate(testDb, {
    migrationsFolder: path.resolve(__dirname, "../../drizzle"),
  });
  return testDb;
}
