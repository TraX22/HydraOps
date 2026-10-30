/**
 * The encrypted key store: keys.json, chatgpt.json and x.json under keyStoreDir.
 *
 * Each file is an envelope, `{"hydraops-keystore": 2, protection, nonce, tag, data}`, whose
 * `data` is the JSON object encrypted with AES-256-GCM under a 32-byte master key. The
 * file's own name is the authenticated associated data, so the content of one store can
 * never be passed off as another's, and GCM rejects any altered byte.
 *
 * Where the master key lives (`protection`), decided once per process:
 *   - "passphrase": HYDRA_KEYSTORE_PASSPHRASE is set. The key is derived with scrypt and a
 *     per-file salt kept in the envelope (`kdf`); nothing is written to disk. Meant for
 *     servers without a desktop.
 *   - "keyring": the operating system's keyring through @napi-rs/keyring (Windows
 *     Credential Manager, macOS Keychain, Secret Service on a Linux desktop). The key is
 *     generated on this machine the first time and never leaves the keyring.
 *   - "file": no passphrase and no usable keyring (a headless Linux service): the key is
 *     generated into `master.key` next to the stores, readable by the current user only.
 *     Weak, because the key sits beside the data; it is reported as such.
 * HYDRA_KEYSTORE_BACKEND=keyring|passphrase|file forces one (tests, odd setups).
 *
 * A plain-text store from before this existed is encrypted in place the first time it is
 * read: the envelope is decrypted back and compared before it replaces the plain file.
 *
 * Several processes (API, key-proxy, Telegram bot) read and write these files; the first
 * one to need the key creates it under a lock so two of them cannot create two keys.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { keyStoreDir } from "./paths.js";
import { writePrivateFile } from "./private-file.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const KEYSTORE_FORMAT = "hydraops-keystore";
export const KEYSTORE_VERSION = 2;
export const MASTER_KEY_FILE = "master.key";
const LOCK_FILE = "master.lock";
/** The keyring entry: service "HydraOps", account "keystore". Tests point it elsewhere so they never touch the real one. */
const KEYRING_SERVICE = process.env.HYDRA_KEYSTORE_KEYRING_SERVICE?.trim() || "HydraOps";
const KEYRING_ACCOUNT = "keystore";
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type KeyProtection = "keyring" | "passphrase" | "file";

interface Envelope {
  [KEYSTORE_FORMAT]: number;
  protection: KeyProtection;
  nonce: string;
  tag: string;
  data: string;
  kdf?: { type: "scrypt"; salt: string; N: number; r: number; p: number };
}

interface MasterKey {
  key: Buffer;
  protection: KeyProtection;
  /** What the user is told about where the key lives. */
  detail: string;
}

/** Thrown when a store cannot be decrypted: wrong master key or a damaged file. Never swallowed into "no keys". */
export class KeystoreError extends Error {
  constructor(message: string, readonly file: string) {
    super(message);
    this.name = "KeystoreError";
  }
}

export function isKeystoreEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)[KEYSTORE_FORMAT] === KEYSTORE_VERSION
    && typeof (value as Envelope).nonce === "string" && typeof (value as Envelope).data === "string" && typeof (value as Envelope).tag === "string";
}

// ── The master key ───────────────────────────────────────────────────────────────

const log = (msg: string) => console.warn(`[keystore] ${msg}`);
let masterKeyPromise: Promise<MasterKey> | null = null;
/** Passphrase-derived keys, one per salt (each store carries its own). */
const derived = new Map<string, Buffer>();

function forcedBackend(): KeyProtection | undefined {
  const v = (process.env.HYDRA_KEYSTORE_BACKEND || "").trim().toLowerCase();
  return v === "keyring" || v === "passphrase" || v === "file" ? v : undefined;
}
const passphrase = () => (process.env.HYDRA_KEYSTORE_PASSPHRASE || "").trim();

function keyringEntry(): { getPassword(): string | null; setPassword(p: string): void } {
  const require = createRequire(import.meta.url);
  const { Entry } = require("@napi-rs/keyring") as { Entry: new (service: string, account: string) => { getPassword(): string | null; setPassword(p: string): void } };
  return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
}

const keyringDetail = () => process.platform === "win32" ? "Windows Credential Manager" : process.platform === "darwin" ? "macOS Keychain" : "the desktop keyring (Secret Service)";

