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
 * What an account may be used for is chosen when it is connected (its grants: read,
 * publish, engage, messages; see x-ops.ts), and X is asked for the scopes of those grants
 * only. The tools then reach X through two doors here: `postThread` (publishing) and
 * `callOp` (every read, from the closed table in x-ops.ts), both with the account's token.
 * X's hosts can be pointed at a stand-in with X_AUTH_BASE / X_API_BASE (tests).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { KeystoreError, keyStoreDir, readStore, uploadsDir, writeStore } from "@hydraops/config";
import { BASE_SCOPES, estimateUsd, grantsCoveredBy, isGrant, missingScopes, opNamed, opsPublic, scopesFor, type XGrant, type XOp } from "./x-ops.js";

const authBase = () => (process.env.X_AUTH_BASE || "https://x.com").replace(/\/$/, "");
const apiBase = () => (process.env.X_API_BASE || "https://api.x.com").replace(/\/$/, "");
/**
 * The callback registered in the user's X app. X only takes https there, so each user hosts
 * the forwarding page (x-callback.html, downloadable from Tools → X) on a public https
 * address of their own and saves that address with the app. X_REDIRECT_URI is a fallback
 * for headless setups; there is no shared default.
 */
const redirectUriOf = (s: Store) => (s.redirectUri || process.env.X_REDIRECT_URI || "").trim();
/** An https address with a host and no fragment: what X accepts as a callback. */
function checkRedirectUri(raw: string): string {
  const v = String(raw || "").trim();
  let u: URL;
  try { u = new URL(v); } catch { throw new XError("bad_redirect_uri", "The callback address is not a valid https address."); }
  if (u.protocol !== "https:" || !u.hostname || u.hash || u.username || u.password) throw new XError("bad_redirect_uri", "The callback address must be a plain https address (X takes nothing else).");
  return v;
}
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
  /** The scopes X granted, as it named them. */
  scopes: string[];
  /** What the user connected the account for; never more than the scopes allow. */
  grants: XGrant[];
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
  /** The callback address registered in the app (the user's own copy of the forwarding page). */
  redirectUri?: string;
  accounts: XAccount[];
}
/** What leaves this process: who is connected, never a token or the secret. */
export interface XAccountStatus { id: string; username: string; name: string; avatar?: string; status: XAccount["status"]; grants: XGrant[]; scopes: string[]; connectedAt: string; refreshedAt?: string }
export interface XStatus {
  appConfigured: boolean;
  clientId?: string;
  /** Empty until the user saves the address of their callback page. */
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
    const raw = await readStore<Store>(STORE_FILE);
    if (raw && raw.version === 1 && Array.isArray(raw.accounts)) {
      // An account connected before grants existed asked for the publishing scopes: it keeps
      // doing what its scopes allow.
      for (const a of raw.accounts) if (!Array.isArray(a.grants)) a.grants = grantsCoveredBy(Array.isArray(a.scopes) ? a.scopes : []);
      cache = raw;
    }
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
export function resetXCache(): void { cache = null; }
export async function forgetX(): Promise<void> { cancelConnect(); cache = null; lastError = undefined; await unlink(STORE_FILE).catch(() => {}); }

// ─── The app ────────────────────────────────────────────────────────────────

/**
 * The client id, secret and callback address of the user's X app. An empty secret keeps the
 * one stored (the UI never sees it); the callback address is required, it must be the one
 * registered in the app, character for character.
 */
export async function setApp(clientId: string, clientSecret?: string, redirect?: string): Promise<void> {
  const id = String(clientId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new XError("bad_client_id", "That does not look like an X client id.");
  const store = await load();
  const secret = String(clientSecret || "").trim() || (store.clientId === id ? store.clientSecret : undefined);
  if (!secret) throw new XError("no_secret", "The client secret is needed with a new client id.");
  const redirectUri = redirect !== undefined && String(redirect).trim() ? checkRedirectUri(redirect) : store.redirectUri;
  if (!redirectUri && !process.env.X_REDIRECT_URI) throw new XError("no_redirect_uri", "The callback address is needed: the https address of your copy of the callback page.");
  await save({ ...store, clientId: id, clientSecret: secret, redirectUri });
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

// `redirect`: the callback address sent with this sign-in; the code exchange must repeat it exactly.
// `grants`: what the account is being connected for; X is asked for those scopes only.
interface Pending { state: string; verifier: string; url: string; expiresAt: number; timer: NodeJS.Timeout; redirect: string; grants: XGrant[] }
let pending: Pending | null = null;
let finishing: Pending | null = null;
let lastError: string | undefined;

export function cancelConnect(): void {
  if (pending) { clearTimeout(pending.timer); pending = null; }
}

/** A list of grants from outside: known names only, `read` always among them. */
function cleanGrants(raw: unknown): XGrant[] {
  const list = Array.isArray(raw) ? raw.filter(isGrant) : [];
  return [...new Set<XGrant>(["read", ...list])];
}

/**
 * Starts the sign-in of one more account, for the grants given: returns the URL the user
 * opens in a browser, signed in to X as the account to connect. X sends the browser to the
 * registered callback with a code and the state; `finishConnect` takes them from there.
 */
export async function startConnect(grants: unknown = ["read", "publish"]): Promise<{ url: string; expiresAt: string; grants: XGrant[] }> {
  const store = await load();
  if (!store.clientId || !store.clientSecret) throw new XError("app_not_configured", "Set the X app's client id and secret first.");
  const redirect = redirectUriOf(store);
  if (!redirect) throw new XError("no_redirect_uri", "Save the callback address first: the https address of your copy of the callback page.");
  cancelConnect();
  lastError = undefined;
  const wanted = cleanGrants(grants);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${authBase()}/i/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: store.clientId,
    redirect_uri: redirect,
    scope: scopesFor(wanted).join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const expiresAt = Date.now() + SIGNIN_TIMEOUT_MS;
  const timer = setTimeout(() => { lastError = "The sign-in expired: nobody finished it in the browser within 10 minutes."; cancelConnect(); }, SIGNIN_TIMEOUT_MS);
  timer.unref?.();
  pending = { state, verifier, url: url.toString(), expiresAt, timer, redirect, grants: wanted };
  console.log(`[key-proxy] x: account sign-in started (${wanted.join(", ")})`);
  return { url: pending.url, expiresAt: new Date(expiresAt).toISOString(), grants: wanted };
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
    const data = await tokenRequest(store, { grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier });
    const scopes = typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [];
    for (const needed of BASE_SCOPES) {
      if (!scopes.includes(needed)) throw new XError("scope_missing", `X did not grant "${needed}"; connect again and accept every permission.`);
    }
    // X grants all or nothing, but never more than the app's permission level allows: a
    // grant whose scopes did not come back is not kept (the card says which).
    const covered = grantsCoveredBy(scopes);
    const grants = p.grants.filter((g) => covered.includes(g));
    const who = await whoAmI(data.access_token);
    const account: XAccount = {
      ...who,
      scopes,
      grants,
      status: "connected",
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      connectedAt: new Date().toISOString(),
    };
    const others = (await load()).accounts.filter((a) => a.id !== who.id);
    await save({ ...(await load()), accounts: [...others, account].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)) });
    const notGranted = p.grants.filter((g) => !grants.includes(g));
    lastError = notGranted.length ? `@${who.username} is connected, but X did not grant: ${notGranted.join(", ")} (the app's permission level in X's developer portal does not allow it).` : undefined;
    console.log(`[key-proxy] x: connected @${who.username} (${grants.join(", ")})`);
    return publicAccount(account);
  } catch (e: any) {
    lastError = safeMessage(e, "The account could not be connected; try again.");
    console.error(`[key-proxy] x: sign-in failed: ${lastError}`);
    throw e instanceof XError ? e : new XError("connect_failed", lastError, 502);
  } finally {
    if (finishing === p) finishing = null;
  }
}

