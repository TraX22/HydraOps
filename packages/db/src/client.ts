import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "node:path";
import { dataRoot } from "@hydraops/config";
import * as sqliteSchema from "./schema.js";

// Ensure compatibility with TS by returning ANY db client.
export function createDb(databaseUrl: string): { db: any; pool: { end: () => Promise<void> }, client: any, isSqlite: boolean } {
  // defaults to sqlite
  // e.g. sqlite:///db.sqlite3 o file:./db.sqlite3 -> <dataRoot>/db.sqlite3
  const dbUrl = databaseUrl.replace(/^(?:sqlite|file):\/{0,3}/, "").replace(/^\//, "");
  let dbPath = dbUrl;

  // Una ruta relativa cuelga del directorio de datos, no del repositorio: así
  // el mismo DATABASE_URL del .env vale en desarrollo y en una instalación.
  if (!path.isAbsolute(dbPath)) {
    dbPath = path.resolve(dataRoot, dbPath);
  }

  const sqlite = new Database(dbPath);
  // Note: BetterSQLite3 operates synchronously so pool.end() equivalent is simply db.close() if needed
  const pool = { end: async () => { sqlite.close(); } };
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  return { db, pool, client: sqlite, isSqlite: true };
}
