// npm run demo: sample data in the local database (web/.pglite), never in a real one.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import { seedDemo } from "../src/lib/demo-seed";

async function main() {
  if (process.env.DATABASE_URL) {
    console.error("DATABASE_URL is set: npm run demo only fills the local database. Unset it to use the sample data.");
    process.exit(1);
  }
  const client = new PGlite("./.pglite");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedDemo(db as never, new Date());
  await client.close();
  console.log("Sample data added to web/.pglite. If npm run dev was running, stop it and start it again.");
}

void main();
