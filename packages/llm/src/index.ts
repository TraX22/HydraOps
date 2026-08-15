import { generateText as vercelGenerateText, stepCountIs, CoreMessage, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { readFile as fsReadFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { z } from 'zod';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export type LLMProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'local' | 'groq' | 'leonardo' | 'openrouter' | 'mistral';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
}

// --- Credential proxy (key-proxy) ---
// When KEY_PROXY_URL is set, every cloud-provider call is routed through the
// local key-proxy, which swaps the placeholder key for the real one at the
// network boundary. Worker processes never hold real API keys: the DB/.env
// only store the literal placeholder "proxy". Read lazily (not at module load)
// because workers call dotenv AFTER their hoisted ES imports run.
const PROXY_PREFIXES: [string, string][] = [
  ['https://api.openai.com', 'openai'],
  ['https://api.groq.com', 'groq'],
  ['https://api.x.ai', 'xai'],
  ['https://openrouter.ai', 'openrouter'],
  ['https://api.mistral.ai', 'mistral'],
  ['https://api.anthropic.com', 'anthropic'],
  ['https://generativelanguage.googleapis.com', 'google'],
  ['https://cloud.leonardo.ai', 'leonardo'],
  ['https://api.deepseek.com', 'deepseek'],
  ['https://dashscope-intl.aliyuncs.com', 'qwen'],
  ['https://api.moonshot.ai', 'kimi'],
  ['https://api.z.ai', 'glm'],
  ['https://api.minimax.io', 'minimax'],
];

function proxied(url: string): string {
  const proxyBase = (process.env.KEY_PROXY_URL || '').trim().replace(/\/$/, '');
  if (!proxyBase) return url;
  for (const [host, prefix] of PROXY_PREFIXES) {
    if (url.startsWith(host)) return `${proxyBase}/${prefix}${url.slice(host.length)}`;
  }
  return url;
}

/**
 * Resolves the LLM configuration based on the model name
 */
export function resolveLLMConfig(model: string, getGlobalConfig: (key: string, defaultValue: string) => string): LLMConfig {
  const m = model.toLowerCase();
  
  // Check if LOCAL_LLM_MODEL is set and the given model is a partial match
  const localLLMModel = getGlobalConfig('LOCAL_LLM_MODEL', '');
  // Normalize for comparison: strip spaces, dots, dashes
  const normalize = (s: string) => s.toLowerCase().replace(/[\s.\-_]/g, '');
  const mNorm = normalize(model);
  const localNorm = localLLMModel ? normalize(localLLMModel) : '';
  const isPartialLocalMatch = localNorm && (
    localNorm.includes(mNorm) || mNorm.includes(localNorm)
  );
  // NOTE: 'deepseek' is intentionally NOT here — it's now a first-class cloud
  // provider (see below). Local DeepSeek builds are still matched by param size
  // (e.g. deepseek-r1:8b), the '.gguf' suffix, the word 'local', or a partial
  // match to LOCAL_LLM_MODEL.
  const isOSArchitecture = /gemma|phi|yi|falcon/.test(m);
  const isParamSize = /\d+b/.test(m);

  // 1. Priority: Local models (.gguf, word 'local', os architectures, param sizes, or partial match to LOCAL_LLM_MODEL)
  if (m.endsWith('.gguf') || m.includes('local') || isOSArchitecture || isParamSize || isPartialLocalMatch) {
    const apiKey = getGlobalConfig('LOCAL_LLM_KEY', 'no-key');
    // Sin valor por defecto a propósito: inventar el puerto de LM Studio
    // (1234) hacía que un .env sin configurar fallara con un ECONNREFUSED a
    // una dirección que el usuario nunca escribió. Vacío = no configurado, y
    // generateText lo dice con esas palabras.
    let rawURL = getGlobalConfig('LOCAL_LLM_URL', '').trim();
    let baseURL = rawURL;
    if (rawURL && !rawURL.endsWith('/v1') && !rawURL.endsWith('/v1/')) {
        baseURL = rawURL.replace(/\/$/, '') + '/v1';
    }
    // Always send the CURRENT model name from config: 'local-model' is a stable
    // alias (the UI stores it so swapping local LLMs never orphans references),
    // and stale saved names resolve to whatever the local server runs now.
    return { provider: 'local', model: localLLMModel || model, apiKey, baseURL };
  }

  // 2. OpenAI
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) {
    return { 
      provider: 'openai', 
      model, 
      apiKey: getGlobalConfig('OPENAI_API_KEY', '') 
    };
  }

  // Mistral
  if (m.includes('mistral') || m.includes('codestral') || m.includes('ministral')) {
    return {
      provider: 'mistral',
      model,
      apiKey: getGlobalConfig('MISTRAL_API_KEY', '')
    };
  }

  // 3. Anthropic (now after .gguf)
  if (m.includes('claude')) {
    return { 
      provider: 'anthropic', 
      model, 
      apiKey: getGlobalConfig('ANTHROPIC_API_KEY', '') 
    };
  }

  // 4. Google
  if (m.includes('gemini') || m.includes('imagen')) {
    return { 
      provider: 'google', 
      model, 
      apiKey: getGlobalConfig('GEMINI_API_KEY', '') 
    };
  }

  // 5. Groq (Llama, Mixtral)
  if (m.includes('llama') || m.includes('mixtral')) {
    return { 
      provider: 'openai', 
      model, 
      apiKey: getGlobalConfig('GROQ_API_KEY', ''), 
      baseURL: 'https://api.groq.com/openai/v1' 
    };
  }

  // 6. xAI (Grok)
  if (m.includes('grok')) {
    return { 
      provider: 'openai', 
      model, 
      apiKey: getGlobalConfig('XAI_API_KEY', ''), 
      baseURL: 'https://api.x.ai/v1' 
    };
  }

  // 7. Leonardo
  if (m.includes('leonardo')) {
    // Strip "leonardo:" prefix if present to get the actual model ID/UUID
    const cleanModel = model.replace(/^leonardo:/, '');
    return {
      provider: 'leonardo',
      model: cleanModel,
      apiKey: getGlobalConfig('LEONARDO_API_KEY', ''),
      baseURL: 'https://cloud.leonardo.ai/api/rest/v1'
    };
  }

  // 8. OpenRouter — checked BEFORE the direct Chinese providers below so that
  // OpenRouter ids like 'deepseek/deepseek-chat' or 'qwen/qwen-max' (they carry a
  // slash) route to OpenRouter, while the slash-free direct ids fall through.
  if (m.includes('/') && !m.includes('http')) {
     // OpenRouter models usually have a slash (e.g., 'anthropic/claude-3')
     return {
       provider: 'openrouter',
       model,
       apiKey: getGlobalConfig('OPENROUTER_API_KEY', ''),
       baseURL: 'https://openrouter.ai/api/v1'
     };
  }

  // 9. DeepSeek (direct API, OpenAI-compatible)
  if (m.startsWith('deepseek')) {
    return {
      provider: 'openai',
      model,
      apiKey: getGlobalConfig('DEEPSEEK_API_KEY', ''),
      baseURL: 'https://api.deepseek.com/v1'
    };
  }

  // 10. Qwen — Alibaba DashScope, OpenAI-compatible ("compatible-mode") endpoint
  if (m.startsWith('qwen')) {
    return {
      provider: 'openai',
      model,
      apiKey: getGlobalConfig('QWEN_API_KEY', ''),
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    };
  }

  // 11. Kimi (Moonshot AI), OpenAI-compatible
  if (m.startsWith('kimi') || m.includes('moonshot')) {
    return {
      provider: 'openai',
      model,
      apiKey: getGlobalConfig('KIMI_API_KEY', ''),
      baseURL: 'https://api.moonshot.ai/v1'
    };
  }

  // 12. GLM (Zhipu / Z.ai) — flat Coding Plan endpoint. Spend the plan quota with
  // an 'sk-sp-' key; a plain 'sk-' key here bills pay-per-token instead.
  if (m.startsWith('glm')) {
    return {
      provider: 'openai',
      model,
      apiKey: getGlobalConfig('GLM_API_KEY', ''),
      baseURL: 'https://api.z.ai/api/coding/paas/v4'
    };
  }

  // 13. MiniMax, OpenAI-compatible (model ids: MiniMax-*, abab*)
  if (m.startsWith('minimax') || m.includes('abab')) {
    return {
      provider: 'openai',
      model,
      apiKey: getGlobalConfig('MINIMAX_API_KEY', ''),
      baseURL: 'https://api.minimax.io/v1'
    };
  }

  // Default: Google (or whatever is configured as GEMINI_API_KEY)
  return { 
    provider: 'google', 
    model, 
    apiKey: getGlobalConfig('GEMINI_API_KEY', '') 
  };
}

