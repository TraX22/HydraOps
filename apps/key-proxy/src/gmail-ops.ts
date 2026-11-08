/**
 * gmail-ops.ts — what HydraOps does with a Gmail account, as a closed table.
 *
 * A Gmail account is connected for permission groups ("grants"), each a set of Google
 * scopes: read (search, messages, threads, labels, attachments), compose (drafts), send
 * (send, reply, forward). Later: organize (labels, archive, read state). Google is asked for
 * the scopes of the chosen grants only, and never grants more than the user accepted.
 *
 * Every operation the tools may run on Gmail is a row here: its method, the path under
 * users/me, the grant it needs, and which query parameters the caller may set. The Gmail
 * API has no per-call price, so unlike X there is no money to keep; the quotas are
 * Google's and far above what a few agents do.
 */

export const GRANTS = ["read", "compose", "send"] as const;
export type GmailGrant = (typeof GRANTS)[number];
export const isGrant = (v: unknown): v is GmailGrant => typeof v === "string" && (GRANTS as readonly string[]).includes(v);

/** Who the account is: asked at every sign-in so the card can show the address, the name and the picture. */
export const BASE_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
export const GRANT_SCOPES: Record<GmailGrant, string[]> = {
  read: ["https://www.googleapis.com/auth/gmail.readonly"],
  compose: ["https://www.googleapis.com/auth/gmail.compose"],
  send: ["https://www.googleapis.com/auth/gmail.send"],
};
/** The scopes to ask Google for: the base and those of the grants, in a stable order. */
export function scopesFor(grants: readonly GmailGrant[]): string[] {
  const out = [...BASE_SCOPES];
  for (const g of GRANTS) if (grants.includes(g)) for (const s of GRANT_SCOPES[g]) if (!out.includes(s)) out.push(s);
  return out;
}
/** The grants a set of granted scopes covers entirely (gmail.modify covers reading too). */
export function grantsCoveredBy(scopes: readonly string[]): GmailGrant[] {
  const has = (s: string) => scopes.includes(s) || (s.endsWith("gmail.readonly") && scopes.includes("https://www.googleapis.com/auth/gmail.modify")) || scopes.includes("https://mail.google.com/");
  return GRANTS.filter((g) => GRANT_SCOPES[g].every(has));
}
/** The scopes the grants need that the account was not granted. */
export function missingScopes(grants: readonly GmailGrant[], scopes: readonly string[]): string[] {
  const covered = grantsCoveredBy(scopes);
  return grants.filter((g) => !covered.includes(g)).flatMap((g) => GRANT_SCOPES[g]);
}

export interface GmailOp {
  name: string;
  method: "GET" | "POST" | "DELETE";
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
];

export const opNamed = (name: unknown): GmailOp | undefined => (typeof name === "string" ? OPS.find((o) => o.name === name) : undefined);
export const opNames = (): string[] => OPS.map((o) => o.name);
/** The table as the API sees it (no secrets in it, but the tools need not know the paths). */
export const opsPublic = () => OPS.map(({ name, kind, grant }) => ({ name, kind, grant }));
