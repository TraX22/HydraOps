/**
 * key-proxy — HydraOps credential firewall.
 *
 * The only process that knows the real API keys. Workers talk to cloud LLM
 * providers through http://127.0.0.1:9099/<provider>/... using the literal
 * placeholder key "proxy"; this proxy swaps in the real key at the network
 * boundary and forwards the request unchanged (streaming included).
 *
 * Real keys live in the key store — outside the project tree on purpose, so
 * agent file tools scoped to the repo can never read them. Its per-platform
 * location is resolved once in @hydraops/config (keyStoreFile).
 * The file is managed by the API (Config view) and re-read here on change.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { keyStoreFile } from "@hydraops/config";

const PORT = Number(process.env.KEY_PROXY_PORT || 9099);
const KEYS_PATH = keyStoreFile;

type AuthStyle = "bearer" | "x-api-key" | "google";
const PROVIDERS: Record<string, { host: string; keyName: string; auth: AuthStyle }> = {
  openai:     { host: "https://api.openai.com",                    keyName: "OPENAI_API_KEY",     auth: "bearer" },
  groq:       { host: "https://api.groq.com",                      keyName: "GROQ_API_KEY",       auth: "bearer" },
  xai:        { host: "https://api.x.ai",                          keyName: "XAI_API_KEY",        auth: "bearer" },
  openrouter: { host: "https://openrouter.ai",                     keyName: "OPENROUTER_API_KEY", auth: "bearer" },
  mistral:    { host: "https://api.mistral.ai",                    keyName: "MISTRAL_API_KEY",    auth: "bearer" },
  anthropic:  { host: "https://api.anthropic.com",                 keyName: "ANTHROPIC_API_KEY",  auth: "x-api-key" },
  google:     { host: "https://generativelanguage.googleapis.com", keyName: "GEMINI_API_KEY",     auth: "google" },
  leonardo:   { host: "https://cloud.leonardo.ai",                 keyName: "LEONARDO_API_KEY",   auth: "bearer" },
  deepseek:   { host: "https://api.deepseek.com",                  keyName: "DEEPSEEK_API_KEY",   auth: "bearer" },
  qwen:       { host: "https://dashscope-intl.aliyuncs.com",       keyName: "QWEN_API_KEY",       auth: "bearer" },
  kimi:       { host: "https://api.moonshot.ai",                   keyName: "KIMI_API_KEY",       auth: "bearer" },
  glm:        { host: "https://api.z.ai",                          keyName: "GLM_API_KEY",        auth: "bearer" },
  minimax:    { host: "https://api.minimax.io",                    keyName: "MINIMAX_API_KEY",    auth: "bearer" },
};

// Hop-by-hop / auth headers that must never be forwarded as-is
const STRIP_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive",
  "accept-encoding", "authorization", "x-api-key", "x-goog-api-key", "proxy-authorization",
]);
// fetch() auto-decompresses, so these response headers would lie to the client
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
]);

let keysCache: { mtimeMs: number; keys: Record<string, string> } = { mtimeMs: -1, keys: {} };
async function loadKeys(): Promise<Record<string, string>> {
  try {
    const st = await stat(KEYS_PATH);
    if (st.mtimeMs !== keysCache.mtimeMs) {
      keysCache = { mtimeMs: st.mtimeMs, keys: JSON.parse(await readFile(KEYS_PATH, "utf-8")) };
    }
  } catch {
    keysCache = { mtimeMs: -1, keys: {} };
  }
  return keysCache.keys;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || "/";
    if (url === "/health") {
      const keys = await loadKeys();
      // Report only WHICH providers have a key, never the values
      const configured = Object.entries(PROVIDERS)
        .filter(([, p]) => (keys[p.keyName] || "").trim())
        .map(([name]) => name);
      return sendJson(res, 200, { ok: true, configured });
    }

    const match = url.match(/^\/([a-z]+)(\/.*)?$/);
    const provider = match ? PROVIDERS[match[1]] : undefined;
    if (!match || !provider) return sendJson(res, 404, { error: "Unknown provider prefix" });

    const keys = await loadKeys();
    const realKey = (keys[provider.keyName] || "").trim();
    if (!realKey) {
      return sendJson(res, 401, { error: `No API key stored for '${match[1]}'. Add it in HydraOps Config.` });
    }

    let targetPath = match[2] || "/";
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !STRIP_REQUEST_HEADERS.has(name.toLowerCase())) {
        headers[name] = value;
      }
    }
    if (provider.auth === "bearer") {
      headers["authorization"] = `Bearer ${realKey}`;
    } else if (provider.auth === "x-api-key") {
      headers["x-api-key"] = realKey;
    } else {
      // google: header auth + replace any placeholder ?key= param
      headers["x-goog-api-key"] = realKey;
      targetPath = targetPath.replace(/([?&])key=[^&]*/, `$1key=${encodeURIComponent(realKey)}`);
    }

    const init: RequestInit & { duplex?: string } = { method: req.method, headers };
    if (req.method && !["GET", "HEAD"].includes(req.method)) {
      init.body = Readable.toWeb(req) as unknown as BodyInit;
      init.duplex = "half";
    }

    const upstream = await fetch(provider.host + targetPath, init);

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders[name] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      Readable.fromWeb(upstream.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error(`[key-proxy] ${req.method} ${req.url} failed:`, err?.message || err);
    if (!res.headersSent) sendJson(res, 502, { error: "Upstream request failed" });
    else res.end();
  }
});

// Loopback only: never reachable from the network
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[key-proxy] listening on http://127.0.0.1:${PORT} — keys file: ${KEYS_PATH}`);
});
