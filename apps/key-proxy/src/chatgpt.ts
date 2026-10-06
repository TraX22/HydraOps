/**
 * chatgpt.ts — "Sign in with ChatGPT": the user's ChatGPT plan (Plus/Pro) as a model source,
 * instead of an OpenAI API key.
 *
 * OpenAI offers open-source apps an OAuth flow (PKCE, dynamic client registration, no
 * secret) whose access token is accepted by the public Responses API and billed to the
 * user's plan, under a weekly cap the user sets in ChatGPT → Settings → Usage. This module
 * owns that flow end to end, in the one process that may hold credentials:
 *
 *   - sign-in: a loopback listener on 127.0.0.1 receives the browser's callback; the code
 *     is exchanged for tokens and the ID token is verified against OpenAI's JWKS;
 *   - storage: chatgpt.json next to keys.json (0600), with the issued client id, the host
 *     id, who signed in, the tokens and the model list;
 *   - refresh: access tokens last an hour, the refresh token 30 days and rotates;
 *   - proxy: /chatgpt/v1/* is forwarded with the bearer token. POST /v1/responses is
 *     adapted to what the plan route accepts (store:false, streaming only, no system role,
 *     a handful of parameters omitted) and, when the caller did not ask for a stream, the
 *     SSE is collected back into the plain JSON response the AI SDK expects.
 *
 * Protocol reference: developers.openai.com/siwc/token-sharing-open-source. The host and
 * issuer can be pointed at a stand-in with CHATGPT_ISSUER / CHATGPT_API_BASE (tests).
 */
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from "node:crypto";
import http from "node:http";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { keyStoreDir } from "@hydraops/config";

const issuer = () => (process.env.CHATGPT_ISSUER || "https://auth.openai.com").replace(/\/$/, "");
const apiBase = () => (process.env.CHATGPT_API_BASE || "https://api.openai.com").replace(/\/$/, "");
/** The audience the tokens are minted for; fixed by OpenAI, also against a stand-in. */
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";
const APP_NAME = "HydraOps";
const FIRST_CLIENT_ID = "dynamic_agent_client";
const SIGNIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
export const STORE_FILE = path.join(keyStoreDir, "chatgpt.json");

export interface ChatGPTModel { slug: string; name: string }
interface Store {
  version: 1;
  /** Stable id of this installation, sent as ext_agent_host_id. */
  hostId: string;
  /** The client id OpenAI issued at the first sign-in (oaiapp_…); reused afterwards. */
  clientId?: string;
  status: "disconnected" | "connected" | "reauth";
  subject?: string;
  email?: string;
  name?: string;
  scopes?: string[];
  accessToken?: string;
  expiresAt?: number;
  refreshToken?: string;
  connectedAt?: string;
  models?: ChatGPTModel[];
  modelsAt?: string;
}
export interface ChatGPTStatus {
  connected: boolean;
  status: Store["status"];
  email?: string;
  name?: string;
  connectedAt?: string;
  models: ChatGPTModel[];
  modelsAt?: string;
  /** The sign-in in progress: waiting for the browser, or (`finishing`) exchanging the code it brought back. */
  pending: { url: string; expiresAt: string; finishing?: boolean } | null;
  lastError?: string;
}

/** A failure the caller can show as it is: the code names it, the message explains it. */
export class ChatGPTError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
/** What leaves this process about an error: a ChatGPTError says it all; anything else stays in the log. */
function safeMessage(e: unknown, fallback: string): string {
  if (e instanceof ChatGPTError) return e.message;
  console.error(`[key-proxy] chatgpt: ${fallback}:`, e instanceof Error ? e.message : e);
  return fallback;
}

// ─── Storage ────────────────────────────────────────────────────────────────