/**
 * Changes what a connected account may be used for. Taking a grant away is this side's
 * business; adding one the account's scopes do not cover needs a new sign-in, and the
 * error names the scopes so the card can offer exactly that.
 */
export async function setGrants(id: string, grants: unknown): Promise<XAccountStatus> {
  const store = await load();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new XError("no_such_account", "That account is not connected.", 404);
  const wanted = cleanGrants(grants);
  const missing = missingScopes(wanted, account.scopes);
  if (missing.length) {
    const e = new XError("scopes_missing", `@${account.username} was not connected with that permission; connect it again to add it.`, 409);
    (e as any).missing = missing;
    throw e;
  }
  const next: XAccount = { ...account, grants: wanted };
  await save({ ...store, accounts: store.accounts.map((a) => (a.id === id ? next : a)) });
  console.log(`[key-proxy] x: @${account.username} may now: ${wanted.join(", ")}`);
  return publicAccount(next);
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

// ─── Publishing ─────────────────────────────────────────────────────────────

export interface XPostPart { text: string; media?: string[] }
export interface XPostResult { username: string; posts: { id: string; url: string }[]; url: string }
/**
 * What goes with the first part: a Premium account may post longer videos (the API knows,
 * the key-proxy does not); the post may be a reply to a post, quote one, carry a poll, and
 * say who may reply. The API has checked the shapes; the ids are checked again here.
 */
export interface XPostOptions {
  premium?: boolean;
  replyTo?: string;
  quote?: string;
  poll?: { options: string[]; durationMinutes: number };
  replySettings?: "following" | "mentionedUsers" | "subscribers" | "verified";
}
const REPLY_SETTINGS = new Set(["following", "mentionedUsers", "subscribers", "verified"]);

// What X takes per media kind (its media upload guide): images 5 MB, GIFs 15 MB, videos 20 min
// and 8 GB, or 125 min and 16 GB on a Premium account. Duration is X's call: a video over the
// account's allowance is refused when the post is created.
const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" };
export const MEDIA_MAX_BYTES = { image: 5 * 1024 * 1024, gif: 15 * 1024 * 1024, video: 8 * 1024 ** 3, videoPremium: 16 * 1024 ** 3 };
export const mediaKind = (file: string): "image" | "gif" | "video" | null => {
  const ext = path.extname(file).toLowerCase();
  return ext === ".mp4" ? "video" : ext === ".gif" ? "gif" : MEDIA_TYPES[ext] ? "image" : null;
};
// Chunks of a video upload: X asks for 5 MB or less per segment.
const CHUNK_BYTES = 5 * 1024 * 1024;
// X processes a video after the upload; a short clip takes seconds, a long one minutes.
const PROCESSING_WAIT_MS = Number(process.env.X_VIDEO_PROCESSING_MS) || 15 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The attachment's real path, inside the uploads folder, or an error. */
async function attachmentPath(filePath: string): Promise<string> {
  const real = await realpath(filePath).catch(() => "");
  const root = await realpath(uploadsDir).catch(() => path.resolve(uploadsDir));
  if (!real || path.dirname(real) !== root || !(await stat(real)).isFile()) throw new XError("bad_media", `"${path.basename(filePath)}" is not one of the files attached in HydraOps.`);
  return real;
}

/** One image or GIF, uploaded in one request; X answers with the media id to attach. */
async function uploadImage(token: string, filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const type = MEDIA_TYPES[ext];
  const bytes = await readFile(filePath);
  const max = ext === ".gif" ? MEDIA_MAX_BYTES.gif : MEDIA_MAX_BYTES.image;
  if (bytes.length > max) throw new XError("media_too_large", `"${path.basename(filePath)}" is larger than ${max / 1024 / 1024} MB.`);
  const form = new FormData();
  form.append("media", new Blob([bytes], { type }), path.basename(filePath));
  form.append("media_category", ext === ".gif" ? "tweet_gif" : "tweet_image");
  form.append("media_type", type);
  const { ok, status, body } = await fetchJson(`${apiBase()}/2/media/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }, 120_000);
  const id = body?.data?.id ?? body?.media_id_string ?? body?.id;
  if (!ok || typeof id !== "string") throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X did not take the image "${path.basename(filePath)}" (${status}).`), status);
  return id;
}

