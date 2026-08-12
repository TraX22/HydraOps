import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), override: true });

// Solo SQLite. Hubo una rama de PostgreSQL que nunca llegó a existir: la
// configuración apuntaba a un ./src/schema.pg.ts que no está en el árbol.
const dbUrl = process.env.DATABASE_URL || "";
const dbPath = dbUrl.startsWith("sqlite://")
  ? dbUrl.replace("sqlite://", "").replace(/^\//, "")
  : dbUrl;

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbPath,
  },
  verbose: true,
  strict: true,
});
