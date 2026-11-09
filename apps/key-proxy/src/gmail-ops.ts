/**
 * gmail-ops.ts — what HydraOps does with a Gmail account, as a closed table.
 *
 * A Gmail account is connected for permission groups ("grants"), each a set of Google
 * scopes: read (search, messages, threads, labels, attachments), compose (drafts), send
 * (send, reply, forward), organize (labels, archive, read state, the bin). Google is asked
 * for the scopes of the chosen grants only, and never grants more than the user accepted.
 * Organizing has no narrow scope of its own: Google's gmail.modify is the only one that lets
 * a label be put on a message, and Google words it broadly. What HydraOps does with it is
 * what this table says and nothing else.
 *
 * Every operation the tools may run on Gmail is a row here: its method, the path under
 * users/me, the grant it needs, and which query parameters the caller may set. The Gmail
 * API has no per-call price, so unlike X there is no money to keep; the quotas are
 * Google's and far above what a few agents do.
 */

export const GRANTS = ["read", "compose", "send", "organize"] as const;
export type GmailGrant = (typeof GRANTS)[number];
export const isGrant = (v: unknown): v is GmailGrant => typeof v === "string" && (GRANTS as readonly string[]).includes(v);

/** Who the account is: asked at every sign-in so the card can show the address, the name and the picture. */
export const BASE_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
export const GRANT_SCOPES: Record<GmailGrant, string[]> = {
  read: ["https://www.googleapis.com/auth/gmail.readonly"],
  compose: ["https://www.googleapis.com/auth/gmail.compose"],
  send: ["https://www.googleapis.com/auth/gmail.send"],
  organize: ["https://www.googleapis.com/auth/gmail.modify"],
};
/** The scopes to ask Google for: the base and those of the grants, in a stable order. */
export function scopesFor(grants: readonly GmailGrant[]): string[] {
  const out = [...BASE_SCOPES];
  for (const g of GRANTS) if (grants.includes(g)) for (const s of GRANT_SCOPES[g]) if (!out.includes(s)) out.push(s);
  return out;
}
/** Scopes that imply others: full mailbox access covers every grant; gmail.modify covers reading. */
const FULL_ACCESS_SCOPE = "https://mail.google.com/";
const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/** The grants a set of granted scopes covers entirely. Each scope is compared whole, never as a substring. */
export function grantsCoveredBy(scopes: readonly string[]): GmailGrant[] {
  const granted = new Set(scopes);
  const has = (s: string) => granted.has(s) || granted.has(FULL_ACCESS_SCOPE) || (s === GRANT_SCOPES.read[0] && granted.has(MODIFY_SCOPE));
  return GRANTS.filter((g) => GRANT_SCOPES[g].every(has));
}
/** The scopes the grants need that the account was not granted. */
export function missingScopes(grants: readonly GmailGrant[], scopes: readonly string[]): string[] {
  const covered = grantsCoveredBy(scopes);
  return grants.filter((g) => !covered.includes(g)).flatMap((g) => GRANT_SCOPES[g]);
}

export interface GmailOp {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  kind: "read" | "write";
  /** Under https://gmail.googleapis.com/gmail/v1/users/me; `:id` and `:attachment` come from the caller. */
  path: string;
  grant: GmailGrant;
  /** Query parameters the caller may set; anything else is dropped. */
  query: readonly string[];
  /** Fixed query parameters. */
  fixed?: Record<string, string>;
  /** Bounds for maxResults. */
  results?: [number, number];
  /**
   * What the body carries: a message (RFC 822, built by gmail.ts from the caller's fields, never
   * taken raw from outside); the labels to add to and remove from a message or a thread; or a
   * new label's name.
   */
  body?: "message" | "labels" | "label";
}

export const OPS: readonly GmailOp[] = [
  // Reading
  { name: "profile", method: "GET", kind: "read", path: "/profile", grant: "read", query: [] },
  { name: "labels", method: "GET", kind: "read", path: "/labels", grant: "read", query: [] },
  { name: "messages", method: "GET", kind: "read", path: "/messages", grant: "read", query: ["q", "maxResults", "pageToken", "labelIds", "includeSpamTrash"], results: [1, 100] },
  { name: "message", method: "GET", kind: "read", path: "/messages/:id", grant: "read", query: ["format", "metadataHeaders"] },
  { name: "threads", method: "GET", kind: "read", path: "/threads", grant: "read", query: ["q", "maxResults", "pageToken", "labelIds", "includeSpamTrash"], results: [1, 100] },
  { name: "thread", method: "GET", kind: "read", path: "/threads/:id", grant: "read", query: ["format", "metadataHeaders"] },
  { name: "attachment", method: "GET", kind: "read", path: "/messages/:id/attachments/:attachment", grant: "read", query: [] },
  { name: "history", method: "GET", kind: "read", path: "/history", grant: "read", query: ["startHistoryId", "maxResults", "pageToken", "labelId", "historyTypes"], results: [1, 500] },
  // Drafts: nothing leaves the account; the draft waits in Gmail for the user. Reading them is a read.
  { name: "drafts", method: "GET", kind: "read", path: "/drafts", grant: "read", query: ["q", "maxResults", "pageToken"], results: [1, 100] },
  { name: "draft", method: "GET", kind: "read", path: "/drafts/:id", grant: "read", query: ["format"] },
  { name: "draft_create", method: "POST", kind: "write", path: "/drafts", grant: "compose", query: [], body: "message" },
  { name: "draft_update", method: "PUT", kind: "write", path: "/drafts/:id", grant: "compose", query: [], body: "message" },
  { name: "draft_delete", method: "DELETE", kind: "write", path: "/drafts/:id", grant: "compose", query: [] },
  // Sending: always under the user's approval (the API accepts the run of an approved call only), and
  // always as a full message, so what the user approved is what goes out: a draft is not sent by its id.
  { name: "send", method: "POST", kind: "write", path: "/messages/send", grant: "send", query: [], body: "message" },
  // Organizing: labels on and off a message or a whole thread (archiving is taking INBOX off,
  // reading is taking UNREAD off), the bin and back (Gmail empties it after 30 days; nothing
  // here deletes for good), and a new label.
  { name: "message_modify", method: "POST", kind: "write", path: "/messages/:id/modify", grant: "organize", query: [], body: "labels" },
  { name: "thread_modify", method: "POST", kind: "write", path: "/threads/:id/modify", grant: "organize", query: [], body: "labels" },
  { name: "message_trash", method: "POST", kind: "write", path: "/messages/:id/trash", grant: "organize", query: [] },
  { name: "message_untrash", method: "POST", kind: "write", path: "/messages/:id/untrash", grant: "organize", query: [] },
  { name: "thread_trash", method: "POST", kind: "write", path: "/threads/:id/trash", grant: "organize", query: [] },
  { name: "thread_untrash", method: "POST", kind: "write", path: "/threads/:id/untrash", grant: "organize", query: [] },
  { name: "label_create", method: "POST", kind: "write", path: "/labels", grant: "organize", query: [], body: "label" },
];

export const opNamed = (name: unknown): GmailOp | undefined => (typeof name === "string" ? OPS.find((o) => o.name === name) : undefined);
export const opNames = (): string[] => OPS.map((o) => o.name);
/** The table as the API sees it (no secrets in it, but the tools need not know the paths). */
export const opsPublic = () => OPS.map(({ name, kind, grant }) => ({ name, kind, grant }));