/**
 * A video, uploaded the way X asks for anything large: initialize, append the file in chunks,
 * finalize, then wait until X has processed it (the media id is not usable before). The
 * file is read chunk by chunk, never whole.
 */
async function uploadVideo(token: string, filePath: string, premium: boolean): Promise<string> {
  const name = path.basename(filePath);
  const size = (await stat(filePath)).size;
  const max = premium ? MEDIA_MAX_BYTES.videoPremium : MEDIA_MAX_BYTES.video;
  if (size > max) throw new XError("media_too_large", `"${name}" is ${(size / 1024 ** 3).toFixed(2)} GB; X takes videos up to ${max / 1024 ** 3} GB${premium ? "" : " (16 GB on a Premium account)"}.`);
  const auth = { authorization: `Bearer ${token}` };
  const init = await fetchJson(`${apiBase()}/2/media/upload/initialize`, {
    method: "POST", headers: { ...auth, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ media_type: "video/mp4", total_bytes: size, media_category: "tweet_video" }),
  }, 60_000);
  const id = init.body?.data?.id ?? init.body?.id;
  if (!init.ok || typeof id !== "string") throw new XError(errorCode(init.body) || `http_${init.status}`, errorMessage(init.body, `X did not start the upload of "${name}" (${init.status}).`), init.status);
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (let index = 0, offset = 0; offset < size; index++, offset += CHUNK_BYTES) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK_BYTES, size - offset), offset);
      const form = new FormData();
      form.append("segment_index", String(index));
      form.append("media", new Blob([buf.subarray(0, bytesRead)], { type: "application/octet-stream" }), name);
      const { ok, status, body } = await fetchJson(`${apiBase()}/2/media/upload/${encodeURIComponent(id)}/append`, { method: "POST", headers: auth, body: form }, 300_000);
      if (!ok) throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X did not take part ${index + 1} of "${name}" (${status}).`), status);
    }
  } finally {
    await handle.close();
  }
  const fin = await fetchJson(`${apiBase()}/2/media/upload/${encodeURIComponent(id)}/finalize`, { method: "POST", headers: { ...auth, accept: "application/json" } }, 60_000);
  if (!fin.ok) throw new XError(errorCode(fin.body) || `http_${fin.status}`, errorMessage(fin.body, `X did not finish the upload of "${name}" (${fin.status}).`), fin.status);
  // Processing: X says when to ask again; "succeeded" makes the id usable, "failed" ends it.
  let info = fin.body?.data?.processing_info ?? fin.body?.processing_info;
  const deadline = Date.now() + PROCESSING_WAIT_MS;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") throw new XError("video_processing_failed", `X could not process "${name}"${info.error?.message ? `: ${info.error.message}` : ""}. It takes MP4 with H.264 video and AAC audio.`);
    if (Date.now() > deadline) throw new XError("video_processing_timeout", `X is still processing "${name}" after ${Math.round(PROCESSING_WAIT_MS / 60_000)} minutes; the post was not created.`);
    await sleep(Math.min(Math.max(Number(info.check_after_secs) || 1, 1), 30) * 1000);
    const st = await fetchJson(`${apiBase()}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`, { method: "GET", headers: { ...auth, accept: "application/json" } }, 60_000);
    if (!st.ok) throw new XError(errorCode(st.body) || `http_${st.status}`, errorMessage(st.body, `X did not report the processing of "${name}" (${st.status}).`), st.status);
    info = st.body?.data?.processing_info ?? st.body?.processing_info ?? { state: "succeeded" };
  }
  return id;
}

/** One attachment uploaded for the account, by its kind. */
async function uploadMedia(token: string, filePath: string, premium: boolean): Promise<string> {
  const real = await attachmentPath(filePath);
  const kind = mediaKind(real);
  if (!kind) throw new XError("media_type", `"${path.basename(filePath)}" is not a file X takes (png, jpg, gif, webp or mp4).`);
  return kind === "video" ? uploadVideo(token, real, premium) : uploadImage(token, real);
}

/** X's rule for one post: up to 4 images, or one GIF, or one video; not mixed. */
export function mediaRuleError(media: string[]): string | null {
  if (media.length > 4) return "A part takes up to 4 images.";
  const kinds = media.map(mediaKind);
  if (kinds.includes(null)) return "A part's attachments have to be png, jpg, gif, webp or mp4 files.";
  const single = kinds.filter((k) => k === "video" || k === "gif");
  if (single.length && media.length > 1) return "A video or a GIF goes alone in its part, with no other attachment.";
  return null;
}

/**
 * Publishes one post or a thread (each part a reply to the one before) as one account.
 * The caller (the API) has already checked that the agent may use the account and that
 * the media paths are the user's own attachments; here the tokens are spent, nothing else.
 */
export async function postThread(accountId: string, parts: XPostPart[], opts: XPostOptions = {}): Promise<XPostResult> {
  if (!Array.isArray(parts) || !parts.length || parts.length > 25) throw new XError("bad_parts", "A post has 1 to 25 parts.");
  for (const p of parts) {
    if (typeof p?.text !== "string" || !p.text.trim()) throw new XError("empty_part", "Every part needs text.");
    const rule = mediaRuleError(Array.isArray(p.media) ? p.media : []);
    if (rule) throw new XError("bad_media", rule);
  }
  const token = await accessToken(accountId);
  const account = (await load()).accounts.find((a) => a.id === accountId)!;
  if (!account.grants.includes("publish")) throw new XError("grant_missing", `@${account.username} was not connected for publishing.`, 403);
  for (const id of [opts.replyTo, opts.quote]) if (id !== undefined && !ID_RE.test(String(id))) throw new XError("bad_id", `"${String(id).slice(0, 40)}" is not an X post id.`);
  if (opts.poll) {
    const o = Array.isArray(opts.poll.options) ? opts.poll.options.map((x) => String(x ?? "").trim()) : [];
    if (o.length < 2 || o.length > 4 || o.some((x) => !x || x.length > 25)) throw new XError("bad_poll", "A poll has 2 to 4 options of up to 25 characters each.");
    const d = Number(opts.poll.durationMinutes);
    if (!Number.isInteger(d) || d < 5 || d > 10080) throw new XError("bad_poll", "A poll lasts 5 minutes to 7 days (10080 minutes).");
    if (parts[0].media?.length) throw new XError("bad_poll", "A poll and attachments cannot go in the same part.");
  }
  if (opts.replySettings !== undefined && !REPLY_SETTINGS.has(opts.replySettings)) throw new XError("bad_reply_settings", "reply_settings is one of following, mentionedUsers, subscribers, verified.");
  const posts: { id: string; url: string }[] = [];
  let previous: string | undefined = opts.replyTo ? String(opts.replyTo) : undefined;
  for (const [index, part] of parts.entries()) {
    const mediaIds: string[] = [];
    for (const file of part.media ?? []) mediaIds.push(await uploadMedia(token, file, opts.premium === true));
    const payload: any = { text: part.text };
    if (mediaIds.length) payload.media = { media_ids: mediaIds };
    if (previous) payload.reply = { in_reply_to_tweet_id: previous };
    if (index === 0) {
      if (opts.quote) payload.quote_tweet_id = String(opts.quote);
      if (opts.poll) payload.poll = { options: opts.poll.options.map((x) => String(x).trim()), duration_minutes: Number(opts.poll.durationMinutes) };
      if (opts.replySettings) payload.reply_settings = opts.replySettings;
    }
    const { ok, status, body } = await fetchJson(`${apiBase()}/2/tweets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    }, 60_000);
    const id = body?.data?.id;
    if (!ok) {
      const done = posts.length ? ` ${posts.length} part(s) were already published: ${posts.map((x) => x.url).filter(Boolean).join(" ")}.` : "";
      throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X refused the post (${status}).`) + done, status);
    }
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      // X created the post (it answered 2xx) but named no id: a thread once came back with
      // its last link empty. Nothing is retried (that would publish it twice); the part is
      // reported as published without a link, and the body is logged to see what X sent.
      console.warn(`[key-proxy] x: part ${posts.length + 1} created as @${account.username} but X returned no id (HTTP ${status}): ${JSON.stringify(body).slice(0, 500)}`);
      posts.push({ id: "", url: "" });
      // Without the id the next part cannot reply to this one; it replies to the last known.
      continue;
    }
    posts.push({ id, url: `https://x.com/${account.username}/status/${id}` });
    previous = id;
  }
  console.log(`[key-proxy] x: published ${posts.length} part(s) as @${account.username}: ${posts.map((p) => p.id || "?").join(" ")}`);
  return { username: account.username, posts, url: posts.find((p) => p.url)?.url ?? "" };
}