/**
 * Factory function that returns the appropriate model based on the configuration
 */
function getModel(config: LLMConfig) {
  const modelName = config.provider === 'google' 
    ? config.model.replace('models/', '') 
    : config.model;

  switch (config.provider) {
    case 'openai':
    case 'xai':
    case 'local':
    case 'groq':
    case 'openrouter': {
      const openai = createOpenAI({
        apiKey: config.apiKey,
        // Explicit default so the proxy rewrite also applies when baseURL is unset
        baseURL: proxied(config.baseURL || 'https://api.openai.com/v1')
      });
      // The default callable targets OpenAI's Responses API (/v1/responses).
      // Compatible servers (llama.cpp, Groq, xAI, OpenRouter) only implement
      // /chat/completions properly — llama-server's partial /responses 400s on
      // assistant history items and xAI's 422s on tool calls. Note that Groq and
      // xAI resolve with provider 'openai' + custom baseURL, so the Responses API
      // is only safe when the baseURL is OpenAI's own (or unset).
      const isRealOpenAI = config.provider === 'openai' && (!config.baseURL || config.baseURL.includes('api.openai.com'));
      return isRealOpenAI ? openai(modelName) : openai.chat(modelName);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey, baseURL: proxied('https://api.anthropic.com/v1') });
      return anthropic(modelName);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: proxied('https://generativelanguage.googleapis.com/v1beta') });
      return google(modelName);
    }
    case 'mistral': {
      const mistral = createMistral({ apiKey: config.apiKey, baseURL: proxied('https://api.mistral.ai/v1') });
      return mistral(modelName);
    }
    default:
      throw new Error(`Provider not supported: ${config.provider}`);
  }
}

