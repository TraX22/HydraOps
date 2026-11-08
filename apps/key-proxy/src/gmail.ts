/**
 * gmail.ts — the user's Gmail accounts, connected to their own Google Cloud OAuth client.
 *
 * Gmail's API is free and its sign-in is OAuth 2.0 (with PKCE). The user creates an OAuth
 * client of the "Desktop app" type in their own Google Cloud project: free, no verification
 * by Google (the user owns the app), and a loopback redirect, so the browser comes back to
 * this computer's HydraOps (`http://127.0.0.1:<port>/api/integrations/gmail/callback`) with
 * the code; on a server, the user pastes the address the browser showed. Several Gmail
 * accounts can be connected through one client. This module owns, in the one process that
 * may hold credentials:
 *
 *   - the client: its id and secret (a Desktop client's secret is not secret in Google's
 *     eyes, but the token endpoint asks for it);
 *   - the sign-in per account: a state, a PKCE verifier and the authorize URL;
 *   - storage: gmail.json next to keys.json (0600), one entry per account with its tokens;
 *   - refresh: access tokens last an hour, the refresh token lasts until revoked (a client
 *     left in "Testing" in Google's console gets refresh tokens that expire in 7 days, and
 *     the account then asks to be connected again).
 *
 * What an account may be used for is chosen when it is connected (its grants: read, compose,
 * send; see gmail-ops.ts), and Google is asked for the scopes of those grants only. The tools
 * reach Gmail through `callOp` (every read, from the closed table) with the account's token.
 * Google's hosts can be pointed at a stand-in with GOOGLE_AUTH_BASE / GOOGLE_API_BASE (tests).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { KeystoreError, keyStoreDir, readStore, uploadsDir, writeStore } from "@hydraops/config";
import { grantsCoveredBy, isGrant, missingScopes, opNamed, opsPublic, scopesFor, type GmailGrant, type GmailOp } from "./gmail-ops.js";

const authBase = () => (process.env.GOOGLE_AUTH_BASE || "https://accounts.google.com").replace(/\/$/, "");
const tokenBase = () => (process.env.GOOGLE_TOKEN_BASE || process.env.GOOGLE_API_BASE || "https://oauth2.googleapis.com").replace(/\/$/, "");
const apiBase = () => (process.env.GOOGLE_API_BASE || "https://gmail.googleapis.com").replace(/\/$/, "");
const userinfoBase = () => (process.env.GOOGLE_API_BASE || "https://www.googleapis.com").replace(/\/$/, "");
const SIGNIN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
export const STORE_FILE = path.join(keyStoreDir, "gmail.json");

export interface GmailAccount {
  /** Google's stable account id (the `sub` of the id token / userinfo). */
  id: string;
  email: string;
  name: string;
  avatar?: string;
  /** The scopes Google granted, as it named them. */
  scopes: string[];
  /** What the user connected the account for; never more than the scopes allow. */
  grants: GmailGrant[];
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
  accounts: GmailAccount[];
}
/** What leaves this process: who is connected, never a token or the secret. */
export interface GmailAccountStatus { id: string; email: string; name: string; avatar?: string; status: GmailAccount["status"]; grants: GmailGrant[]; scopes: string[]; connectedAt: string; refreshedAt?: string }
export interface GmailStatus {
  appConfigured: boolean;
  clientId?: string;
  accounts: GmailAccountStatus[];
  pending: { url: string; expiresAt: string; finishing?: boolean } | null;
  lastError?: string;
}

export class GmailError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function safeMessage(e: unknown, fallback: string): string {
  if (e instanceof GmailError) return e.message;
  console.error(`[key-proxy] gmail: ${fallback}:`, e instanceof Error ? e.message : e);
  return fallback;
}

// ─── Storage ────────────────────────────────────────────────────────────────

let cache: Store | null = null;
async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await readStore<Store>(STORE_FILE);
    if (raw && raw.version === 1 && Array.isArray(raw.accounts)) cache = raw;
  } catch (e) {
    if (e instanceof KeystoreError) throw e; // undecryptable is not "no store": never start over on top of it
    /* unreadable: start over */
  }
  cache ??= { version: 1, accounts: [] };
  return cache;
}
async function save(store: Store): Promise<void> {
  cache = store;
  await writeStore(STORE_FILE, store);
}
/** Test hooks: forget the cached store, or delete the file. */
export function resetGmailCache(): void { cache = null; }
export async function forgetGmail(): Promise<void> { cancelConnect(); cache = null; lastError = undefined; await unlink(STORE_FILE).catch(() => {}); }

