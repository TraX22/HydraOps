/**
 * guard.ts — HydraOps security guard (Hermes-style hardline layer).
 *
 * Every tool call (native + MCP) is wrapped here before reaching the model:
 *  1. Sensitive-path blocklist: arguments referencing credential files
 *     (keys.json, .env, .ssh, cloud creds...) are rejected unconditionally.
 *  2. Catastrophic-command blocklist: unambiguous destructive command syntax
 *     (rm -rf /, format c:, fork bombs...) is rejected in any argument,
 *     no matter which tool it goes through.
 *  3. Secret redaction: tool RESULTS are scanned for API-key/token shapes
 *     and redacted before the model ever sees them.
 *  4. SSRF guard (assertPublicUrl): used by fetch_url to keep agents away
 *     from loopback/private networks (key-proxy, API, router admin...).
 *
 * This is the "hardline blocklist" tier: it never prompts, it only blocks
 * the catastrophic. Finer-grained control stays in tools.md / MCP switches.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

// ---------------------------------------------------------------- paths ----

const SENSITIVE_PATH_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /keys\.json/i, label: "HydraOps key store" },
  { re: /[\\/](appdata[\\/]roaming[\\/])?hydraops[\\/]keys/i, label: "HydraOps key store" },
  { re: /(^|[\\/"'\s])\.env(\.\w+)?($|["'\s\\/])/i, label: ".env file" },
  { re: /[\\/]\.ssh([\\/]|$)/i, label: "SSH directory" },
  { re: /id_(rsa|ed25519|ecdsa|dsa)/i, label: "SSH private key" },
  { re: /[\\/]\.aws([\\/]|$)/i, label: "AWS credentials" },
  { re: /[\\/]\.azure([\\/]|$)/i, label: "Azure credentials" },
  { re: /gcloud[\\/].*credentials|application_default_credentials/i, label: "Google Cloud credentials" },
  { re: /\.git-credentials|_netrc|\.netrc|\.npmrc|\.pypirc/i, label: "stored credentials file" },
  { re: /system32[\\/]config[\\/](sam|system|security)\b/i, label: "Windows registry hive" },
  { re: /ntds\.dit/i, label: "Windows domain credential store" },
  { re: /user data[\\/].*(login data|cookies)/i, label: "browser credential store" },
];

// ------------------------------------------------------------- commands ----

// Only unambiguous destructive command syntax — a web_search query about
// "how to format a drive" must NOT trip this; `format c:` must.
const CATASTROPHIC_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+["']?([/~]|\/\*|\$home)/i, label: "recursive delete of root/home" },
  { re: /\bdel\s+\/[sq]\b.*\b[a-z]:\\/i, label: "recursive delete of a drive" },
  { re: /\brd\s+\/s\b.*\b[a-z]:\\/i, label: "recursive delete of a drive" },
  { re: /remove-item\b.*-recurse\b.*["'\s][a-z]:[\\/]?["'\s]|remove-item\s+["']?[a-z]:[\\/]?["']?\s+.*-recurse/i, label: "recursive delete of a drive root" },
  { re: /\bformat(\.com)?\s+[a-z]:/i, label: "drive format" },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
  { re: /%0\s*\|\s*%0/, label: "fork bomb" },
  { re: /\bmkfs(\.\w+)?\s/i, label: "filesystem format" },
  { re: /\bdd\s+.*\bof=\/dev\/(sd|hd|nvme|disk)/i, label: "raw disk overwrite" },
  { re: /vssadmin\b.*delete\s+shadows/i, label: "shadow copy deletion (ransomware pattern)" },
  { re: /wbadmin\b.*delete\s+(catalog|backup)/i, label: "backup deletion" },
  { re: /bcdedit\b.*(recoveryenabled\s+no|\/deletevalue)/i, label: "boot recovery tampering" },
  { re: /\bcipher\s+\/w/i, label: "disk wipe" },
  { re: /\breg\s+delete\s+["']?hklm/i, label: "HKLM registry deletion" },
  { re: /\bdiskpart\b.*\b(clean|delete\s+partition)/is, label: "partition deletion" },
];

// -------------------------------------------------------------- secrets ----

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,            // OpenAI / Anthropic (sk-ant-) / OpenRouter (sk-or-)
  /\bAIza[0-9A-Za-z_-]{30,}/g,           // Google
  /\bxai-[A-Za-z0-9]{20,}/g,             // xAI
  /\bgsk_[A-Za-z0-9]{20,}/g,             // Groq
  /\bhf_[A-Za-z0-9]{20,}/g,              // Hugging Face
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,     // GitHub fine-grained
  /\bglpat-[A-Za-z0-9_-]{15,}/g,         // GitLab
  /\bntn_[A-Za-z0-9]{20,}/g,             // Notion
  /\bAKIA[0-9A-Z]{16}\b/g,               // AWS access key id
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{25,}/g, // generic bearer token
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED:secret]");
  return out;
}

// ----------------------------------------------------------- deep walks ----

function collectStrings(value: unknown, acc: string[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc, depth + 1);
  else if (typeof value === "object") for (const v of Object.values(value)) collectStrings(v, acc, depth + 1);
}

function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out as unknown as T;
  }
  return value;
}

// --------------------------------------------------------------- checks ----

/** Returns a human-readable violation, or null if the args are clean. */
export function checkToolArgs(toolName: string, args: unknown): string | null {
  const strings: string[] = [];
  collectStrings(args, strings);
  for (const s of strings) {
    for (const { re, label } of SENSITIVE_PATH_PATTERNS) {
      if (re.test(s)) return `argument references a protected credential path (${label})`;
    }
    for (const { re, label } of CATASTROPHIC_PATTERNS) {
      if (re.test(s)) return `argument matches a catastrophic command pattern (${label})`;
    }
  }
  return null;
}