let cache: Store | null = null;
async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, "utf-8"));
    if (raw && raw.version === 1 && typeof raw.hostId === "string") cache = raw as Store;
  } catch { /* no store yet, or unreadable: start over */ }
  cache ??= { version: 1, hostId: `urn:uuid:${randomUUID()}`, status: "disconnected" };
  return cache;
}
async function save(store: Store): Promise<void> {
  cache = store;
  await mkdir(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, STORE_FILE);
}
/** Test hook: forget the cached store (the file is re-read). */
export function resetChatGPTCache(): void { cache = null; }

/** "p•••@•••.com": enough to recognise the account, not enough to publish it. */
export function maskEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return `${email[0]}•••@•••${dot > 0 ? domain.slice(dot) : ""}`;
}

// ─── OpenAI endpoints ───────────────────────────────────────────────────────

interface Endpoints { authorize: string; token: string; jwks: string; revoke?: string }
let endpointsCache: { issuer: string; value: Endpoints } | null = null;
async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, body };
}
/** OpenID discovery, with the documented paths as the fallback when it is not reachable. */
async function endpoints(): Promise<Endpoints> {
  const iss = issuer();
  if (endpointsCache?.issuer === iss) return endpointsCache.value;
  let value: Endpoints = { authorize: `${iss}/api/accounts/authorize`, token: `${iss}/api/accounts/oauth/token`, jwks: `${iss}/.well-known/jwks.json` };
  try {
    const { ok, body } = await fetchJson(`${iss}/.well-known/openid-configuration`);
    const sameOrigin = (u: unknown) => typeof u === "string" && new URL(u).origin === new URL(iss).origin;
    if (ok && body && sameOrigin(body.authorization_endpoint) && sameOrigin(body.token_endpoint) && sameOrigin(body.jwks_uri)) {
      value = { authorize: body.authorization_endpoint, token: body.token_endpoint, jwks: body.jwks_uri, revoke: sameOrigin(body.revocation_endpoint) ? body.revocation_endpoint : undefined };
    }
  } catch { /* fallback above */ }
  endpointsCache = { issuer: iss, value };
  return value;
}

// ─── ID token verification (RS256 / ES256 against the JWKS) ─────────────────

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function verifyIdToken(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email?: string; name?: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new ChatGPTError("invalid_id_token", "ChatGPT returned an identity that cannot be read.");
  let header: any, payload: any;
  try { header = JSON.parse(b64url(parts[0]).toString("utf-8")); payload = JSON.parse(b64url(parts[1]).toString("utf-8")); }
  catch { throw new ChatGPTError("invalid_id_token", "ChatGPT returned an identity that cannot be read."); }
  const { jwks } = await endpoints();
  const { ok, body } = await fetchJson(jwks).catch(() => ({ ok: false, status: 0, body: null }));
  if (!ok || !Array.isArray(body?.keys)) throw new ChatGPTError("identity_unavailable", "ChatGPT's signing keys could not be fetched; try again in a moment.", 503);
  const jwk = body.keys.find((k: any) => k.kid === header.kid) ?? (body.keys.length === 1 ? body.keys[0] : undefined);
  if (!jwk) throw new ChatGPTError("invalid_id_token", "ChatGPT's identity was signed with an unknown key.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64url(parts[2]);
  const alg = String(header.alg || "RS256");
  const valid = alg === "ES256"
    ? verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)
    : alg === "RS256" ? verifySignature("sha256", data, key, sig) : false;
  if (!valid) throw new ChatGPTError("invalid_id_token", "ChatGPT's identity signature does not check out.");
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer() || !aud.includes(clientId) || typeof payload.exp !== "number" || payload.exp < now - 300
      || typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && payload.nonce !== nonce)) {
    throw new ChatGPTError("invalid_id_token", "ChatGPT's identity does not belong to this sign-in.");
  }
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined, name: typeof payload.name === "string" ? payload.name : undefined };
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

const REAUTH_CODES = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client"]);
const errorCode = (body: any): string => String(body?.error?.code ?? body?.error ?? body?.code ?? "");
const errorMessage = (body: any, fallback: string): string => String(body?.error?.message ?? body?.error_description ?? body?.message ?? (typeof body?.error === "string" ? body.error : "") ?? fallback) || fallback;

