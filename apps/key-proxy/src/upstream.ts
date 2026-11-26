/**
 * The request the proxy makes to a service on behalf of a caller.
 *
 * Two things a plain fetch() gets wrong here:
 *
 * - A model's answer often arrives whole, at the end. Node's fetch gives up when a response
 *   has not started within five minutes, so a long answer was cut here as "Upstream request
 *   failed" while the caller, which has its own clock for a model round (25 minutes at most),
 *   was still waiting. The wait here is longer than that clock: the caller decides.
 * - When the caller hangs up (its clock ran out, the task was cancelled), the request to the
 *   service went on to the end, with nobody to read it and the tokens still billed. It is
 *   now aborted with the caller's connection.
 */
import type http from "node:http";
import { Readable, pipeline } from "node:stream";
import { Agent } from "undici";

const UPSTREAM_WAIT_MS = 26 * 60_000;
let patient: Agent | undefined;

/** fetch for a caller's request: waits as long as a model round may take, stops when the caller is gone. */
export function fetchForCaller(res: http.ServerResponse, url: string, init: RequestInit & { duplex?: string } = {}): Promise<Response> {
  patient ??= new Agent({ headersTimeout: UPSTREAM_WAIT_MS, bodyTimeout: UPSTREAM_WAIT_MS });
  const gone = new AbortController();
  // "close" before the answer was written whole means the caller hung up.
  const onClose = () => { if (!res.writableEnded) gone.abort(new Error("the caller is gone")); };
  if (res.destroyed) onClose(); else res.once("close", onClose);
  // dispatcher is undici's option, not in the DOM types.
  return fetch(url, { ...init, signal: gone.signal, dispatcher: patient } as any);
}

/** True when a failed request failed because the caller left: nothing to report, nobody to answer. */
export const callerGone = (res: http.ServerResponse): boolean => res.destroyed && !res.writableEnded;

/** Sends a service's answer body on to the caller; a stream cut on either side ends the other, quietly. */
export function relayBody(res: http.ServerResponse, upstream: Response): void {
  if (!upstream.body) { res.end(); return; }
  pipeline(Readable.fromWeb(upstream.body as any), res, () => { /* either side ended early: both are closed by pipeline */ });
}