// ----------------------------------------------------------------- SSRF ----

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + reserved
    );
  }
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7)); // IPv4-mapped
  return false;
}

/**
 * Lanza si la URL apunta a espacio loopback/privado/link-local. Resuelve el
 * host primero, así `http://mi-router.lan` no se cuela.
 *
 * Devuelve la IP pública ya validada: quien haga la petición DEBE conectarse a
 * ESA dirección y no volver a resolver el DNS, o un DNS con TTL bajo (rebinding)
 * podría devolver una IP pública aquí y 127.0.0.1 en la conexión real. Ver el
 * dispatcher fijado en fetch_url.
 */
export async function assertPublicUrl(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked by security guard: protocol '${u.protocol}' is not allowed`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    throw new Error(`Blocked by security guard: '${host}' is an internal hostname`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked by security guard: '${host}' is a private/loopback address`);
    return host;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Cannot resolve host '${host}'`);
  }
  if (addrs.length === 0) throw new Error(`Cannot resolve host '${host}'`);
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`Blocked by security guard: '${host}' resolves to a private/loopback address`);
  }
  // La IP concreta a la que hay que conectarse; todas están validadas, se fija
  // la primera para que la conexión no re-resuelva.
  return addrs[0].address;
}

// -------------------------------------------------------------- wrapper ----

export interface GuardableTool {
  name: string;
  execute: (args: any) => Promise<any>;
  [k: string]: any;
}

/**
 * Returns a copy of the tool whose execute() enforces the blocklists on the
 * way in and redacts secrets on the way out. Violations return an error
 * string (not a throw) so both the AI SDK path and the local-LLM fallback
 * surface it to the model as a normal tool result.
 */
export function guardTool<T extends GuardableTool>(t: T): T {
  return {
    ...t,
    execute: async (args: any) => {
      const violation = checkToolArgs(t.name, args);
      if (violation) {
        console.warn(`[guard] BLOCKED ${t.name}: ${violation}`);
        return `⛔ Blocked by HydraOps security guard: ${violation}. This action is always forbidden — do not retry or try to work around it; tell the user it was blocked.`;
      }
      const result = await t.execute(args);
      return redactDeep(result);
    },
  };
}
