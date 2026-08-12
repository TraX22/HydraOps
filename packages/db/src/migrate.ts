import { config as loadDotenv } from "dotenv";
import { createDb } from "./client.js";
import { envFile, migrationsDir } from "@hydraops/config";

loadDotenv({ path: envFile, override: true });

const databaseUrl = process.env.DATABASE_URL ?? "sqlite://db.sqlite3";
console.log("USING DATABASE_URL:", databaseUrl);

async function main() {
  const { db, pool, isSqlite } = createDb(databaseUrl);
  const migrationsFolder = migrationsDir;

  console.log(`Running migrations for ${isSqlite ? 'SQLite' : 'PostgreSQL'}...`);

  if (isSqlite) {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    await migrate(db, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder });
  }

  await pool.end();
  console.log("DB migrated successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
