/**
 * Talking to MediaMTX's control API: who is publishing, and ending a publish
 * (Nov 12, 2026; external streams step 3, "cut the feed",
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.6).
 *
 * Why it exists: MediaMTX asks our publish check only when a stream STARTS. A
 * partner's encoder that connected while its key was good keeps its connection
 * after the key is replaced, switched off or past its period. With our own
 * Zoom we tell Zoom to stop; a partner's platform is not ours to tell. The
 * only way to end that stream is to disconnect it here.
 *
 * How it is reached:
 *  - MEDIAMTX_API_URL: the API's address inside the box's container network
 *    (http://ea-sys-mediamtx:9997). The port is never published on the box.
 *  - MEDIAMTX_API_SECRET: sent as the HTTP Basic password, user "ea-sys".
 *    MediaMTX has no password of its own here: with `authMethod: http` it asks
 *    OUR webhook whether an API call is allowed (action "api"), and the
 *    webhook compares the password it is shown with this secret. So a call
 *    without the secret is refused by our own code, whoever makes it.
 *
 * Both unset (local development, a box not yet set up): every function answers
 * NOT_CONFIGURED and nothing is attempted.
 *
 * NOT VERIFIED AGAINST A RUNNING SERVER when written (the shapes are from
 * MediaMTX 1.17.1's published OpenAPI file). So it is written to fail safe:
 * an answer it does not understand is BAD_ANSWER, never "nobody is
 * publishing", and it only ever disconnects a connection whose path it
 * matched exactly. docs/LIVE_STREAMING.md §11b has the owner's check.
 *
 * Errors are values. Never logs a stream key or the secret.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { apiLogger } from "@/lib/logger";

export const MEDIAMTX_API_USER = "ea-sys";
const REQUEST_TIMEOUT_MS = 3000;
const PAGE_SIZE = 100;
/** 1,000 connections: far above anything one box carries, and a bound on a misbehaving answer. */
const MAX_PAGES = 10;

export type ControlFailure = "NOT_CONFIGURED" | "UNREACHABLE" | "REFUSED" | "BAD_ANSWER";

export interface Publisher {
  id: string;
  /** Which connection list it came from, and so which kick address ends it. */
  family: "rtmpconns" | "rtmpsconns";
  /** The MediaMTX path, e.g. "live/<streamKey>". */
  path: string;
  remoteAddr: string;
  /** When the connection began, or null when MediaMTX's answer did not say in a form we can read. */
  connectedAt: Date | null;
}

export type PublishersResult = { ok: true; publishers: Publisher[] } | { ok: false; code: ControlFailure };
export type DisconnectResult = { ok: true; disconnected: number } | { ok: false; code: ControlFailure; message: string };

export const CONTROL_FAILURE_MESSAGE: Record<ControlFailure, string> = {
  NOT_CONFIGURED: "The stream server's control address is not set up on this server.",
  UNREACHABLE: "The stream server did not answer.",
  REFUSED: "The stream server refused the request.",
  BAD_ANSWER: "The stream server's answer could not be read.",
};

/**
 * The webhook that checks the secret is a public address, so the secret must
 * be long enough that guessing it there is hopeless. A shorter one counts as
 * not set: nothing is called and no caller is accepted.
 */
export const MEDIAMTX_API_SECRET_MIN_LENGTH = 32;

function controlSecret(): string | null {
  const secret = process.env.MEDIAMTX_API_SECRET;
  return secret && secret.length >= MEDIAMTX_API_SECRET_MIN_LENGTH ? secret : null;
}

function config(): { base: string; secret: string } | null {
  const base = process.env.MEDIAMTX_API_URL;
  const secret = controlSecret();
  return base && secret ? { base: base.replace(/\/+$/, ""), secret } : null;
}

/** Whether the control API can be used at all: a partner's key is not issued until it can. */
export function isMediamtxControlConfigured(): boolean {
  return config() !== null;
}

/**
 * The webhook's question: is this API call ours? Compared as digests, so the
 * comparison takes the same time whatever the length of what was presented.
 */
export function isValidControlCaller(user: string | undefined | null, password: string | undefined | null): boolean {
  const secret = controlSecret();
  if (!secret || !password || user !== MEDIAMTX_API_USER) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(secret), digest(password));
}

