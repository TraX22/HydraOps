import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../../.env") });

import { createDb, agentConfigs } from "./index.js";

const { db } = createDb(process.env.DATABASE_URL!);

async function main() {
  const configs = await db.select().from(agentConfigs);
  console.log(JSON.stringify(configs, null, 2));
}

main();
