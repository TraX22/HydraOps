/**
 * x.ts — the user's X accounts, connected to their own X developer app.
 *
 * X's API is pay-per-use and its sign-in is OAuth 2.0 with PKCE. One developer app (the
 * user's, with the credits) can be authorised by several X accounts: a project's account,
 * a brand's, a personal one. This module owns, in the one process that may hold
 * credentials:
 *
 *   - the app: the client id and client secret the user pasted (X treats a desktop or
 *     server app as a confidential client, so the token endpoint takes both);
 *   - the sign-in per account: a state, a PKCE verifier and the authorize URL; the browser
 *     comes back through X's registered callback (an https page that forwards to this
 *     computer, or the address the user pastes by hand) and the API relays the code here;
 *   - storage: x.json next to keys.json (0600), one entry per account with its tokens;
 *   - refresh: access tokens last two hours and the refresh token rotates on every use.
 *
 * Nothing here posts yet: the tools that publish come later and will ask this module for
 * a valid token per account (see `accessToken`). X's hosts can be pointed at a stand-in
 * with X_AUTH_BASE / X_API_BASE (tests).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { keyStoreDir } from "@hydraops/config";

const authBase = () => (process.env.X_AUTH_BASE || "https://x.com").replace(/\/$/, "");
const apiBase = () => (process.env.X_API_BASE || "https://api.x.com").replace(/\/$/, "");
/** The callback registered in the user's X app: X only takes https there, so a public page forwards to this computer. */
export const redirectUri = () => (process.env.X_REDIRECT_URI || "https://hydraops.org/x/callback").trim();
const SCOPES = "tweet.read tweet.write users.read media.write offline.access";
const SIGNIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
export const STORE_FILE = path.join(keyStoreDir, "x.json");

export interface XAccount {
  /** X's numeric user id: stable, unlike the handle. */
  id: string;
  username: string;
  name: string;
  avatar?: string;
  scopes: string[];
  status: "connected" | "reauth";
  accessToken?: string;
  expiresAt?: number;
  refreshToken?: string;
  connectedAt: string;
  refreshedAt?: string;
}
interface Store {
  version: 1;
  clientId?: string;
  clientSecret?: string;
  accounts: XAccount[];
}
/** What leaves this process: who is connected, never a token or the secret. */
export interface XAccountStatus { id: string; username: string; name: string; avatar?: string; status: XAccount["status"]; connectedAt: string; refreshedAt?: string }
export interface XStatus {
  appConfigured: boolean;
  clientId?: string;
  redirectUri: string;
  accounts: XAccountStatus[];
  pending: { url: string; expiresAt: string; finishing?: boolean } | null;
  lastError?: string;
}

export class XError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function safeMessage(e: unknown, fallback: string): string {
  if (e instanceof XError) return e.message;
  console.error(`[key-proxy] x: ${fallback}:`, e instanceof Error ? e.message : e);
  return fallback;
}

// ─── Storage ────────────────────────────────────────────────────────────────

let cache: Store | null = null;
async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, "utf-8"));
    if (raw && raw.version === 1 && Array.isArray(raw.accounts)) cache = raw as Store;
  } catch { /* no store yet, or unreadable: start over */ }
  cache ??= { version: 1, accounts: [] };
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
/** Test hooks: forget the cached store, or delete the file. */
export function resetXCache(): void { cache = null; }
export async function forgetX(): Promise<void> { cancelConnect(); cache = null; lastError = undefined; await unlink(STORE_FILE).catch(() => {}); }

// ─── The app ────────────────────────────────────────────────────────────────

/** The client id and secret of the user's X app. An empty secret keeps the one stored (the UI never sees it). */
export async function setApp(clientId: string, clientSecret?: string): Promise<void> {
  const id = String(clientId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new XError("bad_client_id", "That does not look like an X client id.");
  const store = await load();
  const secret = String(clientSecret || "").trim() || (store.clientId === id ? store.clientSecret : undefined);
  if (!secret) throw new XError("no_secret", "The client secret is needed with a new client id.");
  await save({ ...store, clientId: id, clientSecret: secret });
  lastError = undefined;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, body };
}
const errorCode = (b: any): string | undefined => (typeof b?.error === "string" ? b.error : typeof b?.error?.code === "string" ? b.error.code : undefined);
const errorMessage = (b: any, fallback: string): string => (typeof b?.error_description === "string" ? b.error_description : typeof b?.detail === "string" ? b.detail : typeof b?.title === "string" ? b.title : fallback);

const REAUTH_CODES = new Set(["invalid_grant", "invalid_request", "invalid_client", "unauthorized_client"]);