// ─── The client ─────────────────────────────────────────────────────────────

/** The id and secret of the user's OAuth client. An empty secret keeps the one stored (the UI never sees it). */
export async function setApp(clientId: string, clientSecret?: string): Promise<void> {
  const id = String(clientId || "").trim();
  if (!/^[A-Za-z0-9_.-]{20,200}$/.test(id)) throw new GmailError("bad_client_id", "That does not look like a Google OAuth client id (it ends in .apps.googleusercontent.com).");
  const store = await load();
  const secret = String(clientSecret || "").trim() || (store.clientId === id ? store.clientSecret : undefined);
  if (!secret) throw new GmailError("no_secret", "The client secret is needed with a new client id.");
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
const errorCode = (b: any): string | undefined => (typeof b?.error === "string" ? b.error : typeof b?.error?.status === "string" ? b.error.status.toLowerCase() : typeof b?.error?.code === "number" ? `http_${b.error.code}` : undefined);
const errorMessage = (b: any, fallback: string): string => (typeof b?.error_description === "string" ? b.error_description : typeof b?.error?.message === "string" ? b.error.message : fallback);

const REAUTH_CODES = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** The token endpoint, with the client's id and secret in the form (Google's way). */
async function tokenRequest(store: Store, form: Record<string, string>): Promise<any> {
  if (!store.clientId || !store.clientSecret) throw new GmailError("app_not_configured", "The Google OAuth client's id and secret are not set.", 400);
  const { ok, status, body } = await fetchJson(`${tokenBase()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...form, client_id: store.clientId, client_secret: store.clientSecret }).toString(),
  });
  if (!ok) throw new GmailError(errorCode(body) || `http_${status}`, errorMessage(body, `Google's token endpoint answered ${status}.`), status);
  if (typeof body?.access_token !== "string" || typeof body?.expires_in !== "number") {
    throw new GmailError("invalid_token_response", "Google returned incomplete credentials; connect the account again.");
  }
  return body;
}

/** Who the token belongs to: Google's account id, the address, the name and the picture. */
async function whoAmI(accessToken: string): Promise<{ id: string; email: string; name: string; avatar?: string }> {
  const { ok, status, body } = await fetchJson(`${userinfoBase()}/oauth2/v3/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!ok || typeof body?.sub !== "string" || typeof body?.email !== "string") {
    throw new GmailError(errorCode(body) || `http_${status}`, errorMessage(body, `Google did not say which account signed in (${status}).`), status);
  }
  return { id: body.sub, email: body.email.toLowerCase(), name: typeof body.name === "string" && body.name ? body.name : body.email, avatar: typeof body.picture === "string" ? body.picture : undefined };
}

// ─── Connecting an account ──────────────────────────────────────────────────

// `redirect`: the loopback address of this HydraOps' callback, sent with this sign-in; the code
// exchange must repeat it exactly. `grants`: what the account is being connected for.
interface Pending { state: string; verifier: string; url: string; expiresAt: number; timer: NodeJS.Timeout; redirect: string; grants: GmailGrant[] }
let pending: Pending | null = null;
let finishing: Pending | null = null;
let lastError: string | undefined;

export function cancelConnect(): void {
  if (pending) { clearTimeout(pending.timer); pending = null; }
}

/** A list of grants from outside: known names only, `read` always among them. */
function cleanGrants(raw: unknown): GmailGrant[] {
  const list = Array.isArray(raw) ? raw.filter(isGrant) : [];
  return [...new Set<GmailGrant>(["read", ...list])];
}
/** A loopback http address, or https: where a Desktop client may send the browser back. */
function checkRedirectUri(raw: string): string {
  const v = String(raw || "").trim();
  let u: URL;
  try { u = new URL(v); } catch { throw new GmailError("bad_redirect_uri", "The callback address is not a valid address."); }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback)) || u.hash || u.username || u.password) {
    throw new GmailError("bad_redirect_uri", "The callback address must be this computer's loopback (http://127.0.0.1:…) or an https address.");
  }
  return v;
}

/**
 * Starts the sign-in of one more account, for the grants given: returns the URL the user
 * opens in a browser, signed in to Google as the account to connect. Google sends the
 * browser to `redirect` with a code and the state; `finishConnect` takes them from there.
 */
export async function startConnect(grants: unknown, redirect: string): Promise<{ url: string; expiresAt: string; grants: GmailGrant[] }> {
  const store = await load();
  if (!store.clientId || !store.clientSecret) throw new GmailError("app_not_configured", "Set the Google OAuth client's id and secret first.");
  const redirectUri = checkRedirectUri(redirect);
  cancelConnect();
  lastError = undefined;
  const wanted = cleanGrants(grants);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${authBase()}/o/oauth2/v2/auth`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: store.clientId,
    redirect_uri: redirectUri,
    scope: scopesFor(wanted).join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    // A refresh token comes only with offline access, and only when the user consents again.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  }).toString();
  const expiresAt = Date.now() + SIGNIN_TIMEOUT_MS;
  const timer = setTimeout(() => { lastError = "The sign-in expired: nobody finished it in the browser within 10 minutes."; cancelConnect(); }, SIGNIN_TIMEOUT_MS);
  timer.unref?.();
  pending = { state, verifier, url: url.toString(), expiresAt, timer, redirect: redirectUri, grants: wanted };
  console.log(`[key-proxy] gmail: account sign-in started (${wanted.join(", ")})`);
  return { url: pending.url, expiresAt: new Date(expiresAt).toISOString(), grants: wanted };
}

/**
 * The browser came back (to this HydraOps' callback, or the user pasted the address): the
 * code is exchanged, the account identified and stored. A second connection of the same
 * account replaces its tokens; a different one is added.
 */
export async function finishConnect(code: string, state: string): Promise<GmailAccountStatus> {
  const p = pending;
  const got = Buffer.from(String(state || ""));
  const want = Buffer.from(p?.state ?? "");
  if (!p || !got.length || got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new GmailError("state_mismatch", "That address does not belong to the sign-in in progress: start again from HydraOps.");
  }
  if (!code) throw new GmailError("no_code", "Google sent no authorisation code; start again.");
  cancelConnect();
  finishing = p;
  try {
    const store = await load();
    const data = await tokenRequest(store, { grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier });
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
    // Google lets the user untick scopes on the consent screen: a grant whose scopes did not
    // come back is not kept (the card says which), and reading is the least an account needs.
    const covered = grantsCoveredBy(scopes);
    if (!covered.includes("read")) throw new GmailError("scope_missing", "Google did not grant reading the mailbox; connect again and tick every permission HydraOps asks for.");
    const grants = p.grants.filter((g) => covered.includes(g));
    const who = await whoAmI(data.access_token);
    const previous = store.accounts.find((a) => a.id === who.id);
    const account: GmailAccount = {
      ...who,
      scopes,
      grants,
      status: "connected",
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      // Google sends a refresh token on the first consent only unless prompt=consent (which it is); keep the old one if none came.
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : previous?.refreshToken,
      connectedAt: new Date().toISOString(),
    };
    if (!account.refreshToken) throw new GmailError("no_refresh_token", "Google sent no refresh token; remove HydraOps from the account's connected apps (myaccount.google.com) and connect again.");
    const others = (await load()).accounts.filter((a) => a.id !== who.id);
    await save({ ...(await load()), accounts: [...others, account].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)) });
    const notGranted = p.grants.filter((g) => !grants.includes(g));
    lastError = notGranted.length ? `${who.email} is connected, but Google did not grant: ${notGranted.join(", ")} (left unticked on the consent screen).` : undefined;
    console.log(`[key-proxy] gmail: connected ${who.email} (${grants.join(", ")})`);
    return publicAccount(account);
  } catch (e: any) {
    lastError = safeMessage(e, "The account could not be connected; try again.");
    console.error(`[key-proxy] gmail: sign-in failed: ${lastError}`);
    throw e instanceof GmailError ? e : new GmailError("connect_failed", lastError, 502);
  } finally {
    if (finishing === p) finishing = null;
  }
}

