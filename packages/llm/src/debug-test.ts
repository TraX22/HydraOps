import { generateText } from '../src/index.js';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '../../../../.env') });

async function test() {
  const llmConfig = {
    provider: 'google',
    model: 'gemini-1.5-flash',
    apiKey: process.env.GEMINI_API_KEY
  };
  
  console.log("Testing with config:", { ...llmConfig, apiKey: '***' });
  
  const res = await generateText(llmConfig, [{ role: 'user', content: 'hola' }], 'eres un asistente');
  console.log("Result:", JSON.stringify(res, null, 2));
}

test().catch(console.error);