async function call(
  path: string,
  method: "GET" | "POST",
  what: "list" | "kick",
): Promise<{ status: number; json: unknown } | ControlFailure> {
  const cfg = config();
  if (!cfg) return "NOT_CONFIGURED";
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${MEDIAMTX_API_USER}:${cfg.secret}`).toString("base64")}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    apiLogger.warn(
      { code: (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name, what },
      "mediamtx-control:unreachable",
    );
    return "UNREACHABLE";
  }
}

interface RawConn {
  id?: unknown;
  state?: unknown;
  path?: unknown;
  remoteAddr?: unknown;
  created?: unknown;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readPage(json: unknown): { pageCount: number; items: RawConn[] } | null {
  if (!json || typeof json !== "object") return null;
  const page = json as { pageCount?: unknown; items?: unknown };
  if (typeof page.pageCount !== "number" || !Array.isArray(page.items)) return null;
  return { pageCount: page.pageCount, items: page.items as RawConn[] };
}

function toPublisher(conn: RawConn, family: Publisher["family"]): Publisher | null {
  if (conn.state !== "publish" || typeof conn.id !== "string" || typeof conn.path !== "string") return null;
  return {
    id: conn.id,
    family,
    path: conn.path,
    remoteAddr: typeof conn.remoteAddr === "string" ? conn.remoteAddr : "",
    connectedAt: readDate(conn.created),
  };
}

/** One page of a connection list: its publishers and how many pages there are, or why not. */
async function listPage(
  family: Publisher["family"],
  page: number,
): Promise<{ ok: true; publishers: Publisher[]; pageCount: number } | { ok: false; code: ControlFailure }> {
  const answer = await call(`/v3/${family}/list?itemsPerPage=${PAGE_SIZE}&page=${page}`, "GET", "list");
  if (typeof answer === "string") return { ok: false, code: answer };
  if (answer.status === 401 || answer.status === 403) return { ok: false, code: "REFUSED" };
  const read = answer.status === 200 ? readPage(answer.json) : null;
  if (!read) {
    // The status and the shape, never the content: enough to tell a changed API from a wrong address.
    apiLogger.warn(
      { family, status: answer.status, answer: answer.json === null ? "not JSON" : typeof answer.json },
      "mediamtx-control:list-answer-not-understood",
    );
    return { ok: false, code: "BAD_ANSWER" };
  }
  const publishers = read.items.flatMap((conn) => toPublisher(conn, family) ?? []);
  return { ok: true, publishers, pageCount: read.pageCount };
}

async function listFamily(family: Publisher["family"]): Promise<PublishersResult> {
  const publishers: Publisher[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await listPage(family, page);
    if (!listed.ok) return listed;
    publishers.push(...listed.publishers);
    if (page + 1 >= listed.pageCount) return { ok: true, publishers };
  }
  // More connections than we read (review of a6ec7911): a publisher could be on
  // a page we never saw, and "nobody is publishing" would then be a guess.
  apiLogger.warn({ family, pages: MAX_PAGES }, "mediamtx-control:list-too-long");
  return { ok: false, code: "BAD_ANSWER" };
}

/**
 * Everyone publishing to MediaMTX now, over RTMP and RTMPS. The RTMP list must
 * answer; RTMPS is switched off on our server, so a list that does not answer
 * there is read as "none" and logged, not as a failure.
 */
export async function listPublishers(): Promise<PublishersResult> {
  const rtmp = await listFamily("rtmpconns");
  if (!rtmp.ok) {
    if (rtmp.code !== "NOT_CONFIGURED") apiLogger.warn({ code: rtmp.code }, "mediamtx-control:list-failed");
    return rtmp;
  }
  const rtmps = await listFamily("rtmpsconns");
  if (!rtmps.ok) {
    apiLogger.debug({ code: rtmps.code }, "mediamtx-control:rtmps-list-unavailable");
    return rtmp;
  }
  return { ok: true, publishers: [...rtmp.publishers, ...rtmps.publishers] };
}

function isMediamtxError(json: unknown): boolean {
  return Boolean(json) && typeof json === "object" && typeof (json as { error?: unknown }).error === "string";
}

/** End one publisher's connection. True when MediaMTX did it, or it was already gone. */
export async function kickPublisher(publisher: Publisher): Promise<boolean> {
  const answer = await call(`/v3/${publisher.family}/kick/${encodeURIComponent(publisher.id)}`, "POST", "kick");
  if (typeof answer === "string") return false;
  if (answer.status === 200) return true;
  // 404 WITH MediaMTX's own error body: the connection ended between the list
  // and the kick, which is the outcome wanted. A bare 404 is a different
  // server answering (an address or a version whose API moved), and counting
  // that as done would report a stream as cut while it is still running.
  if (answer.status === 404 && isMediamtxError(answer.json)) return true;
  apiLogger.warn({ status: answer.status }, "mediamtx-control:kick-refused");
  return false;
}

/**
 * Disconnect whoever is publishing on this stream key. `disconnected: 0` means
 * nobody was. The encoder may reconnect at once, so a caller that wants the
 * stream to STAY down switches the key off first.
 */
export async function disconnectPublishers(streamKey: string): Promise<DisconnectResult> {
  const listed = await listPublishers();
  if (!listed.ok) return { ok: false, code: listed.code, message: CONTROL_FAILURE_MESSAGE[listed.code] };
  const mine = listed.publishers.filter((p) => p.path === `live/${streamKey}`);
  let disconnected = 0;
  for (const publisher of mine) {
    if (await kickPublisher(publisher)) disconnected += 1;
  }
  if (disconnected < mine.length) {
    apiLogger.warn({ found: mine.length, disconnected }, "mediamtx-control:disconnect-incomplete");
    return { ok: false, code: "REFUSED", message: "The stream server did not disconnect the stream." };
  }
  if (disconnected > 0) apiLogger.info({ disconnected }, "mediamtx-control:publisher-disconnected");
  return { ok: true, disconnected };
}