// ─── Reading (the closed table in x-ops.ts) ─────────────────────────────────

export interface XCallResult {
  op: string;
  /** X's answer as it came: data, includes, meta, errors. */
  body: any;
  /** Resources X returned (what it charges per), and the estimated charge. */
  resources: number;
  estimatedUsd: number;
}
const ID_RE = /^\d{1,30}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
// A DM conversation id: two user ids joined by a dash (a 1:1) or digits (a group).
const CONVERSATION_RE = /^\d{1,30}(-\d{1,30})?$/;
const DM_TEXT_MAX = 10_000;
const PARAM_MAX = 1024;

/**
 * One operation of the table, as one account. The path's placeholders and the query are
 * filled from `params` under the table's rules (ids numeric, handles as X spells them, only
 * the listed query parameters, max_results within X's range); the fields that come back
 * are the table's, never the caller's. What X charges for the answer is estimated from it.
 */
export async function callOp(accountId: string, opName: unknown, params: unknown): Promise<XCallResult> {
  const op = opNamed(opName);
  if (!op) throw new XError("unknown_op", `"${String(opName).slice(0, 40)}" is not an X operation HydraOps performs.`);
  const p: Record<string, unknown> = params && typeof params === "object" ? (params as any) : {};
  const store = await load();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) throw new XError("no_such_account", "That X account is not connected.", 404);
  if (!account.grants.includes(op.grant)) throw new XError("grant_missing", `@${account.username} was not connected for "${op.grant}".`, 403);
  const lacking = (op.scopes ?? []).filter((s) => !account.scopes.includes(s));
  if (lacking.length) throw new XError("scopes_missing", `@${account.username} lacks the X permission for this (${lacking.join(", ")}); connect it again with "${op.grant}".`, 403);
  const url = new URL(apiBase() + fillPath(op, account, p));
  for (const key of op.query) {
    const v = p[key];
    if (v === undefined || v === null || v === "") continue;
    const s = String(v).slice(0, PARAM_MAX);
    if (key === "max_results" && op.results) {
      const n = Math.round(Number(s));
      if (!Number.isFinite(n)) continue;
      url.searchParams.set(key, String(Math.min(op.results[1], Math.max(op.results[0], n))));
    } else url.searchParams.set(key, s);
  }
  for (const [k, v] of Object.entries(op.fixed)) url.searchParams.set(k, v);
  // A write's body: the table says which caller parameter becomes which field of X's JSON.
  let payload: string | undefined;
  if (op.body) {
    const json: Record<string, unknown> = {};
    for (const [param, field] of Object.entries(op.body)) {
      const v = p[param];
      if (param === "hidden") json[field] = v === true || v === "true";
      else if (param === "text") {
        const text = String(v ?? "").trim();
        if (!text || text.length > DM_TEXT_MAX) throw new XError("bad_text", `A message has 1 to ${DM_TEXT_MAX} characters.`);
        json[field] = text;
      } else {
        const id = String(v ?? "").trim();
        if (!ID_RE.test(id)) throw new XError("bad_id", `"${id.slice(0, 40)}" is not an X id (digits only).`);
        json[field] = id;
      }
    }
    payload = JSON.stringify(json);
  }
  const token = await accessToken(accountId);
  const { ok, status, body } = await fetchJson(url.toString(), {
    method: op.method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload,
  }, 60_000);
  if (status === 401) {
    // The token was refused outright (revoked in X's settings, app permissions changed): a new sign-in is the only way back.
    const fresh = await load();
    await save({ ...fresh, accounts: fresh.accounts.map((a) => (a.id === accountId ? { ...a, status: "reauth", accessToken: undefined, expiresAt: undefined, refreshToken: undefined } : a)) });
    throw new XError("x_reauth_required", `X no longer accepts the connection of @${account.username}: connect it again in Tools → X.`, 401);
  }
  if (status === 429) throw new XError("rate_limited", `X is rate limiting this (${op.name}) for the moment; try again in a few minutes.`, 429);
  if (!ok) throw new XError(errorCode(body) || `http_${status}`, errorMessage(body, `X refused the request (${status}).`), status);
  const est = estimateUsd(op, body);
  if (op.kind === "write") console.log(`[key-proxy] x: ${op.name} as @${account.username}${p.id ? ` (${String(p.id).slice(0, 30)})` : p.conversation ? ` (${String(p.conversation).slice(0, 40)})` : ""}`);
  return { op: op.name, body, resources: est.resources, estimatedUsd: est.usd };
}