/** Holds `master.lock` while the key is created, so two processes starting together agree on one key. */
async function withCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(keyStoreDir, { recursive: true, mode: 0o700 });
  const lock = path.join(keyStoreDir, LOCK_FILE);
  for (let i = 0; i < 100; i++) {
    try {
      const fh = await open(lock, "wx");
      try {
        await fh.writeFile(String(process.pid));
        await fh.close();
        return await fn();
      } finally {
        await unlink(lock).catch(() => {});
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Someone else holds it; a lock older than 30 s belongs to a process that died.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > 30_000) { await unlink(lock).catch(() => {}); continue; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("the key store is locked by another process (master.lock)");
}

const decodeKey = (b64: string | null | undefined): Buffer | null => {
  if (!b64) return null;
  const buf = Buffer.from(b64.trim(), "base64");
  return buf.length === 32 ? buf : null;
};

async function fromKeyring(): Promise<MasterKey> {
  const entry = keyringEntry();
  let key = decodeKey(entry.getPassword());
  if (!key) {
    key = await withCreationLock(async () => {
      const again = decodeKey(entry.getPassword());
      if (again) return again;
      const fresh = randomBytes(32);
      entry.setPassword(fresh.toString("base64"));
      const stored = decodeKey(entry.getPassword());
      if (!stored || !timingSafeEqual(stored, fresh)) throw new Error("the keyring did not keep the key");
      return stored;
    });
  }
  return { key, protection: "keyring", detail: keyringDetail() };
}

async function fromFile(): Promise<MasterKey> {
  const file = path.join(keyStoreDir, MASTER_KEY_FILE);
  const read = () => readFile(file, "utf-8").then(decodeKey).catch(() => null);
  let key = await read();
  if (!key) {
    key = await withCreationLock(async () => {
      const again = await read();
      if (again) return again;
      const fresh = randomBytes(32);
      await writePrivateFile(file, fresh.toString("base64") + "\n");
      return fresh;
    });
  }
  return { key, protection: "file", detail: `${MASTER_KEY_FILE} next to the store (no keyring on this machine)` };
}

async function resolveMasterKey(): Promise<MasterKey> {
  const forced = forcedBackend();
  if (forced === "passphrase" || (!forced && passphrase())) {
    if (!passphrase()) throw new Error("HYDRA_KEYSTORE_BACKEND=passphrase but HYDRA_KEYSTORE_PASSPHRASE is empty");
    // The actual key is derived per store (its salt); this entry only names the protection.
    return { key: Buffer.alloc(0), protection: "passphrase", detail: "a passphrase from HYDRA_KEYSTORE_PASSPHRASE (derived with scrypt, never stored)" };
  }
  if (forced === "file") return fromFile();
  try {
    return await fromKeyring();
  } catch (e: unknown) {
    if (forced === "keyring") throw e;
    log(`no usable keyring (${(e as Error)?.message ?? e}); the master key goes to ${MASTER_KEY_FILE}`);
    return fromFile();
  }
}

function masterKey(): Promise<MasterKey> {
  masterKeyPromise ??= resolveMasterKey().catch((e) => { masterKeyPromise = null; throw e; });
  return masterKeyPromise;
}

async function keyFor(mk: MasterKey, envelope?: Envelope): Promise<{ key: Buffer; kdf?: Envelope["kdf"] }> {
  if (mk.protection !== "passphrase") return { key: mk.key };
  const kdf = envelope?.kdf ?? { type: "scrypt" as const, salt: randomBytes(16).toString("base64"), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  const cached = derived.get(kdf.salt);
  if (cached) return { key: cached, kdf };
  const key = await scrypt(passphrase(), Buffer.from(kdf.salt, "base64"), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem });
  if (derived.size >= 32) derived.clear(); // every write makes a new salt; keep the cache small
  derived.set(kdf.salt, key);
  return { key, kdf };
}

// ── Envelopes ────────────────────────────────────────────────────────────────────

const aadFor = (file: string) => Buffer.from(`${KEYSTORE_FORMAT}:${KEYSTORE_VERSION}:${path.basename(file)}`, "utf-8");

function seal(plain: string, key: Buffer, file: string, protection: KeyProtection, kdf?: Envelope["kdf"]): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(file));
  const data = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const env: Envelope = { [KEYSTORE_FORMAT]: KEYSTORE_VERSION, protection, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  if (kdf) env.kdf = kdf;
  return env;
}

function unseal(env: Envelope, key: Buffer, file: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"));
  decipher.setAAD(aadFor(file));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]).toString("utf-8");
}

/**
 * The object stored in `file`, or null when the file does not exist. A plain-text file is
 * encrypted in place. Throws KeystoreError when the file exists but cannot be read back,
 * so a caller never mistakes "undecryptable" for "empty" and overwrites it.
 */
export async function readStore<T = Record<string, unknown>>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeystoreError(`${path.basename(file)} is not valid JSON`, file);
  }
  if (!isKeystoreEnvelope(parsed)) {
    // Plain text from before encryption: seal it now (writeStore verifies before replacing).
    await writeStore(file, parsed);
    const mk = await masterKey();
    log(`${path.basename(file)} was plain text: encrypted in place (key: ${mk.detail})`);
    return parsed as T;
  }
  const mk = await masterKey();
  if (parsed.protection === "passphrase" && mk.protection !== "passphrase") {
    throw new KeystoreError(`${path.basename(file)} was encrypted with a passphrase; set HYDRA_KEYSTORE_PASSPHRASE to read it`, file);
  }
  try {
    return JSON.parse(unseal(parsed, (await keyFor(mk, parsed)).key, file)) as T;
  } catch {
    // The key may have changed under us (another process created it first): look again, once.
    masterKeyPromise = null;
    derived.clear();
    try {
      const fresh = await masterKey();
      return JSON.parse(unseal(parsed, (await keyFor(fresh, parsed)).key, file)) as T;
    } catch {
      throw new KeystoreError(`${path.basename(file)} cannot be decrypted: the master key does not match (${mk.detail}). If the keys were moved from another computer, enter them again.`, file);
    }
  }
}

/** Encrypts `value` into `file` (temp file + rename), after checking that it decrypts back. */
export async function writeStore(file: string, value: unknown): Promise<void> {
  const mk = await masterKey();
  const { key, kdf } = await keyFor(mk);
  const plain = JSON.stringify(value, null, 2);
  const env = seal(plain, key, file, mk.protection, kdf);
  if (unseal(env, key, file) !== plain) throw new KeystoreError(`${path.basename(file)}: the sealed store did not read back; nothing was written`, file);
  await writePrivateFile(file, JSON.stringify(env, null, 2) + "\n");
}

/** How the store is protected, for Settings and the log. Resolves (and if needed creates) the master key. */
export async function keystoreStatus(): Promise<{ encrypted: true; protection: KeyProtection; detail: string }> {
  const mk = await masterKey();
  return { encrypted: true, protection: mk.protection, detail: mk.detail };
}

/** Test hook: forget the resolved key and the derived ones, so the next call resolves again. */
export function resetKeystoreForTests(): void {
  masterKeyPromise = null;
  derived.clear();
}