/**
 * Changes what a connected account may be used for. Taking a grant away is this side's
 * business; adding one the account's scopes do not cover needs a new sign-in, and the
 * error names the scopes so the card can offer exactly that.
 */
export async function setGrants(id: string, grants: unknown): Promise<GmailAccountStatus> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new GmailError("no_such_account", "That account is not connected.", 404);
  const wanted = cleanGrants(grants);
  const missing = missingScopes(wanted, account.scopes);
  if (missing.length) {
    const e = new GmailError("scopes_missing", `${account.email} was not connected with that permission; connect it again to add it.`, 409);
    (e as any).missing = missing;
    throw e;
  }
  const next: GmailAccount = { ...account, grants: wanted };
  await save({ ...store, accounts: store.accounts.map((a) => (a.id === id ? next : a)) });
  console.log(`[key-proxy] gmail: ${account.email} may now: ${wanted.join(", ")}`);
  return publicAccount(next);
}

/** Forgets one account's tokens (revoking them at Google, best effort). The client stays. */
export async function disconnect(id: string): Promise<void> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new GmailError("no_such_account", "That account is not connected.", 404);
  const token = account.refreshToken || account.accessToken;
  if (token) {
    try {
      await fetch(`${tokenBase()}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e: any) {
      console.warn(`[key-proxy] gmail: revocation did not go through (${e?.message ?? e}); the app can also be removed at myaccount.google.com`);
    }
  }
  await save({ ...store, accounts: store.accounts.filter((a) => a.id !== id) });
  console.log(`[key-proxy] gmail: disconnected ${account.email}`);
}

// ─── Tokens for the tools ───────────────────────────────────────────────────

const refreshing = new Map<string, Promise<string>>();
/** A valid access token for one account, refreshed when about to expire; throws when it needs a new sign-in. */
export async function accessToken(id: string): Promise<string> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new GmailError("no_such_account", "That Gmail account is not connected.", 404);
  if (account.status === "reauth" || !account.accessToken) throw new GmailError("gmail_reauth_required", `The connection of ${account.email} expired: connect it again in Tools → Gmail.`, 401);
  if ((account.expiresAt ?? 0) - Date.now() > REFRESH_AHEAD_MS) return account.accessToken;
  let job = refreshing.get(id);
  if (!job) {
    job = (async () => {
      try {
        if (!account.refreshToken) throw new GmailError("invalid_grant", "no refresh token");
        const data = await tokenRequest(store, { grant_type: "refresh_token", refresh_token: account.refreshToken });
        const fresh = await load();
        const next: GmailAccount = {
          ...(fresh.accounts.find((a) => a.id === id) ?? account),
          accessToken: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
          refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : account.refreshToken,
          refreshedAt: new Date().toISOString(),
        };
        await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === id ? next : a)) });
        console.log(`[key-proxy] gmail: token refreshed for ${account.email}`);
        return next.accessToken!;
      } catch (e: any) {
        if (e instanceof GmailError && REAUTH_CODES.has(e.code)) {
          const fresh = await load();
          await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === id ? { ...a, status: "reauth", accessToken: undefined, expiresAt: undefined, refreshToken: undefined } : a)) });
          console.warn(`[key-proxy] gmail: refresh rejected for ${account.email} (${e.code}); sign-in required again`);
          throw new GmailError("gmail_reauth_required", `The connection of ${account.email} expired: connect it again in Tools → Gmail.`, 401);
        }
        throw e instanceof GmailError ? e : new GmailError("refresh_failed", `The Google token could not be refreshed: ${e?.message ?? e}`, 503);
      } finally {
        refreshing.delete(id);
      }
    })();
    refreshing.set(id, job);
  }
  return job;
}

// ─── The closed table (gmail-ops.ts) ────────────────────────────────────────

export interface GmailCallResult {
  op: string;
  /** Gmail's answer as it came. */
  body: any;
}
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const PARAM_MAX = 2048;

/**
 * One operation of the table, as one account. The path's placeholders and the query are
 * filled from `params` under the table's rules (ids as Gmail spells them, only the listed
 * query parameters, maxResults within bounds). Nothing else about the request is the caller's.
 */
export async function callOp(accountId: string, opName: unknown, params: unknown): Promise<GmailCallResult> {
  const op = opNamed(opName);
  if (!op) throw new GmailError("unknown_op", `"${String(opName).slice(0, 40)}" is not a Gmail operation HydraOps performs.`);
  const p: Record<string, unknown> = params && typeof params === "object" ? (params as any) : {};
  const store = await load();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) throw new GmailError("no_such_account", "That Gmail account is not connected.", 404);
  if (!account.grants.includes(op.grant)) throw new GmailError("grant_missing", `${account.email} was not connected for "${op.grant}".`, 403);
  if (missingScopes([op.grant], account.scopes).length) throw new GmailError("scopes_missing", `${account.email} lacks the Google permission for this; connect it again with "${op.grant}".`, 403);
  const url = new URL(`${apiBase()}/gmail/v1/users/me${fillPath(op, p)}`);
  for (const key of op.query) {
    const v = p[key];
    if (v === undefined || v === null || v === "") continue;
    const s = String(v).slice(0, PARAM_MAX);
    if (key === "maxResults" && op.results) {
      const n = Math.round(Number(s));
      if (!Number.isFinite(n)) continue;
      url.searchParams.set(key, String(Math.min(op.results[1], Math.max(op.results[0], n))));
    } else if (key === "labelIds" || key === "metadataHeaders") {
      // Repeated parameters: one value or a list.
      for (const item of (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean)) url.searchParams.append(key, item.slice(0, 200));
    } else url.searchParams.set(key, s);
  }
  for (const [k, v] of Object.entries(op.fixed ?? {})) url.searchParams.set(k, v);
  // A write's body: a message built by `compose` (its raw form and thread).
  let payload: string | undefined;
  if (op.body === "message") {
    const raw = String(p.raw ?? "");
    if (!/^[A-Za-z0-9_-]{10,}$/.test(raw)) throw new GmailError("bad_message", "The message to send or save is missing.");
    const message: Record<string, string> = { raw };
    if (typeof p.threadId === "string" && ID_RE.test(p.threadId)) message.threadId = p.threadId;
    payload = JSON.stringify(op.path.startsWith("/drafts") ? { message } : message);
  }
  const token = await accessToken(accountId);
  const { ok, status, body } = await fetchJson(url.toString(), {
    method: op.method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload,
  }, 60_000);
  if (status === 401) {
    // The token was refused outright (access revoked at myaccount.google.com, the client deleted): a new sign-in is the only way back.
    const fresh = await load();
    await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === accountId ? { ...a, status: "reauth", accessToken: undefined, expiresAt: undefined, refreshToken: undefined } : a)) });
    throw new GmailError("gmail_reauth_required", `Google no longer accepts the connection of ${account.email}: connect it again in Tools → Gmail.`, 401);
  }
  if (status === 429) throw new GmailError("rate_limited", `Google is rate limiting this (${op.name}) for the moment; try again in a few minutes.`, 429);
  if (status === 404) throw new GmailError("not_found", `Gmail has no such ${op.name === "thread" ? "thread" : op.name === "attachment" ? "attachment" : "message"} in ${account.email}.`, 404);
  if (!ok) throw new GmailError(errorCode(body) || `http_${status}`, errorMessage(body, `Gmail refused the request (${status}).`), status);
  if (op.kind === "write") console.log(`[key-proxy] gmail: ${op.name} as ${account.email}${p.id ? ` (${String(p.id).slice(0, 40)})` : ""}`);
  return { op: op.name, body };
}

// ─── Writing a message (drafts and sending) ─────────────────────────────────

export interface ComposeMessage {
  to?: unknown; cc?: unknown; bcc?: unknown;
  subject?: unknown; text?: unknown;
  /** The id of a message this one answers: its thread, subject and headers are taken from it; `to` defaults to its sender. */
  replyTo?: unknown;
  /** The id of a message this one forwards: its text and attachments are included. */
  forward?: unknown;
  /** File names from the user's attachments (storage/uploads), by base name. */
  attachments?: unknown;
  /** For draft_update: the draft replaced. */
  draftId?: unknown;
}
export interface ComposeResult { kind: "draft" | "draft_update" | "send"; id: string; messageId?: string; threadId?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; attachments: string[] }
const TEXT_MAX = 100_000;
const SUBJECT_MAX = 500;
const RECIPIENTS_MAX = 50;
const ATTACHMENTS_MAX = 20;
const ATTACHMENTS_TOTAL_MAX = 25 * 1024 * 1024;
const ADDRESS_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const CONTENT_TYPES: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".glb": "model/gltf-binary" };

/** A header value as RFC 2047 wants it when it is not plain ASCII. */
const encodeHeader = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf-8").toString("base64")}?=`);
const b64lines = (buf: Buffer): string => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
/** "Name <user@host>" or "user@host", checked and with the name encoded; anything else is refused. */
function cleanAddress(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/[\r\n]/g, "");
  const m = s.match(/^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/);
  const name = (m ? m[1] ?? "" : "").trim();
  const addr = (m ? m[2] : s).trim();
  if (!ADDRESS_RE.test(addr) || addr.length > 254) throw new GmailError("bad_address", `"${s.slice(0, 60)}" is not an e-mail address.`);
  return name ? `${encodeHeader(name)} <${addr}>` : addr;
}
const addressList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[;,]/) : []).map(cleanAddress);
/** The attachment's real path, inside the uploads folder, or an error. */
async function attachmentPath(ref: unknown): Promise<string> {
  const name = path.basename(String(ref ?? "").replace(/\\/g, "/").trim());
  const real = await realpath(path.join(uploadsDir, name)).catch(() => "");
  const root = await realpath(uploadsDir).catch(() => path.resolve(uploadsDir));
  if (!name || !real || path.dirname(real) !== root || !(await stat(real)).isFile()) throw new GmailError("bad_attachment", `"${name || String(ref).slice(0, 40)}" is not one of the files attached in HydraOps.`);
  return real;
}
interface Part { name: string; type: string; bytes: Buffer }
/** An RFC 822 message, base64url, as Gmail's `raw` wants it. */
function buildRaw(h: { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; inReplyTo?: string; references?: string }, text: string, files: Part[]): string {
  const lines: string[] = [`From: ${h.from}`];
  if (h.to.length) lines.push(`To: ${h.to.join(", ")}`);
  if (h.cc.length) lines.push(`Cc: ${h.cc.join(", ")}`);
  if (h.bcc.length) lines.push(`Bcc: ${h.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(h.subject)}`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0");
  if (h.inReplyTo) lines.push(`In-Reply-To: ${h.inReplyTo}`);
  if (h.references) lines.push(`References: ${h.references}`);
  const textPart = ["Content-Type: text/plain; charset=\"UTF-8\"", "Content-Transfer-Encoding: base64", "", b64lines(Buffer.from(text, "utf-8"))].join("\r\n");
  let body: string;
  if (!files.length) body = textPart;
  else {
    const boundary = `hydraops_${randomBytes(12).toString("hex")}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    body = [
      `--${boundary}`, textPart,
      ...files.flatMap((f) => [`--${boundary}`, `Content-Type: ${f.type}; name="${f.name.replace(/"/g, "")}"`, `Content-Disposition: attachment; filename="${f.name.replace(/"/g, "")}"`, "Content-Transfer-Encoding: base64", "", b64lines(f.bytes)]),
      `--${boundary}--`,
    ].join("\r\n");
  }
  // Without attachments the text part's own headers follow the message headers; with them, a blank line ends the headers first.
  return Buffer.from(files.length ? `${lines.join("\r\n")}\r\n\r\n${body}` : `${lines.join("\r\n")}\r\n${body}`, "utf-8").toString("base64url");
}
/** The headers of a message, by name (lower case), from a Gmail message. */
const headersOf = (msg: any): Record<string, string> => Object.fromEntries((Array.isArray(msg?.payload?.headers) ? msg.payload.headers : []).map((h: any) => [String(h?.name ?? "").toLowerCase(), String(h?.value ?? "")]));
/** The readable text of a Gmail message (plain text first, HTML stripped otherwise), for a forward. */
function textOf(msg: any): string {
  const texts: string[] = []; const htmls: string[] = [];
  const walk = (part: any) => {
    if (!part || typeof part !== "object") return;
    if (Array.isArray(part.parts) && part.parts.length) { for (const q of part.parts) walk(q); return; }
    const mime = String(part.mimeType ?? "").toLowerCase();
    if (part.filename && part.body?.attachmentId) return;
    const data = typeof part.body?.data === "string" ? Buffer.from(part.body.data, "base64url").toString("utf-8") : "";
    if (mime === "text/plain" && data) texts.push(data); else if (mime === "text/html" && data) htmls.push(data);
  };
  walk(msg?.payload);
  // Blocks and tags are removed until none is left (a tag split by another tag would otherwise survive one pass).
  const strip = (s: string) => { let prev: string; let out = s; do { prev = out; out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ""); } while (out !== prev); out = out.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n"); do { prev = out; out = out.replace(/<[^>]*>?/g, " "); } while (out !== prev); return out.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", "#39": "'" })[e as string] ?? m).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); };
  return (texts.length ? texts.join("\n") : htmls.map(strip).join("\n")).trim();
}
const attachmentsOf = (msg: any): { name: string; type: string; id: string; size: number }[] => {
  const out: { name: string; type: string; id: string; size: number }[] = [];
  const walk = (part: any) => { if (!part || typeof part !== "object") return; if (Array.isArray(part.parts)) for (const q of part.parts) walk(q); if (part.filename && part.body?.attachmentId) out.push({ name: String(part.filename), type: String(part.mimeType || "application/octet-stream"), id: String(part.body.attachmentId), size: Number(part.body.size) || 0 }); };
  walk(msg?.payload);
  return out;
};

/**
 * A message written by an agent, saved as a draft (`draft`, `draft_update`) or sent (`send`),
 * as one account. The fields are checked here (addresses, lengths, attachments inside the
 * uploads folder), a reply takes its thread and headers from the message it answers, a forward
 * brings the original's text and attachments, and the RFC 822 message is built here: nothing
 * raw comes from outside. The API decides who may call what (sending only as the run of a
 * call the user approved); the grants decide what the account allows.
 */
export async function compose(accountId: string, kind: "draft" | "draft_update" | "send", msg: ComposeMessage): Promise<ComposeResult> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) throw new GmailError("no_such_account", "That Gmail account is not connected.", 404);
  const opName = kind === "draft" ? "draft_create" : kind === "draft_update" ? "draft_update" : "send";
  const op = opNamed(opName)!;
  if (!account.grants.includes(op.grant)) throw new GmailError("grant_missing", `${account.email} was not connected for "${op.grant}".`, 403);
  const draftId = kind === "draft_update" ? String(msg.draftId ?? "").trim() : "";
  if (kind === "draft_update" && !ID_RE.test(draftId)) throw new GmailError("bad_id", "The draft to change needs its id.");
  let to = addressList(msg.to), cc = addressList(msg.cc), bcc = addressList(msg.bcc);
  let subject = String(msg.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  let text = String(msg.text ?? "").replace(/\r\n/g, "\n");
  if (subject.length > SUBJECT_MAX) throw new GmailError("bad_subject", `The subject has up to ${SUBJECT_MAX} characters.`);
  if (text.length > TEXT_MAX) throw new GmailError("bad_text", `The text has up to ${TEXT_MAX} characters.`);
  const files: Part[] = [];
  const refs: unknown[] = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (refs.length > ATTACHMENTS_MAX) throw new GmailError("bad_attachment", `Up to ${ATTACHMENTS_MAX} attachments.`);
  for (const ref of refs) {
    const full = await attachmentPath(ref);
    files.push({ name: path.basename(full), type: CONTENT_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream", bytes: await readFile(full) });
  }
  let inReplyTo: string | undefined, references: string | undefined, threadId: string | undefined;
  const replyTo = String(msg.replyTo ?? "").trim();
  if (replyTo) {
    const { body: orig } = await callOp(accountId, "message", { id: replyTo, format: "metadata", metadataHeaders: ["Message-ID", "References", "Subject", "From", "Reply-To"] });
    const h = headersOf(orig);
    threadId = typeof orig?.threadId === "string" ? orig.threadId : undefined;
    inReplyTo = h["message-id"] || undefined;
    references = [h["references"], h["message-id"]].filter(Boolean).join(" ") || undefined;
    if (!to.length) to = addressList(h["reply-to"] || h["from"]);
    if (!subject) subject = /^re:/i.test(h["subject"] ?? "") ? h["subject"] : `Re: ${h["subject"] ?? ""}`.trim();
  }
  const forward = String(msg.forward ?? "").trim();
  if (forward) {
    const { body: orig } = await callOp(accountId, "message", { id: forward, format: "full" });
    const h = headersOf(orig);
    if (!subject) subject = /^fwd?:/i.test(h["subject"] ?? "") ? h["subject"] : `Fwd: ${h["subject"] ?? ""}`.trim();
    const quoted = [`---------- Forwarded message ----------`, `From: ${h["from"] ?? ""}`, `Date: ${h["date"] ?? ""}`, `Subject: ${h["subject"] ?? ""}`, `To: ${h["to"] ?? ""}`, h["cc"] ? `Cc: ${h["cc"]}` : "", "", textOf(orig)].filter((l) => l !== undefined).join("\n");
    text = text ? `${text}\n\n${quoted}` : quoted;
    if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX);
    for (const a of attachmentsOf(orig)) {
      if (files.length >= ATTACHMENTS_MAX) break;
      const { body: att } = await callOp(accountId, "attachment", { id: forward, attachment: a.id });
      if (typeof att?.data === "string") files.push({ name: a.name, type: a.type, bytes: Buffer.from(att.data, "base64url") });
    }
  }
  if (to.length + cc.length + bcc.length > RECIPIENTS_MAX) throw new GmailError("bad_address", `Up to ${RECIPIENTS_MAX} recipients.`);
  if (kind === "send" && !to.length && !cc.length && !bcc.length) throw new GmailError("no_recipient", "A message to send needs at least one recipient.");
  if (kind === "send" && !text.trim() && !files.length) throw new GmailError("bad_text", "A message to send needs some text.");
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > ATTACHMENTS_TOTAL_MAX) throw new GmailError("bad_attachment", `The attachments weigh ${Math.round(total / 1024 / 1024)} MB together; Gmail takes up to ${ATTACHMENTS_TOTAL_MAX / 1024 / 1024} MB.`);
  const raw = buildRaw({ from: `${encodeHeader(account.name || account.email)} <${account.email}>`, to, cc, bcc, subject, inReplyTo, references }, text, files);
  const { body } = await callOp(accountId, opName, { id: draftId || undefined, raw, threadId });
  const result: ComposeResult = {
    kind, id: String(body?.id ?? ""), messageId: typeof body?.message?.id === "string" ? body.message.id : typeof body?.id === "string" && kind === "send" ? body.id : undefined,
    threadId: typeof body?.message?.threadId === "string" ? body.message.threadId : typeof body?.threadId === "string" ? body.threadId : threadId,
    to, cc, bcc, subject, attachments: files.map((f) => f.name),
  };
  console.log(`[key-proxy] gmail: ${kind === "send" ? "sent" : kind === "draft" ? "draft saved" : "draft changed"} as ${account.email}: to ${to.join(", ") || "(nobody)"}, "${subject.slice(0, 60)}"${files.length ? `, ${files.length} attachment(s)` : ""}`);
  return result;
}

/** The path with its placeholders filled from the caller, checked. */
function fillPath(op: GmailOp, p: Record<string, unknown>): string {
  return op.path.replace(/:(id|attachment)/g, (_m, key: string) => {
    const v = String(p[key] ?? "").trim();
    if (!ID_RE.test(v)) throw new GmailError("bad_id", `"${v.slice(0, 40)}" is not a Gmail ${key === "attachment" ? "attachment" : "message or thread"} id.`);
    return encodeURIComponent(v);
  });
}

// ─── Status and control ─────────────────────────────────────────────────────

const publicAccount = (a: GmailAccount): GmailAccountStatus => ({ id: a.id, email: a.email, name: a.name, avatar: a.avatar, status: a.status, grants: [...a.grants], scopes: [...a.scopes], connectedAt: a.connectedAt, refreshedAt: a.refreshedAt });

export async function status(): Promise<GmailStatus> {
  const s = await load();
  return {
    appConfigured: !!(s.clientId && s.clientSecret),
    clientId: s.clientId,
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
/** The control endpoints take the API's own JSON requests only, never a browser's (see x.ts). */
function fromApi(req: import("node:http").IncomingMessage): boolean {
  if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return false;
  if (req.method !== "GET" && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return false;
  return true;
}
async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) { chunks.push(c as Buffer); if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) throw new GmailError("body_too_large", "Request too large.", 413); }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new GmailError("bad_json", "The request body is not JSON."); }
}

/** The control endpoints under /gmail/… (the API relays them; nothing here is reachable from the network). */
export async function handleControl(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): Promise<boolean> {
  try {
    if (!fromApi(req)) { sendJson(res, 403, { error: { code: "not_from_api", message: "The Gmail control endpoints take JSON requests from the API only." } }); return true; }
    if (path === "/status" && req.method === "GET") { sendJson(res, 200, await status()); return true; }
    if (path === "/ops" && req.method === "GET") { sendJson(res, 200, { ops: opsPublic() }); return true; }
    if (path === "/app" && req.method === "POST") { const b = await readBody(req); await setApp(b.clientId, b.clientSecret); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/connect" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, await startConnect(b.grants, String(b.redirectUri ?? ""))); return true; }
    if (path === "/grants" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, { ok: true, account: await setGrants(String(b.id ?? ""), b.grants) }); return true; }
    if (path === "/call" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, await callOp(String(b.accountId ?? ""), b.op, b.params)); return true; }
    if (path === "/compose" && req.method === "POST") {
      const b = await readBody(req);
      const kind = b.kind === "draft" || b.kind === "draft_update" || b.kind === "send" ? b.kind : null;
      if (!kind) throw new GmailError("bad_kind", "compose takes kind draft, draft_update or send.");
      sendJson(res, 200, await compose(String(b.accountId ?? ""), kind, b.message && typeof b.message === "object" ? b.message : {}));
      return true;
    }
    if (path === "/finish" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, { ok: true, account: await finishConnect(String(b.code ?? ""), String(b.state ?? "")) }); return true; }
    if (path === "/cancel" && req.method === "POST") { cancelConnect(); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/disconnect" && req.method === "POST") { const b = await readBody(req); await disconnect(String(b.id ?? "")); sendJson(res, 200, { ok: true }); return true; }
    return false;
  } catch (e: any) {
    sendJson(res, e instanceof GmailError ? e.status : 500, { error: { code: e instanceof GmailError ? e.code : "gmail_failed", message: safeMessage(e, "The request to Google failed."), ...(Array.isArray(e?.missing) ? { missing: e.missing } : {}) } });
    return true;
  }
}

/** Whether at least one account can be used right now (for /health). */
export async function hasAccounts(): Promise<boolean> { return (await load()).accounts.some((a) => a.status === "connected"); }
