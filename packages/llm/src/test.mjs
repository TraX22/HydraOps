import { config as loadDotenv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../../.env") });

import { generateText } from "./index.js";

async function main() {
  console.log("Testing with env:", process.env.GEMINI_API_KEY ? "key present" : "no key");
  const config = { provider: 'google', model: 'gemini-2.5-flash-lite', apiKey: process.env.GEMINI_API_KEY };
  const result = await generateText(config, [{role: 'user', content: 'test'}], 'system string');
  console.log("RESULT::", result);
}

main();