/** The path with its placeholders filled: `:me` is the account, `:id` and `:username` come from the caller, checked. */
function fillPath(op: XOp, account: XAccount, p: Record<string, unknown>): string {
  return op.path.replace(/:(me|id|username|conversation)/g, (_m, key: string) => {
    if (key === "me") return account.id;
    const v = String(p[key] ?? "").trim().replace(/^@/, "");
    if (key === "id" && !ID_RE.test(v)) throw new XError("bad_id", `"${v.slice(0, 40)}" is not an X id (digits only).`);
    if (key === "username" && !USERNAME_RE.test(v)) throw new XError("bad_username", `"${v.slice(0, 40)}" is not an X handle.`);
    if (key === "conversation" && !CONVERSATION_RE.test(v)) throw new XError("bad_conversation", `"${v.slice(0, 40)}" is not an X conversation id.`);
    return encodeURIComponent(v);
  });
}

// ─── Status and control ─────────────────────────────────────────────────────

const publicAccount = (a: XAccount): XAccountStatus => ({ id: a.id, username: a.username, name: a.name, avatar: a.avatar, status: a.status, grants: [...a.grants], scopes: [...a.scopes], connectedAt: a.connectedAt, refreshedAt: a.refreshedAt });

export async function status(): Promise<XStatus> {
  const s = await load();
  return {
    appConfigured: !!(s.clientId && s.clientSecret),
    clientId: s.clientId,
    redirectUri: redirectUriOf(s),
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
/**
 * The control endpoints change credentials, so a request must be the API's own, not a browser's:
 * a page from another site can reach 127.0.0.1 with a bare fetch, but it cannot send JSON
 * without a preflight (which nothing here answers) and it always carries an Origin header.
 */
function fromApi(req: import("node:http").IncomingMessage): boolean {
  if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return false;
  if (req.method !== "GET" && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return false;
  return true;
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
    if (!fromApi(req)) { sendJson(res, 403, { error: { code: "not_from_api", message: "The X control endpoints take JSON requests from the API only." } }); return true; }
    if (path === "/status" && req.method === "GET") { sendJson(res, 200, await status()); return true; }
    if (path === "/ops" && req.method === "GET") { sendJson(res, 200, { ops: opsPublic() }); return true; }
    if (path === "/app" && req.method === "POST") { const b = await readBody(req); await setApp(b.clientId, b.clientSecret, b.redirectUri); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/connect" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, await startConnect(b.grants)); return true; }
    if (path === "/grants" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, { ok: true, account: await setGrants(String(b.id ?? ""), b.grants) }); return true; }
    if (path === "/call" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, await callOp(String(b.accountId ?? ""), b.op, b.params)); return true; }
    if (path === "/finish" && req.method === "POST") { const b = await readBody(req); sendJson(res, 200, { ok: true, account: await finishConnect(String(b.code ?? ""), String(b.state ?? "")) }); return true; }
    if (path === "/cancel" && req.method === "POST") { cancelConnect(); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/disconnect" && req.method === "POST") { const b = await readBody(req); await disconnect(String(b.id ?? "")); sendJson(res, 200, { ok: true }); return true; }
    if (path === "/post" && req.method === "POST") {
      const b = await readBody(req);
      const opts: XPostOptions = { premium: b.premium === true };
      if (b.replyTo !== undefined) opts.replyTo = String(b.replyTo);
      if (b.quote !== undefined) opts.quote = String(b.quote);
      if (b.poll && typeof b.poll === "object") opts.poll = { options: Array.isArray(b.poll.options) ? b.poll.options : [], durationMinutes: Number(b.poll.durationMinutes) };
      if (b.replySettings !== undefined) opts.replySettings = b.replySettings;
      sendJson(res, 200, await postThread(String(b.accountId ?? ""), Array.isArray(b.parts) ? b.parts : [], opts));
      return true;
    }
    return false;
  } catch (e: any) {
    sendJson(res, e instanceof XError ? e.status : 500, { error: { code: e instanceof XError ? e.code : "x_failed", message: safeMessage(e, "The request to X failed."), ...(Array.isArray(e?.missing) ? { missing: e.missing } : {}) } });
    return true;
  }
}

/** Whether at least one account can be used right now (for /health). */
export async function hasAccounts(): Promise<boolean> { return (await load()).accounts.some((a) => a.status === "connected"); }