// The functions scrapeWeb and searchWeb have been migrated to the @hydraops/addons package

/**
 * Lists available models from the Google API
 */
export async function listAvailableGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    
    const data = await response.json();
    return data.models
      .filter((m: any) => m.supportedGenerationMethods.includes('generateContent') || m.supportedGenerationMethods.includes('predict') || m.supportedGenerationMethods.includes('generateVideos') || m.supportedGenerationMethods.includes('predictLongRunning'))
      .map((m: any) => m.name.replace('models/', ''));
  } catch (error) {
    console.error('[LLM Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from the Mistral API
 */
export async function listAvailableMistralModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://api.mistral.ai/v1/models`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[Mistral Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from the OpenAI API
 */
export async function listAvailableOpenAIModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://api.openai.com/v1/models`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[OpenAI Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from the Groq API
 */
export async function listAvailableGroqModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://api.groq.com/openai/v1/models`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[Groq Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from the xAI (Grok) API
 */
export async function listAvailableXAIModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://api.x.ai/v1/models`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[xAI Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from the Anthropic API
 */
export async function listAvailableAnthropicModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://api.anthropic.com/v1/models`;
    const response = await fetch(url, { 
      headers: { 
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      } 
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[Anthropic Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists available models from OpenRouter
 */
export async function listAvailableOpenRouterModels(apiKey: string): Promise<string[]> {
  try {
    const url = `https://openrouter.ai/api/v1/models`;
    const response = await fetch(url, { 
      headers: { 
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://hydraops.ai', // OpenRouter requires this or similar
        'X-Title': 'HydraOps'
      } 
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data.map((m: any) => m.id);
  } catch (error) {
    console.error('[OpenRouter Discovery Error]:', error);
    return [];
  }
}

/**
 * Lists models from any OpenAI-compatible `/models` endpoint (Bearer auth).
 * Shared by the direct Chinese providers below (DeepSeek, Qwen, Kimi, GLM),
 * which are all OpenAI-compatible.
 */
async function fetchOpenAICompatModels(baseURL: string, apiKey: string, label: string): Promise<string[]> {
  try {
    const url = `${baseURL.replace(/\/$/, '')}/models`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : [];
  } catch (error) {
    console.error(`[${label} Discovery Error]:`, error);
    return [];
  }
}

export function listAvailableDeepSeekModels(apiKey: string): Promise<string[]> {
  return fetchOpenAICompatModels('https://api.deepseek.com/v1', apiKey, 'DeepSeek');
}

export function listAvailableQwenModels(apiKey: string): Promise<string[]> {
  return fetchOpenAICompatModels('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKey, 'Qwen');
}

export function listAvailableKimiModels(apiKey: string): Promise<string[]> {
  return fetchOpenAICompatModels('https://api.moonshot.ai/v1', apiKey, 'Kimi');
}

// GLM: the flat Coding Plan endpoint may not expose /models, so the API layer
// merges this with a static fallback list.
export function listAvailableGLMModels(apiKey: string): Promise<string[]> {
  return fetchOpenAICompatModels('https://api.z.ai/api/paas/v4', apiKey, 'GLM');
}

export function listAvailableMiniMaxModels(apiKey: string): Promise<string[]> {
  return fetchOpenAICompatModels('https://api.minimax.io/v1', apiKey, 'MiniMax');
}

/**
 * Lists available models from Leonardo.ai
 */
export async function listAvailableLeonardoModels(apiKey: string): Promise<{ id: string, name: string, description: string }[]> {
  try {
    const url = `https://cloud.leonardo.ai/api/rest/v1/platformModels`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'accept': 'application/json'
      }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.custom_models || []).map((m: any) => ({
      id: m.id,
      name: m.name,
      description: m.description
    }));
  } catch (error) {
    console.error('[Leonardo Discovery Error]:', error);
    return [];
  }
}

/**
 * Master function to generate text
 */
// ── Chat attachments ────────────────────────────────────────────────────────
// The chat UI appends a marker block to the task prompt:
//   [ATTACHMENTS]
//   - storage/uploads/<file> (<mime>)
// buildUserMessage() turns that into a proper user message: images become
// multimodal vision parts, readable text files are inlined, anything else is
// referenced by path so the agent at least knows it exists.

const ATTACHMENTS_RE = /\n*\[ATTACHMENTS\]\n([\s\S]*)$/;
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/sql']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'cs', 'java', 'c', 'cpp', 'h', 'sh', 'ps1', 'sql', 'ini', 'toml', 'env', 'log'])

function isTextLike(mime: string, filename: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTS.has(ext);
}

const MAX_INLINE_DOC_CHARS = 12_000;

export async function buildUserMessage(prompt: string, rootDir: string): Promise<CoreMessage> {
  const match = prompt.match(ATTACHMENTS_RE);
  if (!match) return { role: 'user', content: prompt };

  const text = prompt.slice(0, match.index).trim();
  const entries = match[1]
    .split('\n').map(l => l.trim()).filter(l => l.startsWith('-'))
    .map(l => /^-\s*(.+?)\s*\(([^()]+)\)\s*$/.exec(l))
    .filter(Boolean)
    .map(m => ({ rel: m![1], mime: m![2] }));

  const imageParts: any[] = [];
  const docSections: string[] = [];
  for (const e of entries) {
    const name = nodePath.basename(e.rel);
    try {
      const abs = nodePath.join(rootDir, e.rel);
      if (e.mime.startsWith('image/')) {
        // AI SDK v5+: 'image' parts are deprecated (and webp was getting dropped
        // on the openai-compatible route); 'file' parts with image/* work.
        imageParts.push({ type: 'file', mediaType: e.mime, data: await fsReadFile(abs) });
      } else if (isTextLike(e.mime, name)) {
        const raw = await fsReadFile(abs, 'utf-8');
        const clipped = raw.length > MAX_INLINE_DOC_CHARS ? raw.slice(0, MAX_INLINE_DOC_CHARS) + '\n…(archivo truncado)' : raw;
        docSections.push(`--- ATTACHED FILE: ${name} ---\n${clipped}\n--- END OF ${name} ---`);
      } else {
        docSections.push(`--- ATTACHED FILE: ${name} (${e.mime}) ---\n[Binary file stored at ${e.rel}. You CANNOT see or read its content. If the user asks about it, say clearly that you cannot open this file type — NEVER guess or invent what it contains.]`);
      }
    } catch (err: any) {
      docSections.push(`--- ATTACHED FILE: ${name} ---\n[Could not read the file: ${err?.message}]`);
    }
  }

  const fullText = [text || '(the user sent attached files without a message)', ...docSections].join('\n\n');
  if (imageParts.length === 0) return { role: 'user', content: fullText };
  return { role: 'user', content: [{ type: 'text', text: fullText }, ...imageParts] } as CoreMessage;
}

// Algunos modelos de razonamiento (MiniMax M2/M3, etc.) NO devuelven el
// "pensamiento" en un campo aparte (reasoning_content, como DeepSeek/Kimi), sino
// inline dentro del content envuelto en <think>...</think> —a menudo en inglés—.
// El SDK lo deja tal cual en response.text, así que el usuario ve el razonamiento
// antes de la respuesta real. Lo quitamos para mostrar solo la contestación.
function stripReasoning(text: string): string {
  if (!text) return text;
  // Bloques completos <think>…</think> / <thinking>…</thinking>
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Etiqueta de cierre suelta (el razonamiento empezó antes del content): quédate con lo de después.
  const close = out.toLowerCase().lastIndexOf('</think');
  if (close !== -1) {
    const gt = out.indexOf('>', close);
    if (gt !== -1) out = out.slice(gt + 1);
  }
  // Apertura sin cierre (razonamiento truncado por max_tokens): descarta desde ahí.
  const open = out.toLowerCase().indexOf('<think');
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

export async function generateText(config: LLMConfig, messages: CoreMessage[], systemPrompt?: string, aiTools?: Record<string, any>, rawTools?: any[]) {
  try {
    const hasTools = aiTools && Object.keys(aiTools).length > 0;
    console.log(`[LLM] Attempting with model: ${config.model} (${config.provider}) | Tools: ${hasTools}`);

    // Un local sin URL acabaría llamando a api.openai.com con la clave "no-key"
    // (ver getModel). Mejor decir qué falta que reintentar tres veces contra
    // un sitio equivocado.
    if (config.provider === 'local' && !config.baseURL) {
      throw new Error(
        'no hay servidor LLM local configurado. Define LOCAL_LLM_URL en el .env ' +
        '(por ejemplo http://127.0.0.1:8080/v1) y vuelve a enviar el mensaje: ' +
        'los workers releen el archivo en cada tarea, no hace falta reiniciar.'
      );
    }

    const model = getModel(config);

    const isThinkingModel = config.model.toLowerCase().includes('thinking') || config.model.toLowerCase().includes('thought');

    // Critical instruction to prevent the model from going silent after using tools
    const finalSystemPrompt = systemPrompt 
      ? systemPrompt + (hasTools ? "\n\nCRITICAL INSTRUCTION: When you use a tool, the user CANNOT see its results directly. You MUST ALWAYS generate a final text response analyzing or summarizing the information obtained." : "")
      : (hasTools ? "CRITICAL INSTRUCTION: When you use a tool, the user CANNOT see its results directly. You MUST ALWAYS generate a final text response analyzing or summarizing the information obtained." : undefined);

    let response;
    try {
      response = await vercelGenerateText({
        model,
        system: finalSystemPrompt,
        messages,
        tools: aiTools,
        // AI SDK v5+ replaced maxSteps with stopWhen; maxSteps is ignored and
        // the loop would stop after the first tool call without a text answer.
        stopWhen: hasTools ? stepCountIs(10) : undefined,
        maxRetries: 2,
        providerOptions: (config.provider === 'google' && isThinkingModel) ? {
          google: {
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        } : undefined,
      });
    } catch (toolError: any) {
      const errorMsg = toolError.message.toLowerCase();
      console.error(`[LLM Tool Error] Error detected: ${toolError.message}`);
      
      // EMERGENCY LOGIC FOR LOCAL ENGINES (llama.cpp / vLLM / custom)
      // If the error is validation-related but we have a responseBody with 'output', we try to process it manually.
      if (config.provider === 'local' && toolError.responseBody) {
        try {
          const body = JSON.parse(toolError.responseBody);
          if (body.object === 'response' && Array.isArray(body.output)) {
             console.log(`[LLM Local] Detected 'response' format from llama.cpp. Attempting manual extraction...`);
             const functionCall = body.output.find((o: any) => o.type === 'function_call');
             if (functionCall && hasTools) {
                const toolName = functionCall.name;
                const toolArgs = typeof functionCall.arguments === 'string' ? JSON.parse(functionCall.arguments) : functionCall.arguments;
                
                console.log(`[LLM Local] Executing manual tool: ${toolName}`);
                let toolResult = "Error executing tool.";
                
                // Smart fallback: If arguments are empty, we try to extract data
                const lastMessage = messages[messages.length - 1];
                const originalPrompt = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
                
                let effectiveUrl = toolArgs.url;
                let effectiveQuery = toolArgs.query;

                // Guard: if tool arguments are completely empty, infer from the user's prompt
                if (toolName === 'web_search' && !effectiveQuery) {
                   effectiveQuery = originalPrompt;
                   toolArgs.query = effectiveQuery;
                   console.log(`[LLM Local] web_search query was undefined, using user prompt: "${effectiveQuery}"`);
                }

                if (toolName === 'fetch_url' && !effectiveUrl) {
                   const urlRegex = /(https?:\/\/[^\s]+)/g;
                   // Search in reasoning
                   const reasoning = body.output.find((o: any) => o.type === 'reasoning')?.content?.[0]?.text || "";
                   const foundInReasoning = reasoning.match(urlRegex);
                   if (foundInReasoning) effectiveUrl = foundInReasoning[0].replace(/[',`]/g, '');
                   
                   // If still empty, search in original prompt
                   if (!effectiveUrl) {
                      const foundInPrompt = originalPrompt.match(urlRegex);
                      if (foundInPrompt) effectiveUrl = foundInPrompt[0];
                   }
                   console.log(`[LLM Local] URL recovered via fallback: ${effectiveUrl}`);
                   if (effectiveUrl) toolArgs.url = effectiveUrl;
                }

                if (rawTools) {
                   const rTool = rawTools.find(t => t.name === toolName);
                   if (rTool) {
                     toolResult = await rTool.execute(toolArgs);
                   } else {
                     toolResult = `The tool ${toolName} is not available or has no direct implementation in the local fallback.`;
                   }
                } else {
                   toolResult = `No rawTools were passed to the LLM. Manual fallback impossible.`;
                }

                // Generate final response after manual tool usage
                // We use a simpler message format for maximum compatibility with local engines
                const finalResponse = await vercelGenerateText({
                  model,
                  system: finalSystemPrompt,
                  messages: [
                    { role: 'user', content: `${originalPrompt}\n\n[SYSTEM: I have obtained the following information from the web to help you answer]:\n${toolResult}` }
                  ]
                });

                return {
                  text: finalResponse.text,
                  usage: response?.usage,
                  success: true,
                  modelUsed: config.model
                };
             }
          }
        } catch (e) {
          console.error(`[LLM Local] Error in manual extraction:`, e);
        }
      }

      // Engine without vision (e.g. llama-server without --mmproj): retry with
      // the image parts stripped and let the model explain it to the user.
      if (errorMsg.includes('image input is not supported') || errorMsg.includes('mmproj') || errorMsg.includes('does not support image')) {
        console.warn(`[LLM] ${config.model} cannot process images. Retrying without image parts...`);
        const stripped = messages.map((m: any) => {
          if (!Array.isArray(m.content)) return m;
          const textOnly = m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
          return {
            role: m.role,
            content: `${textOnly}\n\n[SYSTEM NOTE: The user attached one or more images, but your current engine cannot see images (no multimodal projector loaded). Briefly tell the user, in their language, that you cannot view images right now and that they can either enable vision in the local server (load the model's mmproj) or send the image to an agent that uses an API model with vision.]`,
          };
        });
        response = await vercelGenerateText({
          model,
          system: finalSystemPrompt,
          messages: stripped as any,
          tools: aiTools,
          stopWhen: hasTools ? stepCountIs(10) : undefined,
          maxRetries: 1,
        });
      // If the error seems related to tools and we are in local, we retry without them
      } else if (hasTools && (errorMsg.includes('tool') || errorMsg.includes('not supported') || errorMsg.includes('400') || errorMsg.includes('json') || errorMsg.includes('invalid'))) {
        console.warn(`[LLM] Local model (${config.model}) failed with tools. Retrying in compatibility mode...`);
        const fallbackPrompt = (finalSystemPrompt || "") + "\n\nIMPORTANT NOTICE: Your current engine (local) reported a technical problem when trying to use tools. Please inform the user that there was an error with the 'tools' parameter on the local server.";
        
        response = await vercelGenerateText({
          model,
          system: fallbackPrompt,
          messages,
          maxRetries: 1,
        });
      } else {
        throw toolError;
      }
    }

    // Logging for debugging why response.text is sometimes empty after tool calls
    let finalText = stripReasoning(response.text);
    if (!finalText) {
      if (response.toolResults?.length) {
         console.log(`[LLM Debug] Model went silent after tools. Forcing secondary text generation...`);
         try {
           const forcedResponse = await vercelGenerateText({
             model,
             messages: [
               ...messages, 
               { role: 'assistant', content: `Tool completed. Results: ${JSON.stringify(response.toolResults.map(t => t.result)).slice(0, 4000)}` },
               { role: 'user', content: 'Please provide a summary or final answer based on the results obtained.' }
             ],
             system: finalSystemPrompt,
           });
           finalText = stripReasoning(forcedResponse.text) || "✅ Tool executed successfully. (The model did not generate an additional comment).";
         } catch (e) {
           finalText = "✅ Tool executed successfully. (The model did not generate an additional comment about the results).";
         }
      } else if (response.toolCalls?.length) {
         finalText = "⚠️ The model requested tools but ran out of steps to continue or failed internally.";
      } else {
         finalText = "The model did not return any response. Please try to rephrase your request.";
      }
    }

    return {
      text: finalText,
      usage: response.usage,
      success: true,
      modelUsed: config.model
    };
  } catch (error: any) {
    const lastError = error.message;
    console.error(`[LLM Error] Model ${config.model} failed: ${lastError}`);
    return {
      text: '',
      usage: null,
      success: false,
      error: `Model ${config.model} failed: ${lastError}`,
    };
  }
}

/**
 * Master function to generate images through multiple providers
 */
// Closest aspect-ratio label supported by providers that take a ratio string
function aspectFromSize(width: number, height: number): string {
  const ratio = width / height;
  const known: [string, number][] = [["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["4:3", 4 / 3], ["3:4", 3 / 4]];
  known.sort((a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio));
  return known[0][0];
}

export async function generateImage(config: LLMConfig, prompt: string, width: number = 1024, height: number = 1024) {
  try {
    console.log(`[LLM Image] Attempting with model: ${config.model} (${config.provider})`);

    if (config.provider === 'google') {
       const response = await fetch(proxied(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:predict?key=${config.apiKey}`), {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio: aspectFromSize(width, height), outputMimeType: "image/png" }
         })
       });
       if (!response.ok) throw new Error(await response.text());
       const data = await response.json();
       const prediction = data.predictions?.[0];
       const base64Data = prediction?.bytesBase64Encoded || prediction?.imageBytes || prediction;
       if (!base64Data || typeof base64Data !== 'string') {
          throw new Error("Invalid returned data from Google model.");
       }
       return { success: true, base64: base64Data };
    } 

    if (config.provider === 'leonardo') {
       // Leonardo.ai Implementation
       // Note: Leonardo is asynchronous. This implementation starts the generation.
       // The worker should handle polling if needed, or we can do a basic poll here.
       const response = await fetch(proxied(`${config.baseURL}/generations`), {
         method: 'POST',
         headers: { 
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${config.apiKey}`
         },
         body: JSON.stringify({
            prompt,
            width,
            height,
            num_images: 1,
            modelId: config.model === 'leonardo-ai' ? "291be633-cb24-434f-898f-e662799936ad" : config.model, // Default to Leonardo Signature if generic
         })
       });

       if (!response.ok) {
          const errText = await response.text();
          let errMsg = errText;
          try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error || errJson.message || errText;
          } catch (e) {}
          throw new Error(`Leonardo API Error: ${errMsg}`);
        }

       const data = await response.json();
       const generationId = data.sdGenerationJob?.generationId;
       
       if (!generationId) throw new Error("Failed to start Leonardo generation");

       // Basic Polling (max 30s)
       console.log(`[Leonardo] Generation started: ${generationId}. Polling...`);
       for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const statusRes = await fetch(proxied(`${config.baseURL}/generations/${generationId}`), {
            headers: { 'Authorization': `Bearer ${config.apiKey}` }
          });
          if (statusRes.ok) {
             const statusData = await statusRes.json();
             const image = statusData.generations_by_pk?.generated_images?.[0];
             if (image?.url) {
                // Fetch the image and convert to base64
                const imgRes = await fetch(image.url);
                const buffer = await imgRes.arrayBuffer();
                return { success: true, base64: Buffer.from(buffer).toString('base64'), url: image.url, imageId: image.id };
             }
          }
       }
       throw new Error("Leonardo generation timed out");
    }
    
    // Fallback: OpenAI Compatible (incluye xAI Grok y DALL-E)
    let url = proxied((config.baseURL || 'https://api.openai.com/v1') + '/images/generations');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      // Many endpoints just drop size or respect specific formats. We pass b64_json to avoid temporary URLs whenever possible.
      // Size: only OpenAI documents fixed size values; other OpenAI-compatible APIs
      // (xAI) may reject unknown params, so we let them use their default.
      body: JSON.stringify({
        model: config.model,
        prompt: prompt,
        n: 1,
        response_format: 'b64_json',
        ...(config.provider === 'openai' ? {
          size: (() => {
            const ratio = width / height;
            const gptImage = config.model.includes('gpt-image');
            if (ratio > 1.2) return gptImage ? '1536x1024' : '1792x1024';
            if (ratio < 0.8) return gptImage ? '1024x1536' : '1024x1792';
            return '1024x1024';
          })()
        } : {})
      })
    });
    
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return { success: true, base64: data.data[0].b64_json, url: data.data[0].url };
  } catch (error: any) {
    console.error(`[LLM Image Error] Model ${config.model} failed:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Master function to generate videos through multiple providers
 */
export async function generateVideo(config: LLMConfig, prompt: string, width: number = 832, height: number = 480) {
  try {
     console.log(`[LLM Video] Attempting with model: ${config.model} (${config.provider})`);
     if (config.provider === 'google') {
        throw new Error("El modelo Google Veo 2 requiere operaciones asíncronas (LRO) que no están soportadas en esta versión. Por favor, utiliza Leonardo AI para generar videos.");
     }

     if (config.provider === 'leonardo') {
        // Motion 2.0 text-to-video. The old /generations-motion-svd endpoint was
        // removed from Leonardo's API (returns 404 "Endpoint not found").
        console.log(`[Leonardo Video] Starting Motion 2.0 text-to-video...`);
        const motionRes = await fetch(proxied(`${config.baseURL}/generations-text-to-video`), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
             prompt,
             width,
             height,
             resolution: "RESOLUTION_480",
             frameInterpolation: true,
             promptEnhance: true,
             isPublic: false
          })
        });

        if (!motionRes.ok) {
           const errText = await motionRes.text();
           throw new Error(`Leonardo Motion API Error: ${errText}`);
        }

        const motionData = await motionRes.json();
        // Field name differs across API revisions — accept any known job wrapper
        const motionGenId = motionData.motionVideoGenerationJob?.generationId
          || motionData.sdGenerationJob?.generationId
          || motionData.motionSvdGenerationJob?.generationId
          || motionData.generationId;

        if (!motionGenId) throw new Error(`Failed to start Leonardo motion generation: ${JSON.stringify(motionData)}`);

        console.log(`[Leonardo Video] Polling motion generation ${motionGenId}...`);
        for (let i = 0; i < 60; i++) { // wait up to ~3 min
           await new Promise(r => setTimeout(r, 3000));
           const statusRes = await fetch(proxied(`${config.baseURL}/generations/${motionGenId}`), {
             headers: { 'Authorization': `Bearer ${config.apiKey}` }
           });
           if (statusRes.ok) {
              const statusData = await statusRes.json();
              const gen = statusData.generations_by_pk;
              if (gen?.status === 'FAILED') throw new Error("Leonardo motion generation failed");
              const image = gen?.generated_images?.[0];
              let videoUrl = image?.motionMP4URL;
              if (!videoUrl && image?.url && /\.mp4(\?|$)/i.test(image.url)) videoUrl = image.url;
              if (videoUrl) {
                 return { success: true, base64: null, url: videoUrl };
              }
           }
        }
        throw new Error("Leonardo motion generation timed out");
     }
     
     throw new Error(`Video generation is not fully enabled/implemented for provider ${config.provider}`);
  } catch (error: any) {
    console.error(`[LLM Video Error] Model ${config.model} failed:`, error.message);
    return { success: false, error: error.message };
  }
}