async function tokenRequest(form: Record<string, string>): Promise<any> {
  const { token } = await endpoints();
  const { ok, status, body } = await fetchJson(token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  if (!ok) throw new ChatGPTError(errorCode(body) || `http_${status}`, errorMessage(body, `ChatGPT's token endpoint answered ${status}.`), status);
  if (typeof body?.access_token !== "string" || typeof body?.expires_in !== "number") {
    throw new ChatGPTError("invalid_token_response", "ChatGPT returned incomplete credentials; sign in again.");
  }
  return body;
}

let refreshing: Promise<string> | null = null;
/** A valid access token, refreshed when it is about to expire; throws when there is none. */
export async function accessToken(): Promise<string> {
  const store = await load();
  if (store.status === "reauth") throw new ChatGPTError("chatgpt_reauth_required", "The ChatGPT connection expired: sign in again in Config.", 401);
  if (store.status !== "connected" || !store.accessToken) throw new ChatGPTError("chatgpt_not_connected", "No ChatGPT account is connected: sign in in Config.", 401);
  if ((store.expiresAt ?? 0) - Date.now() > REFRESH_AHEAD_MS) return store.accessToken;
  refreshing ??= (async () => {
    try {
      if (!store.refreshToken || !store.clientId) throw new ChatGPTError("invalid_grant", "no refresh token");
      const data = await tokenRequest({ grant_type: "refresh_token", client_id: store.clientId, refresh_token: store.refreshToken, resource: RESOURCE });
      const next: Store = {
        ...store,
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : store.refreshToken,
        scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : store.scopes,
      };
      await save(next);
      console.log("[key-proxy] chatgpt: access token refreshed");
      return next.accessToken!;
    } catch (e: any) {
      if (e instanceof ChatGPTError && REAUTH_CODES.has(e.code)) {
        // The grant is gone for good: keep who it was (and the client id) so the next
        // sign-in is a re-authorisation, but nothing here can call the API any more.
        await save({ ...store, status: "reauth", accessToken: undefined, expiresAt: undefined, refreshToken: undefined });
        console.warn(`[key-proxy] chatgpt: refresh rejected (${e.code}); sign-in required again`);
        throw new ChatGPTError("chatgpt_reauth_required", "The ChatGPT connection expired: sign in again in Config.", 401);
      }
      throw e instanceof ChatGPTError ? e : new ChatGPTError("refresh_failed", `The ChatGPT token could not be refreshed: ${e?.message ?? e}`, 503);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ─── Models ─────────────────────────────────────────────────────────────────

/** The models the plan serves to this app, as OpenAI lists them for the token. */
export async function refreshModels(): Promise<ChatGPTModel[]> {
  const token = await accessToken();
  const { ok, status, body } = await fetchJson(`${apiBase()}/v1/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!ok) throw new ChatGPTError(errorCode(body) || `http_${status}`, errorMessage(body, `ChatGPT's model list answered ${status}.`), status);
  const list: ChatGPTModel[] = [];
  // The plan route lists {models:[{slug, display_name, visibility}]}; the API-key route {data:[{id}]}.
  for (const m of Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : []) {
    const slug = typeof m?.slug === "string" ? m.slug : typeof m?.id === "string" ? m.id : "";
    if (!slug || (m.visibility !== undefined && m.visibility !== "list")) continue;
    list.push({ slug, name: typeof m.display_name === "string" && m.display_name ? m.display_name : slug });
  }
  const store = await load();
  await save({ ...store, models: list, modelsAt: new Date().toISOString() });
  return list;
}

// ─── Sign-in ────────────────────────────────────────────────────────────────

interface Pending { state: string; nonce: string; verifier: string; url: string; expiresAt: number; server: http.Server; timer: NodeJS.Timeout; redirectUri: string }
let pending: Pending | null = null;
// The callback arrived and the code is being exchanged: a second or two in which the status
// must still say "in progress", or the app would show "not connected" and the user would start again.
let finishing: Pending | null = null;
let lastError: string | undefined;

function closePending(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending.server.closeAllConnections?.();
  pending = null;
}

/** Forgets the sign-in in progress (the browser tab, if still open, lands on "expired"). */
export function cancelSignIn(): void {
  if (pending) lastError = undefined;
  closePending();
}

/**
 * Starts a sign-in: listens for the callback on a loopback port and returns the URL the
 * user has to open in a browser ON THIS MACHINE (the redirect goes to 127.0.0.1).
 */
export async function startSignIn(): Promise<{ url: string; expiresAt: string }> {
  closePending();
  lastError = undefined;
  const store = await load();
  const { authorize } = await endpoints();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const server = http.createServer((req, res) => onCallback(req, res));
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const url = new URL(authorize);
  url.search = new URLSearchParams({
    client_id: store.clientId || FIRST_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ext_agent_host_id: store.hostId,
  }).toString();
  if (!store.clientId) url.searchParams.set("agent_name_hint", APP_NAME);
  if (store.email) url.searchParams.set("login_hint", store.email);
  const expiresAt = Date.now() + SIGNIN_TIMEOUT_MS;
  const timer = setTimeout(() => { lastError = "The sign-in expired: nobody finished it in the browser within 10 minutes."; closePending(); }, SIGNIN_TIMEOUT_MS);
  timer.unref?.();
  pending = { state, nonce, verifier, url: url.toString(), expiresAt, server, timer, redirectUri };
  console.log(`[key-proxy] chatgpt: sign-in started, callback on ${redirectUri}`);
  return { url: pending.url, expiresAt: new Date(expiresAt).toISOString() };
}

const page = (title: string, text: string) => `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title><style>body{font:17px system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:24px;color:#1a1a2e}h1{font-size:24px}p{color:#4b5563}</style><h1>${title}</h1><p>${text}</p></html>`;

function onCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  const p = pending;
  const host = p ? new URL(p.redirectUri).host : "";
  let url: URL;
  try { url = new URL(req.url ?? "/", `http://${host || "127.0.0.1"}`); } catch { res.writeHead(400).end("Bad request"); return; }
  if (!p || req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== host) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(page("HydraOps", "Este enlace ya no sirve. Volvé a HydraOps y empezá de nuevo. · This link is no longer valid: go back to HydraOps and start again."));
    return;
  }
  const got = Buffer.from(url.searchParams.get("state") ?? "");
  const want = Buffer.from(p.state);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("HydraOps", "Este enlace no corresponde al inicio de sesión en curso. · This link does not match the sign-in in progress."));
    return;
  }
  if (url.searchParams.has("error")) {
    lastError = `ChatGPT declined the sign-in: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("HydraOps", "No se conectó. Podés cerrar esta pestaña y volver a HydraOps. · Not connected; you can close this tab."));
    closePending();
    return;
  }
  const code = url.searchParams.get("code") || "";
  const clientId = url.searchParams.get("client_id") || "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("HydraOps", "Listo: HydraOps está terminando de conectarse. Podés cerrar esta pestaña. · Done: HydraOps is finishing the connection; you can close this tab."));
  closePending();
  finishing = p;
  void finishSignIn(p, code, clientId).finally(() => { if (finishing === p) finishing = null; });
}

async function finishSignIn(p: Pending, code: string, returnedClientId: string): Promise<void> {
  try {
    const store = await load();
    const clientId = returnedClientId || store.clientId || "";
    if (!code || !clientId || clientId === FIRST_CLIENT_ID || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) {
      throw new ChatGPTError("registration_incomplete", "ChatGPT did not complete the app registration; try signing in again.");
    }
    if (store.clientId && returnedClientId && returnedClientId !== store.clientId) {
      throw new ChatGPTError("registration_mismatch", "ChatGPT answered for a different app registration; try signing in again.");
    }
    // The issued client id is kept even if the exchange below fails: a retry must not register another app.
    if (!store.clientId) await save({ ...store, clientId });
    const data = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE });
    if (typeof data.id_token !== "string") throw new ChatGPTError("invalid_id_token", "ChatGPT did not say who signed in; try again.");
    const who = await verifyIdToken(data.id_token, clientId, p.nonce);
    if (store.subject && who.subject !== store.subject && store.status !== "disconnected") {
      throw new ChatGPTError("account_mismatch", "A different ChatGPT account signed in. Disconnect first to switch accounts.");
    }
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
    if (!scopes.includes("chatgpt.tokens.use.direct")) {
      throw new ChatGPTError("plan_not_granted", "The sign-in went through but the permission to use the ChatGPT plan was not granted. Sign in again and accept it.");
    }
    await save({
      ...(await load()),
      clientId,
      status: "connected",
      subject: who.subject,
      email: who.email,
      name: who.name,
      scopes,
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      connectedAt: new Date().toISOString(),
    });
    lastError = undefined;
    console.log(`[key-proxy] chatgpt: connected as ${maskEmail(who.email) ?? who.subject}`);
    await refreshModels().catch((e) => console.warn(`[key-proxy] chatgpt: models not listed yet: ${e?.message ?? e}`));
  } catch (e: any) {
    lastError = safeMessage(e, "The sign-in could not be completed; try again.");
    console.error(`[key-proxy] chatgpt: sign-in failed: ${lastError}`);
  }
}

/** Revokes the grant at OpenAI (best effort) and forgets the tokens; the client id and host id stay. */
export async function signOut(): Promise<void> {
  closePending();
  const store = await load();
  if (store.refreshToken && store.clientId) {
    try {
      const { revoke } = await endpoints();
      if (revoke) {
        await fetch(revoke, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: store.refreshToken, token_type_hint: "refresh_token", client_id: store.clientId }).toString(),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch (e: any) {
      console.warn(`[key-proxy] chatgpt: remote revocation did not go through (${e?.message ?? e}); the app can also be removed in ChatGPT Settings`);
    }
  }
  await save({ version: 1, hostId: store.hostId, clientId: store.clientId, status: "disconnected" });
  lastError = undefined;
  console.log("[key-proxy] chatgpt: disconnected");
}

export async function status(): Promise<ChatGPTStatus> {
  const s = await load();
  return {
    connected: s.status === "connected",
    status: s.status,
    email: maskEmail(s.email),
    name: s.name,
    connectedAt: s.connectedAt,
    models: s.models ?? [],
    modelsAt: s.modelsAt,
    pending: pending ? { url: pending.url, expiresAt: new Date(pending.expiresAt).toISOString() }
      : finishing ? { url: finishing.url, expiresAt: new Date(finishing.expiresAt).toISOString(), finishing: true } : null,
    lastError,
  };
}

/** Deletes the store file (tests). */
export async function forgetChatGPT(): Promise<void> {
  closePending();
  cache = null;
  lastError = undefined;
  await unlink(STORE_FILE).catch(() => {});
}

// ─── The Responses API under the plan ───────────────────────────────────────

/** Parameters the plan route rejects (developers.openai.com/siwc, "Preview limitations"). */
const DROPPED_PARAMS = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user"];

/** The request the plan route accepts: no stored state, developer instead of system, input as items. */
export function adaptResponsesBody(body: any): any {
  const out = { ...body };
  for (const k of DROPPED_PARAMS) delete out[k];
  out.store = false;
  if (typeof out.input === "string") out.input = [{ role: "user", content: out.input }];
  if (Array.isArray(out.input)) {
    out.input = out.input.map((item: any) => item && typeof item === "object" && item.role === "system" ? { ...item, role: "developer" } : item);
  }
  return out;
}

/** Parses an SSE stream of Responses events into the final response object. */
export async function collectResponsesStream(body: ReadableStream<Uint8Array>): Promise<{ status: number; json: any }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { status: number; json: any } | null = null;
  const handle = (data: string) => {
    if (!data || data === "[DONE]") return;
    let ev: any;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev?.type === "response.completed" || ev?.type === "response.incomplete") result ??= { status: 200, json: ev.response };
    else if (ev?.type === "response.failed") result ??= { status: 500, json: { error: ev.response?.error ?? { message: "The response failed." } } };
    else if (ev?.type === "error") result ??= { status: 500, json: { error: { code: ev.code, message: ev.message ?? "The response failed." } } };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        handle(data);
      }
      if (done) { if (buffer.trim()) handle(buffer.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n")); break; }
      if (result) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return result ?? { status: 502, json: { error: { code: "stream_interrupted", message: "ChatGPT's response ended before it was complete." } } };
}

const STRIP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding", "authorization", "proxy-authorization"]);
const STRIP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** /chatgpt/v1/*: forwards to OpenAI with the plan's bearer token. */
export async function proxy(req: http.IncomingMessage, res: http.ServerResponse, targetPath: string): Promise<void> {
  let token: string;
  try { token = await accessToken(); }
  catch (e: any) { return sendJson(res, e instanceof ChatGPTError ? e.status : 503, { error: { code: e instanceof ChatGPTError ? e.code : "chatgpt_unavailable", message: safeMessage(e, "The ChatGPT connection is not usable right now.") } }); }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string" && !STRIP_REQUEST.has(name.toLowerCase())) headers[name] = value;
  headers["authorization"] = `Bearer ${token}`;

  const isResponses = req.method === "POST" && targetPath.replace(/\?.*$/, "") === "/v1/responses";
  if (!isResponses) {
    const init: RequestInit & { duplex?: string } = { method: req.method, headers };
    if (req.method && !["GET", "HEAD"].includes(req.method)) { init.body = Readable.toWeb(req) as unknown as BodyInit; init.duplex = "half"; }
    const upstream = await fetch(apiBase() + targetPath, init);
    return relay(res, upstream);
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); }
  catch { return sendJson(res, 400, { error: { code: "invalid_json", message: "The request body is not JSON." } }); }
  const wantsStream = body?.stream === true;
  const adapted = { ...adaptResponsesBody(body), stream: true };
  headers["content-type"] = "application/json";
  headers["accept"] = "text/event-stream";
  const upstream = await fetch(`${apiBase()}/v1/responses`, { method: "POST", headers, body: JSON.stringify(adapted) });
  if (!upstream.ok || wantsStream || !upstream.body) return relay(res, upstream);
  const { status, json } = await collectResponsesStream(upstream.body);
  sendJson(res, status, json);
}

function relay(res: http.ServerResponse, upstream: Response): void {
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, name) => { if (!STRIP_RESPONSE.has(name.toLowerCase())) out[name] = value; });
  res.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(res);
  else res.end();
}

/** The HTTP surface the API uses: status, sign-in, cancel, sign-out, models. Returns false for other paths. */
export async function handleControl(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  try {
    if (path === "/status" && req.method === "GET") { sendJson(res, 200, await status()); return true; }
    if (path === "/signin" && req.method === "POST") { sendJson(res, 200, await startSignIn()); return true; }
    if (path === "/cancel" && req.method === "POST") { cancelSignIn(); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/signout" && req.method === "POST") { await signOut(); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/models" && (req.method === "POST" || req.method === "GET")) {
      const models = req.method === "POST" ? await refreshModels() : (await load()).models ?? [];
      sendJson(res, 200, { models });
      return true;
    }
    return false;
  } catch (e: any) {
    sendJson(res, e instanceof ChatGPTError ? e.status : 500, { error: { code: e instanceof ChatGPTError ? e.code : "chatgpt_failed", message: safeMessage(e, "The request to ChatGPT failed.") } });
    return true;
  }
}

/** Whether the plan can serve requests right now (for /health). */
export async function isConnected(): Promise<boolean> { return (await load()).status === "connected"; }
