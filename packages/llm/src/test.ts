import { config as loadDotenv } from "dotenv";
loadDotenv({ path: new URL("../../../.env", import.meta.url) });

import { generateText as vercelGenerateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const model = google('gemini-2.5-flash-lite');

async function main() {
  try {
    const response = await vercelGenerateText({
      model,
      system: "Hola",
      messages: [{ role: 'user', content: "Mundo" }],
    });
    console.log("RESPONSE SUCCESS:", response.text);
  } catch (e) {
    console.error("ERROR:");
    console.error(e);
  }
}

main();