/** The token endpoint, as a confidential client: the app's id and secret in the Basic header. */
async function tokenRequest(store: Store, form: Record<string, string>): Promise<any> {
  if (!store.clientId || !store.clientSecret) throw new XError("app_not_configured", "The X app's client id and secret are not set.", 400);
  const basic = Buffer.from(`${store.clientId}:${store.clientSecret}`).toString("base64");
  const { ok, status, body } = await fetchJson(`${apiBase()}/2/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ ...form, client_id: store.clientId }).toString(),
  });
  if (!ok) throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X's token endpoint answered ${status}.`), status);
  if (typeof body?.access_token !== "string" || typeof body?.expires_in !== "number") {
    throw new XError("invalid_token_response", "X returned incomplete credentials; connect the account again.");
  }
  return body;
}

/** Who the token belongs to: id, handle, name and picture. */
async function whoAmI(accessToken: string): Promise<{ id: string; username: string; name: string; avatar?: string }> {
  const { ok, status, body } = await fetchJson(`${apiBase()}/2/users/me?user.fields=profile_image_url,name,username`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const d = body?.data;
  if (!ok || typeof d?.id !== "string" || typeof d?.username !== "string") {
    throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X did not say which account signed in (${status}).`), status);
  }
  return { id: d.id, username: d.username, name: typeof d.name === "string" ? d.name : d.username, avatar: typeof d.profile_image_url === "string" ? d.profile_image_url : undefined };
}

// ─── Connecting an account ──────────────────────────────────────────────────

interface Pending { state: string; verifier: string; url: string; expiresAt: number; timer: NodeJS.Timeout }
let pending: Pending | null = null;
let finishing: Pending | null = null;
let lastError: string | undefined;

export function cancelConnect(): void {
  if (pending) { clearTimeout(pending.timer); pending = null; }
}

/**
 * Starts the sign-in of one more account: returns the URL the user opens in a browser,
 * signed in to X as the account to connect. X sends the browser to the registered callback
 * with a code and the state; `finishConnect` takes them from there.
 */
export async function startConnect(): Promise<{ url: string; expiresAt: string }> {
  const store = await load();
  if (!store.clientId || !store.clientSecret) throw new XError("app_not_configured", "Set the X app's client id and secret first.");
  cancelConnect();
  lastError = undefined;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${authBase()}/i/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: store.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const expiresAt = Date.now() + SIGNIN_TIMEOUT_MS;
  const timer = setTimeout(() => { lastError = "The sign-in expired: nobody finished it in the browser within 10 minutes."; cancelConnect(); }, SIGNIN_TIMEOUT_MS);
  timer.unref?.();
  pending = { state, verifier, url: url.toString(), expiresAt, timer };
  console.log("[key-proxy] x: account sign-in started");
  return { url: pending.url, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * The browser came back (through the callback page, or the user pasted the address): the
 * code is exchanged, the account identified and stored. A second connection of the same
 * account replaces its tokens; a different one is added.
 */
export async function finishConnect(code: string, state: string): Promise<XAccountStatus> {
  const p = pending;
  const got = Buffer.from(String(state || ""));
  const want = Buffer.from(p?.state ?? "");
  if (!p || !got.length || got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new XError("state_mismatch", "That address does not belong to the sign-in in progress: start again from HydraOps.");
  }
  if (!code) throw new XError("no_code", "X sent no authorisation code; start again.");
  cancelConnect();
  finishing = p;
  try {
    const store = await load();
    const data = await tokenRequest(store, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: p.verifier });
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
    for (const needed of ["tweet.write", "users.read", "offline.access"]) {
      if (!scopes.includes(needed)) throw new XError("scope_missing", `X did not grant "${needed}"; connect again and accept every permission.`);
    }
    const who = await whoAmI(data.access_token);
    const account: XAccount = {
      ...who,
      scopes,
      status: "connected",
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      connectedAt: new Date().toISOString(),
    };
    const others = (await load()).accounts.filter((a) => a.id !== who.id);
    await save({ ...(await load()), accounts: [...others, account].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)) });
    lastError = undefined;
    console.log(`[key-proxy] x: connected @${who.username}`);
    return publicAccount(account);
  } catch (e: any) {
    lastError = safeMessage(e, "The account could not be connected; try again.");
    console.error(`[key-proxy] x: sign-in failed: ${lastError}`);
    throw e instanceof XError ? e : new XError("connect_failed", lastError, 502);
  } finally {
    if (finishing === p) finishing = null;
  }
}

/** Forgets one account's tokens (revoking them at X, best effort). The app stays. */
export async function disconnect(id: string): Promise<void> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new XError("no_such_account", "That account is not connected.", 404);
  if (account.refreshToken && store.clientId && store.clientSecret) {
    try {
      const basic = Buffer.from(`${store.clientId}:${store.clientSecret}`).toString("base64");
      await fetch(`${apiBase()}/2/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ token: account.refreshToken, token_type_hint: "refresh_token", client_id: store.clientId }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e: any) {
      console.warn(`[key-proxy] x: revocation did not go through (${e?.message ?? e}); the app can also be removed in X's settings`);
    }
  }
  await save({ ...store, accounts: store.accounts.filter((a) => a.id !== id) });
  console.log(`[key-proxy] x: disconnected @${account.username}`);
}

