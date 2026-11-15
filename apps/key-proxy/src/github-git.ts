/**
 * Git traffic to GitHub (fetch, pull, push, clone and Git LFS), for the git tools.
 *
 * Git on this computer is pointed at /githubgit/<owner>/<repo>.git for one command; this
 * forwards the request to github.com and adds the GitHub token from the key store, so the
 * process that runs Git never holds it. Git over HTTPS takes the token as a password
 * (Basic), not as a Bearer header like the REST API does.
 *
 * Only the addresses Git itself asks for are forwarded: a repository's references, its
 * upload and receive services, and the Git LFS API. Anything else is refused, so this is
 * not a way to reach the rest of github.com with the token.
 *
 * A pushed pack can be far larger than a model request, so a body with no declared length
 * (Git sends big packs in chunks) is passed on as it arrives instead of being held whole.
 *
 * GITHUB_GIT_BASE points it at a stand-in (tests).
 */
import type http from "node:http";
import { Readable } from "node:stream";

const gitBase = () => (process.env.GITHUB_GIT_BASE || "https://github.com").replace(/\/$/, "");

// /<owner>/<repo>[.git]/ followed by one of the things Git or Git LFS asks for.
const REPO = "/[\\w.-]+/[\\w.-]+";
const ALLOWED: { method: string; re: RegExp }[] = [
  { method: "GET", re: new RegExp(`^${REPO}/info/refs\\?service=git-(upload|receive)-pack$`) },
  { method: "POST", re: new RegExp(`^${REPO}/git-(upload|receive)-pack$`) },
  { method: "POST", re: new RegExp(`^${REPO}/info/lfs/objects/batch$`) },
  { method: "GET", re: new RegExp(`^${REPO}/info/lfs/locks(\\?[\\w=&%.~-]*)?$`) },
  { method: "POST", re: new RegExp(`^${REPO}/info/lfs/locks(/verify|/[\\w-]+/unlock)?$`) },
];

/** Whether a request is one Git (or Git LFS) makes to a repository. */
export function isGitRequest(method: string | undefined, rest: string): boolean {
  if (rest.includes("..")) return false;
  return ALLOWED.some((a) => a.method === method && a.re.test(rest));
}

// A small request is sent with its length (the LFS API and Git's own short requests);
// anything bigger, or of unknown length, is streamed.
const BUFFER_UP_TO = 8 * 1024 * 1024;

const STRIP_REQUEST = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding",
  "authorization", "proxy-authorization", "expect",
]);
const STRIP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Forwards one Git request to GitHub with the token. `rest` is the path after /githubgit. */
export async function proxyGit(req: http.IncomingMessage, res: http.ServerResponse, rest: string, token: string): Promise<void> {
  if (!isGitRequest(req.method, rest)) return sendJson(res, 404, { error: "Not a Git address" });
  // Reading a public repository needs no token; a push without one cannot work.
  if (!token && /git-receive-pack/.test(rest)) return sendJson(res, 401, { error: "No API key stored for 'github'. Add it in HydraOps Config." });

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string" && !STRIP_REQUEST.has(name.toLowerCase())) headers[name] = value;
  }
  if (token) headers["authorization"] = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  // The client going away (a cancelled clone) stops the request to GitHub too.
  const gone = new AbortController();
  res.on("close", () => { if (!res.writableEnded) gone.abort(); });

  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: gone.signal };
  if (req.method === "POST") {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared <= BUFFER_UP_TO) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      init.body = Buffer.concat(chunks);
    } else {
      init.body = Readable.toWeb(req) as any;
      init.duplex = "half";
    }
  }

  const upstream = await fetch(gitBase() + rest, init);
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!STRIP_RESPONSE.has(name.toLowerCase())) out[name] = value;
  });
  if (!token) out["x-hydra-no-key"] = "1";
  res.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(res);
  else res.end();
}
