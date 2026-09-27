import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const client = new PGlite("./.pglite");
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
await client.close();
console.log("dev db migrated at web/.pglite");