// ─── Tokens for the tools ───────────────────────────────────────────────────

const refreshing = new Map<string, Promise<string>>();
/** A valid access token for one account, refreshed when about to expire; throws when it needs a new sign-in. */
export async function accessToken(id: string): Promise<string> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new XError("no_such_account", "That X account is not connected.", 404);
  if (account.status === "reauth" || !account.accessToken) throw new XError("x_reauth_required", `The connection of @${account.username} expired: connect it again in Tools → X.`, 401);
  if ((account.expiresAt ?? 0) - Date.now() > REFRESH_AHEAD_MS) return account.accessToken;
  let job = refreshing.get(id);
  if (!job) {
    job = (async () => {
      try {
        if (!account.refreshToken) throw new XError("invalid_grant", "no refresh token");
        const data = await tokenRequest(store, { grant_type: "refresh_token", refresh_token: account.refreshToken });
        const fresh = await load();
        const next: XAccount = {
          ...(fresh.accounts.find((a) => a.id === id) ?? account),
          accessToken: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
          refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : account.refreshToken,
          refreshedAt: new Date().toISOString(),
        };
        await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === id ? next : a)) });
        console.log(`[key-proxy] x: token refreshed for @${account.username}`);
        return next.accessToken!;
      } catch (e: any) {
        if (e instanceof XError && REAUTH_CODES.has(e.code)) {
          const fresh = await load();
          await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === id ? { ...a, status: "reauth", accessToken: undefined, expiresAt: undefined, refreshToken: undefined } : a)) });
          console.warn(`[key-proxy] x: refresh rejected for @${account.username} (${e.code}); sign-in required again`);
          throw new XError("x_reauth_required", `The connection of @${account.username} expired: connect it again in Tools → X.`, 401);
        }
        throw e instanceof XError ? e : new XError("refresh_failed", `The X token could not be refreshed: ${e?.message ?? e}`, 503);
      } finally {
        refreshing.delete(id);
      }
    })();
    refreshing.set(id, job);
  }
  return job;
}

// ─── Status and control ─────────────────────────────────────────────────────

const publicAccount = (a: XAccount): XAccountStatus => ({ id: a.id, username: a.username, name: a.name, avatar: a.avatar, status: a.status, connectedAt: a.connectedAt, refreshedAt: a.refreshedAt });

export async function status(): Promise<XStatus> {
  const s = await load();
  return {
    appConfigured: !!(s.clientId && s.clientSecret),
    clientId: s.clientId,
    redirectUri: redirectUri(),
    accounts: s.accounts.map(publicAccount),
    pending: pending ? { url: pending.url, expiresAt: new Date(pending.expiresAt).toISOString() }
      : finishing ? { url: finishing.url, expiresAt: new Date(finishing.expiresAt).toISOString(), finishing: true } : null,
    lastError,
  };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) { chunks.push(c as Buffer); if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) throw new XError("body_too_large", "Request too large.", 413); }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new XError("bad_json", "The request body is not JSON."); }
}

/** The control endpoints under /x/… (the API relays them; nothing here is reachable from the network). */
export async function handleControl(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): Promise<boolean> {
  try {
    if (path === "/status" && req.method === "GET") { sendJson(res, 200, await status()); return true; }
    if (path === "/app" && req.method === "POST") { const b = await readBody(req); await setApp(b.clientId, b.clientSecret); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/connect" && req.method === "POST") { sendJson(res, 200, await startConnect()); return true; }
    if (path === "/finish" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, { ok: true, account: await finishConnect(String(b.code ?? ""), String(b.state ?? "")) }); return true; }
    if (path === "/cancel" && req.method === "POST") { cancelConnect(); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/disconnect" && req.method === "POST") { const b = await readBody(req); await disconnect(String(b.id ?? "")); sendJson(res, 200, { ok: true }); return true; }
    return false;
  } catch (e: any) {
    sendJson(res, e instanceof XError ? e.status : 500, { error: { code: e instanceof XError ? e.code : "x_failed", message: safeMessage(e, "The request to X failed.") } });
    return true;
  }
}

/** Whether at least one account can be used right now (for /health). */
export async function hasAccounts(): Promise<boolean> { return (await load()).accounts.some((a) => a.status === "connected"); }
